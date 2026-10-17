import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { SearchData } from "./schemas.ts";

export interface ResultDetails {
  summary: string;
  fullOutputPath?: string;
}

export function searchText(data: SearchData): string {
  if (!data.results.length) return "No results found.";
  return data.results.map((item, index) => {
    const meta = [item.site_name, item.date, `score ${item.rerank_score}`, `authority ${item.authority}`].filter(Boolean).join(" · ");
    return [
      `## ${index + 1}. ${item.title || item.url}`,
      item.url,
      meta,
      item.summary || item.snippet,
      item.content ? `### Page content\n${item.content}` : "",
    ].filter(Boolean).join("\n\n");
  }).join("\n\n");
}

/** Terminal control sequences are data, never executable rendering instructions. */
export function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export async function toolResult<T extends object>(text: string, data: T, summary: string) {
  const truncated = truncateHead(text, { maxBytes: 30 * 1024, maxLines: 400 });
  const details: ResultDetails = { summary };
  let visible = truncated.content;
  if (truncated.truncated) {
    const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-"));
    details.fullOutputPath = join(directory, "output.md");
    await writeFile(details.fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
    visible += `\n\n[Output truncated to 400 lines / 30 KiB. Full output: ${details.fullOutputPath}. Use read with offset/limit to continue.]`;
  }
  return {
    content: [{ type: "text" as const, text: visible }],
    structuredContent: data,
    details,
  };
}
