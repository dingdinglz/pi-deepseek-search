import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeyStore } from "../src/credentials.ts";
import { DeepSeekClient } from "../src/client.ts";
import { registerKeyCommand, SecretInput } from "../src/key-command.ts";

const secret = "sk-test-only-not-a-real-key";
async function withStore(fn: (store: KeyStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-key-test-"));
  try { await fn(new KeyStore(join(directory, "credentials", "key.json"))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("key persists across instances, stays private, can be replaced and cleared", async () => {
  await withStore(async store => {
    assert.equal(await store.read(), undefined);
    await store.save(`  ${secret}  `);
    assert.equal(await new KeyStore(store.path).read(), secret);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(store.path))).mode & 0o777, 0o700);
    await store.save("sk-replacement");
    assert.equal(await store.read(), "sk-replacement");
    await store.clear();
    assert.equal(await store.read(), undefined);
    await store.clear();
  });
});

test("invalid values and corrupt files do not leak secrets or overwrite the key", async () => {
  await withStore(async store => {
    await store.save(secret);
    for (const invalid of ["", "a-random-value", "sk-two words", "sk-two\nlines"]) {
      await assert.rejects(store.save(invalid), /Invalid DeepSeek key/);
      assert.equal(await store.read(), secret);
    }
    await writeFile(store.path, `broken JSON ${secret}`);
    await assert.rejects(store.read(), error => {
      assert.ok(!String(error).includes(secret));
      assert.match(String(error), /\/deepseek-key/);
      return true;
    });
    await store.save(secret);
    assert.equal(await store.read(), secret);
  });
});

test("client ignores environment keys and reads saved changes on every call", async () => {
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "this-must-not-be-used";
  try {
    await assert.rejects(new DeepSeekClient({ fetch: async () => assert.fail("must not request") }).search({ query: "x" }), /\/deepseek-key/);
    await withStore(async store => {
      const sent: string[] = [];
      const api = new DeepSeekClient({ apiKey: () => store.read(), fetch: async (_url, init) => {
        sent.push((init?.headers as Record<string, string>).Authorization);
        return new Response('{"results":[]}');
      } });
      await store.save(secret);
      await api.search({ query: "x" });
      await store.save("sk-replacement");
      await api.search({ query: "x" });
      assert.deepEqual(sent, [`Bearer ${secret}`, "Bearer sk-replacement"]);
      await store.clear();
      await assert.rejects(api.search({ query: "x" }), /\/deepseek-key/);
      assert.equal(sent.length, 2);
    });
  } finally {
    if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = old;
  }
});

test("secret input masks typed and pasted keys, supports editing and cancellation", () => {
  const input = new SecretInput();
  input.handleInput(`\x1b[200~${secret}\x1b[201~`);
  assert.equal(input.getValue(), secret);
  for (const width of [10, 40, 80]) {
    const visible = input.render(width).join("\n");
    assert.ok(!visible.includes(secret));
    assert.ok(!visible.includes("test-only"));
    assert.match(visible, /●/);
  }
  input.handleInput("\x7f");
  assert.equal(input.getValue(), secret.slice(0, -1));
  let cancelled = false;
  input.onEscape = () => { cancelled = true; };
  input.handleInput("\x1b");
  assert.equal(cancelled, true);
  cancelled = false;
  input.handleInput("\x03");
  assert.equal(cancelled, true);
});

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
function command(store: KeyStore) {
  let definition!: Command;
  registerKeyCommand({ registerCommand(name, value) {
    assert.equal(name, "deepseek-key");
    definition = value;
  } } as ExtensionAPI, store);
  return definition;
}

function context(interact: (input: SecretInput) => void, notifications: string[] = []) {
  return {
    mode: "tui", hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => true,
      custom: async (factory: (...args: any[]) => SecretInput) => new Promise(resolve => {
        const input = factory({ requestRender() {} }, {}, {}, resolve);
        interact(input);
      }),
    },
  } as unknown as ExtensionCommandContext;
}

test("slash command opens the real masked input and persists without echoing the key", async () => {
  await withStore(async store => {
    const notifications: string[] = [];
    const ctx = context(input => {
      input.handleInput(`\x1b[200~${secret}\x1b[201~`);
      input.handleInput("\r");
    }, notifications);
    await command(store).handler("", ctx);
    assert.equal(await store.read(), secret);
    assert.match(notifications.join("\n"), /saved/);
    assert.ok(!notifications.join("\n").includes(secret));
    assert.ok((await readFile(store.path, "utf8")).includes(secret));
  });
});

test("cancel, rejected arguments and non-TUI modes leave the saved key unchanged", async () => {
  await withStore(async store => {
    await store.save(secret);
    const cmd = command(store);
    await cmd.handler("", context(input => input.handleInput("\x1b")));
    const noDialog = context(() => assert.fail("should not open dialog"));
    await cmd.handler("sk-do-not-accept-arguments", noDialog);
    for (const mode of ["print", "json", "rpc"] as const) {
      await cmd.handler("", { ...noDialog, mode });
    }
    assert.equal(await store.read(), secret);
    const notifications: string[] = [];
    await cmd.handler("", context(input => {
      input.handleInput("invalid-value");
      input.handleInput("\r");
      input.handleInput("\x1b");
    }, notifications));
    assert.match(notifications.join("\n"), /Invalid key format/);
    assert.equal(await store.read(), secret);
  });
});

test("clear command requires confirmation and removes the saved key", async () => {
  await withStore(async store => {
    await store.save(secret);
    const cmd = command(store);
    const ctx = context(() => assert.fail("should not open input"));
    await cmd.handler("clear", { ...ctx, ui: { ...ctx.ui, confirm: async () => false } });
    assert.equal(await store.read(), secret);
    await cmd.handler("clear", ctx);
    assert.equal(await store.read(), undefined);
  });
});
