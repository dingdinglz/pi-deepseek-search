import { randomUUID } from "node:crypto";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { OpenAIFetchParams, OpenAISearchParams, OpenAIWireResponse, type OpenAIData, type OpenAIFetchInput, type OpenAISearchInput } from "./openai-schemas.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
type Registry = Pick<ExtensionToolContext["modelRegistry"], "find" | "getAll" | "getApiKeyAndHeaders">;
export interface OpenAIClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** The same account claim used by Pi's Codex Responses adapter; not JWT verification. */
function accountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
  } catch { return; }
}

/** Direct Codex alpha/search API. Pi owns credential storage and OAuth refresh. */
export class OpenAIClient {
  constructor(private readonly registry: Registry, private readonly modelId: string, private readonly options: OpenAIClientOptions = {}) {}

  search(input: OpenAISearchInput, signal?: AbortSignal) {
    if (!Value.Check(OpenAISearchParams, input) || !input.query.trim() || Array.from(input.query).length > 4000) {
      throw new Error("Invalid OpenAI search parameters: provide a query of 1–4000 Unicode characters and valid recency/domains/response_length.");
    }
    const { query: q, recency, domains, response_length = "long" } = input;
    return this.request({ search_query: [{ q, recency, domains }], response_length }, signal);
  }

  fetchPage(input: OpenAIFetchInput, signal?: AbortSignal) {
    if (!Value.Check(OpenAIFetchParams, input) || !validUrl(input.url)) {
      throw new Error("Invalid fetch parameters: use HTTP(S) with a host, at most 8192 characters, no username/password, and a nonnegative lineno.");
    }
    return this.request({ open: [{ ref_id: input.url, lineno: input.lineno ?? 0 }], response_length: input.response_length ?? "long" }, signal);
  }

  private async request(commands: object, callerSignal?: AbortSignal): Promise<OpenAIData> {
    callerSignal?.throwIfAborted();
    const model = this.modelId === "auto"
      ? this.registry.getAll().find(candidate => candidate.provider === "openai-codex" && candidate.api === "openai-codex-responses")
      : this.registry.find("openai-codex", this.modelId);
    if (!model || model.api !== "openai-codex-responses") {
      throw new Error(`Codex model '${this.modelId}' is unavailable. Choose an openai-codex model with /web-provider openai <model>.`);
    }
    // Resolve via the host, never read/copy auth.json or persist a token in plugin settings.
    let auth: Awaited<ReturnType<Registry["getApiKeyAndHeaders"]>>;
    try { auth = await this.registry.getApiKeyAndHeaders(model); }
    catch { throw new Error("Cannot resolve Codex credentials. Run /login and choose openai-codex."); }
    callerSignal?.throwIfAborted();
    if (!auth.ok || !auth.apiKey) throw new Error("Run /login and choose openai-codex before using OpenAI web tools.");
    const token = auth.apiKey;
    const account = accountId(token);
    if (!account) throw new Error("OpenAI web tools require Pi's Codex OAuth login, not an OpenAI API key. Run /login and choose openai-codex.");
    // This alpha route is official-origin only; never send OAuth tokens to arbitrary tool input URLs.
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
    const fetch = this.options.fetch ?? globalThis.fetch;
    try {
      signal.throwIfAborted();
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": account,
          originator: "pi",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: randomUUID(), model: model.id, commands,
          settings: { external_web_access: true, allowed_callers: ["direct"] },
          max_output_tokens: 6000,
        }),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        // Never echo an arbitrary upstream error body (it may reflect request credentials).
        await response.body?.cancel();
        throw new Error(this.httpError(response.status));
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new Error("OpenAI Codex search returned invalid JSON."); }
      signal.throwIfAborted();
      if (!Value.Check(OpenAIWireResponse, data)) throw new Error("OpenAI Codex search returned an unexpected response schema.");
      return {
        provider: "openai", model: model.id, output: data.output,
        ...(Array.isArray(data.results) ? { results: data.results } : {}),
      };
    } catch (error) {
      if (callerSignal?.aborted) throw new Error("OpenAI web request cancelled.");
      if (timeout.signal.aborted) throw new Error(`OpenAI web request timed out after ${timeoutMs / 1000}s.`);
      // Only our known errors are safe; network exceptions can include authorization headers.
      if (error instanceof Error && /^(OpenAI Codex (search returned|HTTP))/.test(error.message)) {
        throw new Error(error.message.split(token).join("[REDACTED]").split(account).join("[REDACTED]"));
      }
      throw new Error("OpenAI web request failed due to a network or transport error. No automatic retry was made.");
    } finally { clearTimeout(timer); }
  }

  private httpError(status: number): string {
    const hints: Record<number, string> = {
      400: "The alpha API rejected the request; its protocol or model support may have changed.",
      401: "Run /login and choose openai-codex to renew your credentials.",
      402: "Check your Codex account plan or quota.",
      403: "This account may not have access to the Codex alpha search endpoint.",
      404: "The Codex alpha search endpoint is unavailable for this account or server version.",
      429: "Rate limit reached; retry later.",
    };
    return `OpenAI Codex HTTP ${status}. ${hints[status] ?? "The alpha search service is unavailable; retry later."} No automatic provider fallback was made.`;
  }
}
