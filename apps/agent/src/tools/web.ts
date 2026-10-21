import { z } from "zod";
import { defineTool, ToolError, type ToolContext, type WebAccess } from "./registry";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "text/rss+xml",
  "text/atom+xml",
]);

function web(ctx: ToolContext): WebAccess {
  if (!ctx.web) throw new ToolError("Web access is off.");
  return ctx.web;
}

/** Rejects anything that could reach the Worker's own network or local services. */
function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host === "metadata.google.internal" || host === "metadata.goog") return true;
  return host.includes(":") ? isBlockedIpv6(host) : isBlockedIpv4(host);
}

function isBlockedIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isBlockedIpv6(host: string): boolean {
  // ::, ::1 and IPv4-mapped forms; plus fc00::/7, fe80::/10 (link-local) and ff00::/8 (multicast).
  if (host.startsWith("::")) return true;
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf) || first >= 0xff00;
}

function checkedUrl(raw: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new ToolError("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("Only http and https URLs can be fetched.");
  }
  if (url.username || url.password) throw new ToolError("URLs with credentials are not allowed.");
  if (url.port) throw new ToolError("Only the default HTTP/HTTPS port is allowed.");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isBlockedHostname(host)) throw new ToolError("That host is not allowed.");
  url.hash = "";
  return url;
}

async function fetchFollowing(url: URL, fetcher: typeof fetch): Promise<{ res: Response; finalUrl: URL }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetcher(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {
      throw new ToolError("Could not reach that page.");
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new ToolError(`Fetch failed (${res.status}).`);
      if (hop === MAX_REDIRECTS) throw new ToolError("Too many redirects.");
      current = checkedUrl(location, current.toString());
      continue;
    }
    if (!res.ok) throw new ToolError(`Fetch failed (${res.status}).`);
    return { res, finalUrl: current };
  }
  throw new ToolError("Too many redirects.");
}

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BYTES) {
      chunks.push(value.subarray(0, MAX_BYTES - size));
      size = MAX_BYTES;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

function decodeEntity(entity: string, code: string): string {
  const key = code.toLowerCase();
  if (ENTITIES[key]) return ENTITIES[key]!;
  const hex = key.startsWith("#x");
  const value = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
  return key.startsWith("#") && Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
}

/** Visible text only; script/style/template contents never reach the model. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const webTools = [
  defineTool({
    name: "webfetch",
    description:
      "Read the visible text of a web page. Use for a specific URL the owner mentioned or a websearch result. Returns untrusted page text, truncated.",
    permission: "read",
    requiresWeb: true,
    // No per-tool cap: the turn's tool budget (Settings → AI) governs, and duplicate-call
    // detection still stops the model from fetching the same URL twice in one turn.
    input: z.object({
      url: z.string().min(1).max(2000),
      maxChars: z.number().int().min(500).max(20000).optional(),
    }),
    label: (i) => {
      try {
        return `Reading ${new URL(i.url).hostname}`;
      } catch {
        return "Reading a web page";
      }
    },
    execute: async (i, ctx) => {
      const access = web(ctx);
      const url = checkedUrl(i.url);
      const { res, finalUrl } = await fetchFollowing(url, access.fetch);
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!ALLOWED_TYPES.has(type)) throw new ToolError(`Unsupported content type "${type || "unknown"}".`);
      const { text: raw, truncated: bytesTruncated } = await readCapped(res);
      const full = type === "text/html" || type === "application/xhtml+xml" ? htmlToText(raw) : normalize(raw);
      const limit = i.maxChars ?? 8000;
      return {
        url: i.url,
        final_url: finalUrl.toString(),
        content_type: type || "unknown",
        text: full.slice(0, limit),
        truncated: bytesTruncated || full.length > limit,
      };
    },
  }),
  defineTool({
    name: "websearch",
    description: "Search the web and return titles, URLs and snippets. Use webfetch to read a result in full.",
    permission: "read",
    requiresWeb: true,
    available: (ctx) => !!ctx.web?.tavilyApiKey,
    maxCallsPerTurn: 2,
    input: z.object({
      query: z.string().min(1).max(400),
      limit: z.number().int().min(1).max(8).optional(),
    }),
    label: (i) => `Searching the web for “${i.query}”`,
    execute: async (i, ctx) => {
      const access = web(ctx);
      const res = await access
        .fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${access.tavilyApiKey}` },
          body: JSON.stringify({
            query: i.query,
            max_results: i.limit ?? 5,
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
            include_images: false,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        .catch(() => {
          throw new ToolError("Web search is unavailable right now.");
        });
      if (!res.ok) throw new ToolError(`Web search failed (${res.status}).`);
      const body = (await res.json().catch(() => null)) as { results?: unknown } | null;
      if (!body || !Array.isArray(body.results)) throw new ToolError("Web search returned an invalid response.");
      return {
        query: i.query,
        results: body.results.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as { title?: unknown; url?: unknown; content?: unknown };
          if (typeof item.url !== "string") return [];
          return [
            {
              title: typeof item.title === "string" ? item.title : item.url,
              url: item.url,
              snippet: typeof item.content === "string" ? item.content.slice(0, 500) : "",
            },
          ];
        }),
      };
    },
  }),
];
