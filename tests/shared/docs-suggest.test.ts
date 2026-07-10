import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  docsSuggestNote,
  markSuggested,
  readSuggestedRegistry,
  wasSuggested,
} from "../../src/docs/docs-suggest.js";

describe("docsSuggestNote (SessionStart 'docs not set up' hint)", () => {
  it("fires for a real indexed repo that hasn't opted in and wasn't suggested", () => {
    const note = docsSuggestNote({
      orgId: "org-a",
      project: "proj-1",
      graphPresent: true,
      isAutoEnabledFn: () => false,
      wasSuggestedFn: () => false,
    });
    expect(note).toContain("DOCS (not set up for this repo)");
    expect(note).toContain("hivemind docs sync");
    // Anti prompt-injection: descriptive, ends with an explicit no-op-by-default.
    expect(note).toContain("no action needed unless the user asks");
    expect(note).not.toMatch(/\byou (must|should)\b/i);
    expect(note.startsWith("\n\n")).toBe(true); // appends cleanly after docsNote
  });

  it("returns '' when docs are already enabled (inverse gate of the wiki note)", () => {
    expect(
      docsSuggestNote({
        orgId: "org-a",
        project: "proj-1",
        graphPresent: true,
        isAutoEnabledFn: () => true,
        wasSuggestedFn: () => false,
      }),
    ).toBe("");
  });

  it("returns '' when the suggestion already fired for this (org, project)", () => {
    expect(
      docsSuggestNote({
        orgId: "org-a",
        project: "proj-1",
        graphPresent: true,
        isAutoEnabledFn: () => false,
        wasSuggestedFn: () => true,
      }),
    ).toBe("");
  });

  it("returns '' when this is not an indexed code repo (no local graph)", () => {
    let asked = false;
    const note = docsSuggestNote({
      orgId: "org-a",
      project: "proj-1",
      graphPresent: false,
      isAutoEnabledFn: () => { asked = true; return false; },
      wasSuggestedFn: () => false,
    });
    expect(note).toBe("");
    expect(asked).toBe(false); // graph gate short-circuits before any registry read
  });

  it("fail-closed: a throwing registry read yields '' — never breaks SessionStart", () => {
    expect(
      docsSuggestNote({
        orgId: "org-a",
        project: "proj-1",
        graphPresent: true,
        isAutoEnabledFn: () => { throw new Error("corrupt registry"); },
        wasSuggestedFn: () => false,
      }),
    ).toBe("");
  });
});

describe("suggested registry (dedup persistence)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-suggested-"));
    file = join(dir, "docs-suggested.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("markSuggested then wasSuggested round-trips for the same (org, project)", () => {
    expect(wasSuggested("org-a", "proj-1", file)).toBe(false);
    markSuggested("org-a", "proj-1", "/repo", "2026-07-10T00:00:00.000Z", file);
    expect(wasSuggested("org-a", "proj-1", file)).toBe(true);
    // A different project under the same org is independent.
    expect(wasSuggested("org-a", "proj-2", file)).toBe(false);
  });

  it("markSuggested is idempotent — a repeat updates in place, no duplicate row", () => {
    markSuggested("org-a", "proj-1", "/repo", "2026-07-10T00:00:00.000Z", file);
    markSuggested("org-a", "proj-1", "/repo/again", "2026-07-11T00:00:00.000Z", file);
    const reg = readSuggestedRegistry(file);
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0].path).toBe("/repo/again");
    expect(reg.entries[0].suggestedAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it("a corrupt registry file reads as empty — never throws", () => {
    writeFileSync(file, "{ not json");
    expect(readSuggestedRegistry(file).entries).toEqual([]);
    expect(wasSuggested("org-a", "proj-1", file)).toBe(false);
  });
});
