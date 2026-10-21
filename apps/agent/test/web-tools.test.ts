import { describe, expect, it } from "vitest";
import { ALL_TOOLS, ToolExecutor, type ToolContext } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import { ToolError, type WebAccess } from "../src/tools/registry";
import { webTools } from "../src/tools/web";
import type { Services } from "../src/services/container";

const ctx = (web?: WebAccess, mode: ToolContext["mode"] = "chat"): ToolContext => ({
  services: {} as Services,
  timezone: "UTC",
  mode,
  ...(web ? { web } : {}),
});

const access = (fetcher: typeof fetch, tavilyApiKey?: string): WebAccess => ({ fetch: fetcher, ...(tavilyApiKey ? { tavilyApiKey } : {}) });

const run = (name: string, input: unknown, context: ToolContext) =>
  (webTools.find((t) => t.name === name) as ImmediateTool).execute(input, context);

const fetchReturning = (response: Response, seen: RequestInit[] = []) =>
  (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return response;
  }) as unknown as typeof fetch;

describe("webfetch", () => {
  it("refuses local, private and credential-bearing targets without touching the network", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("should not be reached");
    }) as unknown as typeof fetch;
    const web = access(fetcher);
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/",
      "http://localhost/",
      "http://metadata.google.internal/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fe90::1]/",
      "http://[feb0::1]/",
      "http://[ff02::1]/",
      "file:///etc/passwd",
      "https://user:pass@example.com/",
      "http://example.com:8080/",
    ]) {
      await expect(run("webfetch", { url }, ctx(web))).rejects.toBeInstanceOf(ToolError);
    }
    expect(called).toBe(0);
  });

  it("rejects a redirect that points at a private host", async () => {
    const web = access(fetchReturning(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })));
    await expect(run("webfetch", { url: "https://example.com/" }, ctx(web))).rejects.toThrow("not allowed");
  });

  it("returns visible text only", async () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style><script>secret()</script></head><body><h1>Hello &amp; welcome</h1><p>Body text</p></body></html>";
    const web = access(fetchReturning(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })));
    const result = (await run("webfetch", { url: "https://example.com/" }, ctx(web))) as { text: string; content_type: string };
    expect(result.content_type).toBe("text/html");
    expect(result.text).toContain("Hello & welcome");
    expect(result.text).toContain("Body text");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("color:red");
  });

  it("drops an unclosed script block", async () => {
    const html = "<p>Before</p><script>var secret = 1; <p>After</p>";
    const web = access(fetchReturning(new Response(html, { headers: { "content-type": "text/html" } })));
    const result = (await run("webfetch", { url: "https://example.com/" }, ctx(web))) as { text: string };
    expect(result.text).toBe("Before");
  });

  it("truncates to maxChars", async () => {
    const web = access(fetchReturning(new Response("a".repeat(5000), { headers: { "content-type": "text/plain" } })));
    const result = (await run("webfetch", { url: "https://example.com/", maxChars: 1000 }, ctx(web))) as {
      text: string;
      truncated: boolean;
    };
    expect(result.text).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it("rejects unsupported content types and failed responses", async () => {
    const pdf = access(fetchReturning(new Response("%PDF", { headers: { "content-type": "application/pdf" } })));
    await expect(run("webfetch", { url: "https://example.com/" }, ctx(pdf))).rejects.toThrow("Unsupported content type");
    const missing = access(fetchReturning(new Response("gone", { status: 404 })));
    await expect(run("webfetch", { url: "https://example.com/" }, ctx(missing))).rejects.toThrow("404");
  });

  it("allows more than three different pages in one turn", async () => {
    const web = access((async () => new Response("ok", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch);
    const executor = new ToolExecutor(ALL_TOOLS, ctx(web), { maxToolCalls: 10 });
    for (const url of ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"]) {
      await expect(executor.execute("webfetch", { url })).resolves.toMatchObject({ text: "ok" });
    }
  });

  it("reads RSS and Atom feeds as text", async () => {
    for (const type of ["application/rss+xml", "application/atom+xml"]) {
      const body = '<?xml version="1.0"?><rss><channel><title>News</title><item><title>First</title></item></channel></rss>';
      const web = access(fetchReturning(new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } })));
      const result = (await run("webfetch", { url: "https://example.com/feed" }, ctx(web))) as { content_type: string; text: string };
      expect(result.content_type).toBe(type);
      expect(result.text).toContain("<title>First</title>");
    }
  });
});

describe("websearch", () => {
  it("calls Tavily with the bearer key and normalizes results", async () => {
    const seen: RequestInit[] = [];
    const payload = { results: [{ title: "Example", url: "https://example.com/", content: "x".repeat(600) }, { nope: true }] };
    const web = access(fetchReturning(Response.json(payload), seen), "tvly-test");
    const result = (await run("websearch", { query: "talorys", limit: 3 }, ctx(web))) as {
      results: { title: string; url: string; snippet: string }[];
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.snippet).toHaveLength(500);
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(String(seen[0]!.body)).max_results).toBe(3);
  });

  it("reports a failed search without leaking the key", async () => {
    const web = access(fetchReturning(new Response("nope", { status: 401 })), "tvly-secret");
    await expect(run("websearch", { query: "talorys" }, ctx(web))).rejects.toThrow("Web search failed (401)");
  });
});

describe("availability", () => {
  it("offers web tools whenever access is enabled, including scheduled runs", () => {
    const names = (context: ToolContext) => new ToolExecutor(ALL_TOOLS, context, { maxToolCalls: 10 }).available().map((t) => t.name);
    expect(names(ctx())).not.toContain("webfetch");
    const withoutKey = names(ctx(access(fetch)));
    expect(withoutKey).toContain("webfetch");
    expect(withoutKey).not.toContain("websearch");
    const withKey = names(ctx(access(fetch, "tvly-test")));
    expect(withKey).toEqual(expect.arrayContaining(["webfetch", "websearch"]));
    const scheduled = names(ctx(access(fetch, "tvly-test"), "scheduled"));
    expect(scheduled).toEqual(expect.arrayContaining(["webfetch", "websearch"]));
  });
});
