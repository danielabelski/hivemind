import { describe, it, expect } from "vitest";
import {
  stampOffset,
  parseOffset,
  capLinesByBytes,
  newRowsFromWindow,
  WIKI_JSONL_MAX_BYTES,
} from "../../src/hooks/wiki-offset.js";

describe("stampOffset", () => {
  it("replaces an existing offset line, preserving the bullet, and round-trips via parseOffset", () => {
    const summary = "# Session x\n- **Project**: p\n- **JSONL offset**: 7\n\n## What Happened\nstuff";
    const out = stampOffset(summary, 42);
    expect(out).toContain("- **JSONL offset**: 42");
    expect(out).not.toContain("offset**: 7");
    expect(parseOffset(out)).toBe(42);
  });

  it("inserts an offset line after the title when none exists", () => {
    const summary = "# Session x\n\n## What Happened\nstuff";
    const out = stampOffset(summary, 5);
    expect(parseOffset(out)).toBe(5);
    // inserted right after the first line, not appended at the end
    expect(out.split("\n")[1]).toBe("- **JSONL offset**: 5");
  });

  it("does not depend on the LLM's exact formatting — a reformatted bullet is still overwritten", () => {
    // LLM wrote it as a bold line without a bullet; stamping still normalizes it.
    const summary = "# S\n**JSONL offset**:   999\ntail";
    expect(parseOffset(stampOffset(summary, 3))).toBe(3);
  });
});

describe("capLinesByBytes", () => {
  it("keeps the NEWEST lines (tail), not the oldest, and reports the drop count", () => {
    const lines = ["oldest", "mid", "newest"];
    // budget fits only the last two ("mid\nnewest" = 3+1+6 = 10 bytes)
    const { kept, dropped } = capLinesByBytes(lines, 10);
    expect(kept).toEqual(["mid", "newest"]);
    expect(dropped).toBe(1);
  });

  it("keeps everything when under budget (no drop)", () => {
    const lines = ["a", "b", "c"];
    const { kept, dropped } = capLinesByBytes(lines, WIKI_JSONL_MAX_BYTES);
    expect(kept).toEqual(lines);
    expect(dropped).toBe(0);
  });

  it("keeps only the last line but truncates it when it alone exceeds the budget", () => {
    const lines = ["x", "y".repeat(100)];
    const { kept, dropped, truncated } = capLinesByBytes(lines, 10);
    expect(dropped).toBe(1);
    expect(truncated).toBe(true);
    expect(kept).toHaveLength(1);
    expect(Buffer.byteLength(kept[0], "utf8")).toBeLessThanOrEqual(10);
  });

  it("handles an empty input", () => {
    expect(capLinesByBytes([], 10)).toEqual({ kept: [], dropped: 0, truncated: false });
  });

  it("truncates a lone oversized line so the output stays within the budget", () => {
    const line = "z".repeat(100);
    const { kept, dropped, truncated } = capLinesByBytes([line], 10);
    expect(dropped).toBe(0);
    expect(truncated).toBe(true);
    expect(kept).toHaveLength(1);
    expect(Buffer.byteLength(kept[0], "utf8")).toBeLessThanOrEqual(10);
  });

  it("does not report truncation when the retained line fits", () => {
    const { truncated } = capLinesByBytes(["ok"], 10);
    expect(truncated).toBe(false);
  });
});

describe("newRowsFromWindow — bounded-fetch offset math", () => {
  const rows = (n: number, base = 0) => Array.from({ length: n }, (_, i) => base + i);

  it("full window (total == window length) equals a plain slice(prevOffset)", () => {
    const w = rows(10); // whole session fetched (total 10)
    expect(newRowsFromWindow(w, 10, 3)).toEqual(w.slice(3));
    expect(newRowsFromWindow(w, 10, 0)).toEqual(w);
    expect(newRowsFromWindow(w, 10, 10)).toEqual([]); // nothing new
  });

  it("bounded window: returns the last (total - prevOffset) rows", () => {
    // session has 5000 rows; we fetched the newest 2000; 4990 already summarized.
    const w = rows(2000, 3000); // rows 3000..4999 (the newest 2000)
    const out = newRowsFromWindow(w, 5000, 4990); // 10 new rows
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(4990);
    expect(out[9]).toBe(4999);
  });

  it("new rows exceed the window → returns the whole window (older-new fell outside the fetch)", () => {
    // 5000-row session, newest 2000 fetched, but only 1000 summarized → 4000 'new',
    // more than the 2000-row window. The 2000 older-new rows are outside the fetch —
    // exactly the ones capLinesByBytes would drop; we summarize the newest 2000.
    const w = rows(2000, 3000);
    expect(newRowsFromWindow(w, 5000, 1000)).toEqual(w);
  });

  it("prevOffset 0 (regenerate) returns the whole window", () => {
    const w = rows(2000, 3000);
    expect(newRowsFromWindow(w, 5000, 0)).toEqual(w);
  });

  it("returns a copy, never the input array", () => {
    const w = rows(3);
    const out = newRowsFromWindow(w, 3, 0);
    expect(out).toEqual(w);
    expect(out).not.toBe(w);
  });
});
