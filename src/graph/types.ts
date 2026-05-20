/**
 * Types for the codebase-graph feature (Phase 1).
 *
 * Output shape mirrors the NetworkX node-link JSON format so the snapshot can
 * be consumed by any tool that already understands NetworkX graphs (including
 * graphify's own visualizers if we ever want to fall back to them). Snapshot
 * canonicalization (sort + stable JSON) is the responsibility of snapshot.ts.
 *
 * Phase scope: TypeScript only. Edge types are intra-file for `calls` and
 * file-level for `imports`. Cross-file call resolution and additional
 * languages land in Phase 1.5+.
 */

/**
 * Full snapshot written to ~/.hivemind/graphs/<repo-key>/snapshots/<commit-sha>.json
 * Shape is NetworkX node-link compatible (directed multigraph).
 */
export interface GraphSnapshot {
  /** Always true: code graphs are directed (caller → callee, importer → imported). */
  directed: true;
  /** Always true: same source/target pair can have multiple edges with different relations. */
  multigraph: true;
  /** Snapshot-level metadata. */
  graph: GraphMetadata;
  /** Sorted by `id` (string compare) for deterministic canonicalization. */
  nodes: GraphNode[];
  /** Sorted by (source, target, relation, ord) for deterministic canonicalization. */
  links: GraphEdge[];
}

export interface GraphMetadata {
  /** Bump when GraphSnapshot shape changes. */
  schema_version: 1;
  /** Distinguishes hivemind-produced snapshots from graphify-produced ones. */
  generator: "hivemind-graph";
  /** hivemind plugin version this snapshot was built with. */
  generator_version: string;
  /** Git HEAD at extraction time; null if cwd isn't a git repo. */
  commit_sha: string | null;
  /**
   * Current branch at extraction time. Observation metadata only — a commit
   * lives on many branches and the snapshot identity is the commit, not the
   * branch (per codex finding on branch semantics).
   */
  branch: string | null;
  /** ISO 8601 UTC. */
  ts: string;
  /** Stable per-repo identifier — sha1 of normalized git remote URL. */
  repo_key: string;
  /** Human-friendly basename of the worktree root. */
  repo_project: string;
  /** Absolute path of THIS worktree (multi-worktree disambiguator). */
  worktree_path: string;
  /** How many source files were successfully extracted. */
  source_files_extracted: number;
  /** How many files were considered but skipped (parse error, unsupported ext). */
  source_files_skipped: number;
}

export interface GraphNode {
  /** Globally unique within this snapshot. Format: `<source_file>:<symbol_name>:<kind>`. */
  id: string;
  /** Display name (typically symbol_name without path/kind suffix). */
  label: string;
  /** What kind of code construct this node represents. */
  kind: NodeKind;
  /** Path relative to repo root (forward slashes, no leading slash). */
  source_file: string;
  /** `L<line>` or `L<line>-<endLine>` (1-indexed). */
  source_location: string;
  /** Phase 1 = "typescript" only; extend in Phase 1.5. */
  language: NodeLanguage;
  /** Whether the symbol is `export`ed (relevant for cross-file resolution in Phase 1.5). */
  exported: boolean;
}

export type NodeKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type_alias"
  | "enum"
  | "const"
  | "module";

export type NodeLanguage = "typescript";

export interface GraphEdge {
  /** Source node `id`. */
  source: string;
  /** Target node `id`. May refer to an unresolved symbol (Phase 1 has no cross-file resolution). */
  target: string;
  /** Edge semantics. */
  relation: EdgeRelation;
  /**
   * Confidence label — matches graphify convention so consumers can apply
   * the same filtering logic. Phase 1 edges are almost entirely EXTRACTED;
   * INFERRED/AMBIGUOUS appear in later phases with LLM-based extraction.
   */
  confidence: EdgeConfidence;
  /**
   * Optional disambiguator for multigraph edges that share (source, target, relation).
   * E.g. a function calling another function twice. Defaults to 0 when omitted.
   */
  ord?: number;
}

export type EdgeRelation =
  /** File-level import statement. `source` is the file's module node, `target` is the imported symbol or module. */
  | "imports"
  /** Function/method invocation. Phase 1: intra-file only. Phase 1.5: cross-file. */
  | "calls"
  /** Class inheritance: `source extends target`. */
  | "extends"
  /** Interface implementation: `class implements interface`. */
  | "implements"
  /** Method belonging to a class. `source` is the class, `target` is the method. */
  | "method_of";

export type EdgeConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/**
 * Per-file extractor output. Aggregated by snapshot.ts into the final
 * GraphSnapshot. Carries parse errors so we can report which files were
 * skipped without losing the reason.
 */
export interface FileExtraction {
  /** Path relative to repo root. */
  source_file: string;
  /** Language detected from extension. */
  language: NodeLanguage;
  /** Nodes extracted from this file. Not necessarily sorted; snapshot.ts sorts globally. */
  nodes: GraphNode[];
  /** Edges extracted from this file. Same: snapshot.ts sorts globally. */
  edges: GraphEdge[];
  /** Empty array on clean parse; populated when tree-sitter reports ERROR nodes. */
  parse_errors: ParseError[];
}

export interface ParseError {
  source_file: string;
  message: string;
  /** Optional `L<line>` if the parser localized the error. */
  location?: string;
}
