/**
 * Branch identity for doc rows — the value of the `scope` column.
 *
 * A doc row's `scope` encodes WHICH branch's view it belongs to:
 *   - `main`        — the canonical, public corpus (everyone sees it).
 *   - `b:<branch>`  — a shared overlay for a pushed feature branch (everyone
 *                     who is on that branch sees it; others fall back to main).
 *
 * There is deliberately NO per-user dimension in the cloud scope. Private docs
 * (generated from code that is only in a local, unpushed commit) never enter
 * the shared table at all — they live in a local store. So the only scopes that
 * reach Deeplake are `main` and `b:<branch>`, and a pushed branch doc is shared
 * by the branch, not owned by a user (two teammates on the same branch push to
 * the same origin/<branch>, so the doc converges — last write wins).
 *
 * NB: this `scope` (a branch view) is unrelated to the generation `--scope`
 * (`file` | `symbol`), which is a granularity, not an identity.
 *
 * All git access goes through an injected runner so the logic is pure and unit
 * testable — same seam as wiki-refresh (`args.git([...]) => string | null`).
 */

/** Injected git runner: returns stdout (trimmed by callers) or null on failure. */
export type GitRunner = (args: string[]) => string | null;

/** The canonical, public corpus scope. */
export const MAIN_SCOPE = "main";

/** Prefix marking a branch-overlay scope. */
const BRANCH_PREFIX = "b:";

/** The `scope` value for a feature branch overlay. */
export function branchScope(branch: string): string {
  return `${BRANCH_PREFIX}${branch}`;
}

export type ParsedScope =
  | { kind: "main" }
  | { kind: "branch"; branch: string };

/** Parse a stored `scope` value back into its identity. Unknown -> main. */
export function parseScope(scope: string | undefined): ParsedScope {
  if (scope && scope.startsWith(BRANCH_PREFIX)) {
    return { kind: "branch", branch: scope.slice(BRANCH_PREFIX.length) };
  }
  return { kind: "main" };
}

/**
 * Current branch name, or null when git can't answer or HEAD is detached.
 * A detached HEAD has no branch identity, so it resolves to the trunk (main).
 */
export function currentBranch(git: GitRunner): string | null {
  const out = git(["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  if (!out || out === "HEAD") return null; // detached / no branch
  return out;
}

/**
 * The default branch (trunk) of the repo, from `origin/HEAD`. Falls back to
 * `main` when there is no origin or the symbolic ref is unset — the safe
 * default (a repo with no remote treats its work as the canonical corpus).
 */
export function trunkBranch(git: GitRunner): string {
  // `refs/remotes/origin/HEAD -> refs/remotes/origin/<trunk>`
  const ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (ref) {
    const slash = ref.lastIndexOf("/");
    const name = slash >= 0 ? ref.slice(slash + 1) : ref;
    if (name) return name;
  }
  return "main";
}

/**
 * The `scope` value for the current git checkout: `main` when on the trunk (or
 * detached / non-git), else `b:<branch>`. This is the single place that maps
 * "where git HEAD is" onto a doc identity.
 */
export function currentScope(git: GitRunner, trunk?: string): string {
  const branch = currentBranch(git);
  if (branch === null) return MAIN_SCOPE;
  const trunkName = trunk ?? trunkBranch(git);
  return branch === trunkName ? MAIN_SCOPE : branchScope(branch);
}
