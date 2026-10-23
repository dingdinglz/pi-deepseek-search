import assert from "node:assert/strict";
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, ProviderSettingsStore, type ProviderSettings } from "../src/provider-settings.ts";

async function withStore(fn: (store: ProviderSettingsStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-provider-settings-test-"));
  try { await fn(new ProviderSettingsStore(join(directory, "preferences", "settings.json"))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const invalidSettings: unknown[] = [
  null, [], "openai", {}, { provider: "openai" }, { model: "gpt-5.4" },
  { provider: "other", model: "gpt-5.4" }, { provider: "OPENAI", model: "gpt-5.4" },
  ...[undefined, null, 42, "", " ", " gpt-5.4", "gpt-5.4 ", "two words", "two\twords", "two\nlines", "gpt-5.4\n", "gpt-5.4\r", "gpt/5", "$(command)", "模型", "a".repeat(129)]
    .map(model => ({ provider: "openai", model })),
];

test("settings default path is separate from credentials", () => {
  assert.equal(new ProviderSettingsStore().path, join(getAgentDir(), "deepseek-search", "settings.json"));
});

test("missing settings return fresh defaults without creating files", async () => {
  await withStore(async store => {
    assert.deepEqual(DEFAULT_SETTINGS, { provider: "deepseek", model: "auto" });
    const settings = await store.read();
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    settings.provider = "openai";
    settings.model = "changed";
    assert.deepEqual(await store.read(), { provider: "deepseek", model: "auto" });
    await assert.rejects(stat(dirname(store.path)), { code: "ENOENT" });
  });
});

test("settings persist across instances, replace atomically and stay private", async () => {
  await withStore(async store => {
    await store.save({ provider: "openai", model: "gpt-5.4" });
    assert.deepEqual(await new ProviderSettingsStore(store.path).read(), { provider: "openai", model: "gpt-5.4" });
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(store.path))).mode & 0o777, 0o700);
    await chmod(store.path, 0o644);
    await chmod(dirname(store.path), 0o755);
    await store.save({ provider: "deepseek", model: "model_A-1.2:variant" });
    assert.deepEqual(await store.read(), { provider: "deepseek", model: "model_A-1.2:variant" });
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(store.path))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(dirname(store.path)), ["settings.json"]);
    await store.save({ provider: "openai", model: "a".repeat(128) });
    assert.equal((await store.read()).model.length, 128);
  });
});

test("only nonsecret provider and model fields are persisted and returned", async () => {
  await withStore(async store => {
    const extra = { provider: "openai" as const, model: "gpt-5.4", apiKey: "not-a-real-key" };
    await store.save(extra);
    assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), { provider: "openai", model: "gpt-5.4" });
    await writeFile(store.path, JSON.stringify(extra));
    assert.deepEqual(await store.read(), { provider: "openai", model: "gpt-5.4" });
  });
});

test("invalid settings are rejected before writing and leave saved settings unchanged", async () => {
  await withStore(async store => {
    for (const invalid of invalidSettings) {
      await assert.rejects(store.save(invalid as ProviderSettings), /Invalid web provider settings/);
    }
    await assert.rejects(stat(dirname(store.path)), { code: "ENOENT" });
    await store.save({ ...DEFAULT_SETTINGS });
    const original = await readFile(store.path, "utf8");
    for (const invalid of invalidSettings) {
      await assert.rejects(store.save(invalid as ProviderSettings), /Invalid web provider settings/);
      assert.equal(await readFile(store.path, "utf8"), original);
    }
    assert.deepEqual(await readdir(dirname(store.path)), ["settings.json"]);
  });
});

test("malformed settings produce safe actionable errors and are never overwritten", async () => {
  await withStore(async store => {
    await mkdir(dirname(store.path));
    const marker = "private-file-content-must-not-appear";
    const malformed = ["", `broken JSON ${marker}`, ...invalidSettings.map(value => JSON.stringify(value))];
    for (const content of malformed) {
      await writeFile(store.path, content);
      for (const operation of [() => store.read(), () => store.save({ ...DEFAULT_SETTINGS })]) {
        await assert.rejects(operation(), error => {
          assert.ok(!String(error).includes(marker));
          assert.match(String(error), /repair or remove the settings\.json file/);
          return true;
        });
      }
      assert.equal(await readFile(store.path, "utf8"), content);
    }
    assert.deepEqual(await readdir(dirname(store.path)), ["settings.json"]);
  });
});

test("read failures other than missing files do not return defaults", async () => {
  await withStore(async store => {
    await mkdir(store.path, { recursive: true });
    await assert.rejects(store.read(), /Cannot read the saved web provider settings/);
    await assert.rejects(store.save({ ...DEFAULT_SETTINGS }), /Cannot read the saved web provider settings/);
    assert.ok((await stat(store.path)).isDirectory());
  });
});

test("failed atomic replacement removes the temporary file and preserves saved settings", async t => {
  await withStore(async store => {
    await store.save({ ...DEFAULT_SETTINGS });
    const original = await readFile(store.path, "utf8");
    let replacement: { source: string; destination: string; mode: number; data: unknown; previous: string } | undefined;
    const renameMock = t.mock.method(fs, "rename", async (source: string, destination: string) => {
      replacement = {
        source, destination,
        mode: (await stat(source)).mode & 0o777,
        data: JSON.parse(await readFile(source, "utf8")),
        previous: await readFile(store.path, "utf8"),
      };
      throw new Error("simulated rename failure");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.save({ provider: "openai", model: "gpt-5.4" }), /Cannot save.*Check permissions/);
    } finally {
      renameMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(replacement);
    assert.equal(replacement.destination, store.path);
    assert.equal(dirname(replacement.source), dirname(store.path));
    assert.match(replacement.source, /\.settings-[0-9a-f-]{36}\.tmp$/);
    assert.equal(replacement.mode, 0o600);
    assert.deepEqual(replacement.data, { provider: "openai", model: "gpt-5.4" });
    assert.equal(replacement.previous, original);
    assert.equal(await readFile(store.path, "utf8"), original);
    assert.deepEqual(await readdir(dirname(store.path)), ["settings.json"]);
  });
});
