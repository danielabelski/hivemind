import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the subprocess boundary so the test never shells out to a real CLI.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { makeClaudeGenerate, unwrapModelOutput } from "../../src/docs/refresh-llm.js";
import type { RefreshContext } from "../../src/docs/index.js";

const ctx: RefreshContext = {
  doc: {
    id: "r", doc_id: "a.ts", path: "/docs/p/a.ts.md", content: "old doc",
    anchors: [], tier: "fast", status: "active", project: "p", version: 1,
    created_at: "t", updated_at: "t", agent: "m", plugin_version: "0",
  },
  reasons: [{ kind: "code_changed", symbol_id: "a.ts:foo:function" }],
  changedSymbols: [{ symbol_id: "a.ts:foo:function", signature: "function foo(): number", source: "function foo() { return 42; }" }],
};

beforeEach(() => execFileSyncMock.mockReset());

describe("makeClaudeGenerate", () => {
  it("returns the model's stdout, trimmed", async () => {
    execFileSyncMock.mockReturnValue("  # Updated doc\nbody\n\n");
    const gen = makeClaudeGenerate("/usr/bin/claude");
    const out = await gen(ctx);
    expect(out).toBe("# Updated doc\nbody");
  });

  it("passes the refresh prompt to the claude binary", async () => {
    execFileSyncMock.mockReturnValue("x");
    const gen = makeClaudeGenerate("/usr/bin/claude");
    await gen(ctx);
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    const [file, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("/usr/bin/claude");
    // On unix buildClaudeInvocation puts the prompt as a positional arg; it must
    // carry the changed symbol source so the model can update the doc.
    const joined = args.join(" ");
    expect(joined).toContain("function foo() { return 42; }");
    expect(joined).toContain("SMALLEST edit");
  });

  it("tolerates empty/undefined stdout", async () => {
    execFileSyncMock.mockReturnValue(undefined);
    const gen = makeClaudeGenerate("/usr/bin/claude");
    expect(await gen(ctx)).toBe("");
  });

  it("unwraps an outer code fence the model may add around the whole body", async () => {
    execFileSyncMock.mockReturnValue("```markdown\n# Doc\nbody\n```");
    const gen = makeClaudeGenerate("/usr/bin/claude");
    expect(await gen(ctx)).toBe("# Doc\nbody");
  });
});

describe("unwrapModelOutput", () => {
  it("strips a single outer fence with a language tag", () => {
    expect(unwrapModelOutput("```md\nhello\nworld\n```")).toBe("hello\nworld");
  });
  it("strips a bare outer fence", () => {
    expect(unwrapModelOutput("```\nhello\n```")).toBe("hello");
  });
  it("leaves un-fenced content (just trims)", () => {
    expect(unwrapModelOutput("  # Title\nbody  ")).toBe("# Title\nbody");
  });
  it("does NOT strip inner/partial fences in normal markdown", () => {
    const md = "# Doc\n\n```ts\nconst x = 1;\n```\n\nmore";
    expect(unwrapModelOutput(md)).toBe(md);
  });
});
