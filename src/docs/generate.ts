/**
 * Doc generation — author docs for a real codebase, selectively.
 *
 * Walks the AST graph (which already excludes .gitignored files, node_modules,
 * env files, etc. — see graph/ignore-config.ts), so non-code junk is filtered
 * for free. On top of that we apply doc-specific include/exclude globs and a
 * sensible default exclude list (tests, type decls, config, barrels) so we
 * don't document files nobody needs.
 *
 * Two scopes:
 *   - `file`   (default): ONE doc per source file, anchored to all of its
 *     documentable symbols (a small "component" doc — fewer docs, higher value).
 *   - `symbol`: one doc per function/class/method.
 *
 * Idempotent: a target that already has a doc is skipped unless `force`. The
 * orchestrator is pure except for the injected `generate` (LLM) and `query`.
 */

import { buildAnchor, readSymbolSource } from "./anchors.js";
import { setDoc } from "./write.js";
import type { DocAnchor, QueryFn } from "./read.js";
import type { GraphNode, GraphSnapshot } from "../graph/types.js";

/** Kinds worth a doc. const/module/variable are skipped as low-signal noise. */
const DOCUMENTABLE_KINDS = new Set(["function", "class", "method", "interface", "type_alias", "enum"]);

/** Doc-specific default excludes (on top of the graph's gitignore filtering). */
export const DEFAULT_EXCLUDE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.d.ts",
  "**/*.config.*",
  "**/index.ts",
  "**/index.js",
];

export type GenScope = "file" | "symbol";

export interface GenTarget {
  /** Stable doc_id: the source file path (file scope) or the symbol id (symbol scope). */
  doc_id: string;
  /** Source file path. */
  file: string;
  /** Documentable symbols to anchor + describe. */
  symbols: GraphNode[];
}

export interface GenDocInput {
  doc_id: string;
  file: string;
  symbols: Array<{ id: string; signature?: string; source: string }>;
}
export type GenerateDocFn = (input: GenDocInput) => Promise<string>;

/** Convert a glob (`*`, `**`, `?`) to an anchored RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // ** → any (including /)
        i++;
        if (glob[i + 1] === "/") i++; // swallow the slash after **
      } else {
        re += "[^/]*"; // * → any except /
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Pick the targets to document from the snapshot, applying scope + include/exclude.
 * `exclude` is ADDITIVE to DEFAULT_EXCLUDE_GLOBS; `include` (if given) keeps only
 * matching files.
 */
export function selectTargets(
  snap: GraphSnapshot,
  opts: { scope?: GenScope; include?: string[]; exclude?: string[] } = {},
): GenTarget[] {
  const scope = opts.scope ?? "file";
  const excludes = [...DEFAULT_EXCLUDE_GLOBS, ...(opts.exclude ?? [])];
  const includes = opts.include ?? [];

  const docNodes = snap.nodes.filter((n) => DOCUMENTABLE_KINDS.has(n.kind));
  const keep = (file: string): boolean => {
    if (includes.length > 0 && !matchesAny(file, includes)) return false;
    if (matchesAny(file, excludes)) return false;
    return true;
  };

  if (scope === "symbol") {
    return docNodes
      .filter((n) => keep(n.source_file))
      .map((n) => ({ doc_id: n.id, file: n.source_file, symbols: [n] }));
  }

  // file scope: group documentable symbols by source_file.
  const byFile = new Map<string, GraphNode[]>();
  for (const n of docNodes) {
    if (!keep(n.source_file)) continue;
    const list = byFile.get(n.source_file);
    if (list) list.push(n);
    else byFile.set(n.source_file, [n]);
  }
  return [...byFile.entries()]
    .map(([file, symbols]) => ({ doc_id: file, file, symbols }))
    .sort((a, b) => a.doc_id.localeCompare(b.doc_id));
}

/** Prompt for a fresh doc — concise, code-grounded, markdown-only. */
export function buildGeneratePrompt(input: GenDocInput): string {
  const syms = input.symbols
    .map((s) => `### ${s.id}\n${s.signature ? s.signature + "\n" : ""}\n\`\`\`\n${s.source}\n\`\`\``)
    .join("\n\n");
  return [
    "You are writing concise internal documentation for ONE source file.",
    "Describe what the file is for and what its key symbols do — one short line per symbol.",
    "Be precise and grounded in the code below. Output ONLY markdown, no preamble, no outer code fence. Keep it under ~1500 characters.",
    "",
    `## File: ${input.file}`,
    "",
    "## Symbols",
    syms || "(none)",
  ].join("\n");
}

export interface GenerateArgs {
  query: QueryFn;
  tableName: string;
  snap: GraphSnapshot;
  repoRoot: string;
  project?: string;
  scope?: GenScope;
  include?: string[];
  exclude?: string[];
  /** doc_ids that already exist (skipped unless force). */
  existing: Set<string>;
  force?: boolean;
  limit?: number;
  concurrency?: number;
  generate: GenerateDocFn;
  agent?: string;
  pluginVersion?: string;
}

export interface GenOutcome {
  doc_id: string;
  status: "created" | "skipped" | "failed";
  reason?: string;
}
export interface GenReport {
  outcomes: GenOutcome[];
  targets: number;
  created: number;
  skipped: number;
  failed: number;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

function defaultVfsPath(project: string, docId: string): string {
  return `/docs/${project || "default"}/${docId}.md`;
}

/** Generate docs for the selected targets. */
export async function generateDocs(args: GenerateArgs): Promise<GenReport> {
  const project = args.project ?? "";
  let targets = selectTargets(args.snap, { scope: args.scope, include: args.include, exclude: args.exclude });
  if (!args.force) targets = targets.filter((t) => !args.existing.has(t.doc_id));
  if (args.limit !== undefined) targets = targets.slice(0, args.limit);

  const outcomes: GenOutcome[] = [];
  await runPool(targets, args.concurrency ?? 6, async (t) => {
    // Build the prompt context from current source; also pre-build anchors.
    const symInput: GenDocInput["symbols"] = [];
    const anchors: DocAnchor[] = [];
    for (const n of t.symbols) {
      const source = readSymbolSource(n, args.repoRoot);
      const anchor = buildAnchor(n, args.repoRoot);
      if (source !== null) symInput.push({ id: n.id, signature: n.signature, source });
      if (anchor) anchors.push(anchor);
    }
    if (anchors.length === 0) {
      outcomes.push({ doc_id: t.doc_id, status: "skipped", reason: "no readable symbols to anchor" });
      return;
    }
    let content: string;
    try {
      content = await args.generate({ doc_id: t.doc_id, file: t.file, symbols: symInput });
    } catch (err) {
      outcomes.push({ doc_id: t.doc_id, status: "failed", reason: `generate failed: ${(err as Error).message}` });
      return;
    }
    if (content.trim() === "") {
      outcomes.push({ doc_id: t.doc_id, status: "failed", reason: "empty content" });
      return;
    }
    try {
      await setDoc(args.query, args.tableName, {
        doc_id: t.doc_id,
        path: defaultVfsPath(project, t.doc_id),
        content,
        anchors,
        tier: "fast",
        project,
        agent: args.agent ?? "docs-generate",
        plugin_version: args.pluginVersion,
      });
      outcomes.push({ doc_id: t.doc_id, status: "created" });
    } catch (err) {
      outcomes.push({ doc_id: t.doc_id, status: "failed", reason: `write failed: ${(err as Error).message}` });
    }
  });

  return {
    outcomes,
    targets: targets.length,
    created: outcomes.filter((o) => o.status === "created").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}
