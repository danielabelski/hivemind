import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, log, pkgRoot, warn, writeJson } from "./util.js";
import { SHARED_DIR, SHARED_NODE_MODULES } from "./embeddings.js";

/**
 * The code-graph feature resolves `tree-sitter` (+ language grammars) at
 * runtime from the SAME shared `embed-deps/node_modules` that the graph-on-stop
 * hook symlinks to. `ensureSharedDeps` only installs @huggingface/transformers
 * there, so on a real agent install tree-sitter is absent and the graph never
 * auto-builds (the hook degrades to a graceful skip). This module provisions
 * the parsers where the hook looks.
 *
 * tree-sitter is a NATIVE module: symlinking the package dir alone is not
 * enough (it needs its own node-gyp-build / node-addon-api siblings resolved),
 * so we run a scoped `npm install` and let npm lay down the full tree.
 */
export function isGraphDepsInstalled(
  sharedNodeModules: string = SHARED_NODE_MODULES,
  specs: string[] = treeSitterSpecs(),
): boolean {
  // Require EVERY requested parser to be present — not just `tree-sitter` — so
  // an interrupted or partial install counts as "needs (re)install" rather
  // than being skipped as done. `<name>@<range>` → dir name is the part before
  // the (unscoped) version separator.
  if (specs.length === 0) return false;
  return specs.every((s) => existsSync(join(sharedNodeModules, s.slice(0, s.lastIndexOf("@")))));
}

/**
 * Build `<name>@<range>` specs for every tree-sitter* entry in the package's
 * own optionalDependencies. Reading them from package.json (rather than a
 * hardcoded list) keeps the embed-deps versions in lockstep with what the
 * bundles were built against — no drift, no ABI mismatch.
 */
export function treeSitterSpecs(pkgJsonPath: string = join(pkgRoot(), "package.json")): string[] {
  let opt: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    opt = pkg.optionalDependencies ?? {};
  } catch { return []; }
  return Object.keys(opt)
    .filter((n) => n === "tree-sitter" || n.startsWith("tree-sitter-"))
    .sort()
    .map((n) => `${n}@${opt[n]}`);
}

/**
 * Injection seam for ensureGraphDeps. Tests replace the two external boundaries
 * (`runNpm` = the npm install, `runHeal` = the native-build heal) and point
 * `sharedDir` / `sharedNodeModules` / `specs` at a tmp fixture, so the branch
 * logic runs against real fs without spawning npm or compiling anything.
 */
export interface GraphDepsDeps {
  sharedDir?: string;
  sharedNodeModules?: string;
  specs?: string[];
  runNpm?: (specs: string[], cwd: string) => void;
  runHeal?: (cwd: string) => void;
  logFn?: (msg: string) => void;
  warnFn?: (msg: string) => void;
}

/**
 * Install the tree-sitter parsers into the shared embed-deps dir. Idempotent
 * (a specs-hash marker + a per-package presence check skip the re-download,
 * and catch version bumps / partial installs) and best-effort: any failure is
 * logged and swallowed so it never aborts the caller — the graph stays
 * disabled but nothing else breaks, and the graph-on-stop hook degrades
 * gracefully rather than crashing.
 *
 * Two-phase native provisioning: `npm install --ignore-scripts` first, so a
 * platform without a prebuild (arm64 / Node 24) doesn't fail the download,
 * THEN scripts/ensure-tree-sitter.mjs always runs — it validates the bindings
 * load and compiles from source where no prebuild exists (a fast no-op on
 * healthy prebuilt installs). Running the heal unconditionally repairs a
 * previously interrupted or ABI-mismatched install.
 *
 * Decoupled from the ~600 MB embeddings download: this installs ONLY the
 * parsers (tens of MB), so the code graph can work without semantic search.
 */
export function ensureGraphDeps(deps: GraphDepsDeps = {}): void {
  const {
    sharedDir = SHARED_DIR,
    sharedNodeModules = SHARED_NODE_MODULES,
    specs = treeSitterSpecs(),
    runNpm = defaultRunNpm,
    runHeal = defaultRunHeal,
    logFn = log,
    warnFn = warn,
  } = deps;
  try {
    if (specs.length === 0) {
      warnFn(`  Graph          no tree-sitter optionalDependencies found in package.json — skipping`);
      return;
    }
    ensureDir(sharedDir);
    // Create a package.json if none exists yet (user never ran embeddings
    // install). Don't clobber an existing one — it may already declare
    // transformers; the parsers are installed alongside.
    const pkgPath = join(sharedDir, "package.json");
    if (!existsSync(pkgPath)) {
      writeJson(pkgPath, { name: "hivemind-embed-deps", version: "1.0.0", private: true, dependencies: {} });
    }
    // Skip the (re)download only when the exact spec set was installed before
    // AND every package is still present. The marker also catches version
    // bumps: a changed spec set forces a reinstall.
    const marker = join(sharedDir, ".graph-deps");
    const wantKey = specs.join("\n");
    const haveKey = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (haveKey !== wantKey || !isGraphDepsInstalled(sharedNodeModules, specs)) {
      logFn(`  Graph          installing tree-sitter parsers into ${sharedDir} (code-graph; ~tens of MB)`);
      runNpm(specs, sharedDir);
      writeFileSync(marker, wantKey);
    } else {
      logFn(`  Graph          tree-sitter parsers already present at ${sharedDir}`);
    }
    // ALWAYS heal: validates bindings load + compiles from source where no
    // prebuild exists (arm64 / Node 24). Fast no-op on healthy prebuilt
    // installs; repairs an interrupted or ABI-mismatched one.
    runHeal(sharedDir);
  } catch (err) {
    warnFn(`  Graph          tree-sitter provisioning failed (${err instanceof Error ? err.message : String(err)}); code graph stays disabled — everything else works`);
  }
}

/**
 * Default npm boundary. `--ignore-scripts` fetches the packages without the
 * native build that fails on platforms lacking a prebuild (the heal does the
 * build). The parsers ARE saved to the shared package.json (default): a plain
 * `npm install` PRUNES unsaved packages (verified on npm 11), so an unsaved
 * install would be wiped by ensureSharedDeps' transformers reconcile. Being
 * declared, they're neither pruned nor (once present and version-satisfied)
 * rebuilt by that reconcile — so ensureSharedDeps stays free of
 * --ignore-scripts, which would break onnxruntime-node / sharp (both have real
 * install/postinstall native steps).
 */
function defaultRunNpm(specs: string[], cwd: string): void {
  execFileSync("npm", ["install", ...specs, "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd,
    stdio: "inherit",
  });
}

/** Default heal boundary: run scripts/ensure-tree-sitter.mjs if present. */
function defaultRunHeal(cwd: string): void {
  const heal = join(pkgRoot(), "scripts", "ensure-tree-sitter.mjs");
  if (existsSync(heal)) {
    execFileSync(process.execPath, [heal], { cwd, stdio: "inherit" });
  }
}
