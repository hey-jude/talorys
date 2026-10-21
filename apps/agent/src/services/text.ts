/**
 * Cuts `text` to at most `max` UTF-16 code units without splitting a surrogate pair,
 * so an emoji at the cut never leaves a lone surrogate (shown as "�") in a stored title or name.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** One-line, length-capped form of a tool input or output for the owner's expandable chip. */
export function toolDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const clean = text.replace(/\s+/g, " ").trim();
  return clean ? clip(clean, 500) : undefined;
}
