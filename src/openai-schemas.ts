import { Type, type Static } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";
import { FetchParams } from "./schemas.ts";

const responseLength = Type.Optional(Type.Union([
  Type.Literal("short"), Type.Literal("medium"), Type.Literal("long"),
], { default: "long", description: "Size of the service's returned excerpt, not a guarantee of complete content." }));

export const OpenAISearchParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4000, description: "Web search query (1–4000 Unicode characters). Cannot be blank." }),
  recency: Type.Optional(Type.Integer({ minimum: 1, description: "Restrict to this many recent days." })),
  domains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Restrict the search to these domains." })),
  response_length: responseLength,
});

export const OpenAIFetchParams = Type.Object({
  ...FetchParams.properties,
  lineno: Type.Optional(Type.Integer({ minimum: 0, description: "Line at which to position the page excerpt (default 0); use to continue reading." })),
  response_length: responseLength,
});

/** Values come only from response.json(); keep the wire DTOs opaque but JSON-compatible. */
const opaqueResult = Type.Unsafe<JsonValue>({});
/** Codex intentionally keeps result DTOs opaque to preserve future result variants. */
export const OpenAIWireResponse = Type.Object({
  output: Type.String(),
  results: Type.Optional(Type.Union([Type.Array(opaqueResult), Type.Null()])),
});
export const OpenAIResponse = Type.Object({
  provider: Type.Literal("openai"),
  model: Type.String(),
  output: Type.String({ description: "Direct Codex web tool output. May be an excerpt, not complete page Markdown." }),
  results: Type.Optional(Type.Array(opaqueResult, { description: "Opaque server result DTOs, when supplied; not normalized DeepSeek rankings." })),
});
export type OpenAISearchInput = Static<typeof OpenAISearchParams>;
export type OpenAIFetchInput = Static<typeof OpenAIFetchParams>;
export type OpenAIData = Static<typeof OpenAIResponse>;
