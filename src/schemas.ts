import { Type, type Static } from "typebox";

export const SearchParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 128, description: "Search query (1–128 Unicode characters). Supports site:, -site:, exact phrases, lang:, after:, before:." }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Maximum results (default 10)." })),
  need_content: Type.Optional(Type.Boolean({ default: false, description: "Include full page text when available; normally use summaries and fetch selected URLs." })),
  ori_question: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()], { description: "Original user question to clarify search intent (optional)." })),
  localization: Type.Optional(Type.String({ description: "IP address to prioritize local results (optional)." })),
});

export const FetchParams = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 8192, description: "HTTP(S) page URL, without username or password." }),
});

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const SearchResponse = Type.Object({
  results: Type.Array(Type.Object({
    title: Type.String(),
    url: Type.String(),
    snippet: Type.String(),
    summary: Type.String(),
    content: Type.String(),
    date: nullableString,
    site_name: nullableString,
    site_icon: nullableString,
    rerank_score: Type.Number(),
    authority: Type.Integer(),
  })),
});

export const FetchResponse = Type.Object({
  title: Type.String(),
  content: Type.String(),
});

export type SearchInput = Static<typeof SearchParams>;
export type FetchInput = Static<typeof FetchParams>;
export type SearchData = Static<typeof SearchResponse>;
export type FetchData = Static<typeof FetchResponse>;
