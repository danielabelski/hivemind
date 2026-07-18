import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { treeSitterSpecs, isGraphDepsInstalled } from "../../src/cli/embeddings.js";

/**
 * The code-graph auto-build hook resolves tree-sitter from the shared
 * embed-deps dir. `ensureGraphDeps` provisions it there; these tests cover its
 * two pure helpers — the version derivation (which must track package.json so
 * embed-deps never drifts from what the bundles were built against) and the
 * presence check. The full install flow is covered by the e2e in the PR.
 */
describe("graph-deps helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "graph-deps-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  describe("treeSitterSpecs", () => {
    it("returns only tree-sitter* optionalDependencies as name@range, sorted, skipping non-parsers", () => {
      const pkg = join(dir, "package.json");
      writeFileSync(pkg, JSON.stringify({
        optionalDependencies: {
          // deliberately unsorted + mixed with a non-parser native dep
          "tree-sitter-typescript": "^0.23.2",
          "@huggingface/transformers": "^3.0.0",
          "tree-sitter": "^0.21.1",
          "tree-sitter-python": "0.23.4",
        },
      }));
      expect(treeSitterSpecs(pkg)).toEqual([
        "tree-sitter@^0.21.1",
        "tree-sitter-python@0.23.4",
        "tree-sitter-typescript@^0.23.2",
      ]);
      // The 600MB transformers dep must NOT be dragged into the graph install.
      expect(treeSitterSpecs(pkg).join(" ")).not.toContain("transformers");
    });

    it("returns [] when the file is missing or has no optionalDependencies", () => {
      expect(treeSitterSpecs(join(dir, "does-not-exist.json"))).toEqual([]);
      const empty = join(dir, "empty.json");
      writeFileSync(empty, JSON.stringify({ dependencies: { foo: "1.0.0" } }));
      expect(treeSitterSpecs(empty)).toEqual([]);
    });

    it("does not match a package merely containing 'tree-sitter' mid-name", () => {
      const pkg = join(dir, "package.json");
      writeFileSync(pkg, JSON.stringify({
        optionalDependencies: { "not-tree-sitter-thing": "1.0.0", "tree-sitter": "^0.21.1" },
      }));
      // Only the real prefix/exact match — `tree-sitter-` or `tree-sitter`.
      expect(treeSitterSpecs(pkg)).toEqual(["tree-sitter@^0.21.1"]);
    });
  });

  describe("isGraphDepsInstalled", () => {
    const specs = ["tree-sitter@^0.21.1", "tree-sitter-python@0.23.4"];

    it("is true only when EVERY requested parser dir is present (partial install → false)", () => {
      const nm = join(dir, "node_modules");
      mkdirSync(nm, { recursive: true });
      expect(isGraphDepsInstalled(nm, specs)).toBe(false);
      // Partial install: one of the two parsers present → still not "installed".
      mkdirSync(join(nm, "tree-sitter"), { recursive: true });
      expect(isGraphDepsInstalled(nm, specs)).toBe(false);
      mkdirSync(join(nm, "tree-sitter-python"), { recursive: true });
      expect(isGraphDepsInstalled(nm, specs)).toBe(true);
    });

    it("is false when the spec set is empty (nothing to require)", () => {
      const nm = join(dir, "node_modules");
      mkdirSync(nm, { recursive: true });
      expect(isGraphDepsInstalled(nm, [])).toBe(false);
    });
  });
});
