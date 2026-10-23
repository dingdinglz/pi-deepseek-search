import { Type } from "typebox";
import { FetchParams, FetchResponse, SearchParams, SearchResponse } from "./schemas.ts";
import { OpenAIFetchParams, OpenAISearchParams, OpenAIWireResponse } from "./openai-schemas.ts";
import type { WebProvider } from "./provider-settings.ts";

// Only the selected backend's capabilities are exposed; wire metadata stays internal.
export const WebTextResponse = Type.Object({
  output: Type.String({ description: "Retrieved web content. May be an excerpt rather than complete page Markdown." }),
  results: OpenAIWireResponse.properties.results,
});

export function webSchemas(provider: WebProvider) {
  const search = provider === "deepseek" ? SearchParams : OpenAISearchParams;
  const fetch = provider === "deepseek" ? FetchParams : OpenAIFetchParams;
  return {
    search: Type.Object(search.properties, { additionalProperties: false }),
    fetch: Type.Object(fetch.properties, { additionalProperties: false }),
    searchResponse: provider === "deepseek" ? SearchResponse : WebTextResponse,
    fetchResponse: provider === "deepseek" ? FetchResponse : WebTextResponse,
  };
}
