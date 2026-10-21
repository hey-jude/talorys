import { toolActivitySchema } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { toolDetail } from "../src/services/text";

describe("tool activity details", () => {
  it("formats values as one capped line", () => {
    expect(toolDetail({ url: "https://example.com/" })).toBe('{"url":"https://example.com/"}');
    expect(toolDetail("line one\n\nline two")).toBe("line one line two");
    expect(toolDetail("x".repeat(600))).toHaveLength(500);
    expect(toolDetail(undefined)).toBeUndefined();
    expect(toolDetail("   ")).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toolDetail(circular)).toBe("[object Object]");
  });

  it("stores details only up to 500 characters", () => {
    const base = { id: "1", name: "webfetch", label: "Reading example.com", status: "success" as const };
    expect(toolActivitySchema.safeParse({ ...base, detail: { input: "example.com", output: "page text" } }).success).toBe(true);
    expect(toolActivitySchema.safeParse({ ...base, detail: { output: "a".repeat(501) } }).success).toBe(false);
  });
});
