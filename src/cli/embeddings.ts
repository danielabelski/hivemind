import { copyFileSync, chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { HOME, ensureDir, log, pkgRoot, symlinkForce, warn, writeJson } from "./util.js";
import { pidPathFor, socketPathFor } from "../embeddings/protocol.js";
import { getEmbeddingsEnabled, setEmbeddingsEnabled } from "../user-config.js";

/**
 * Shared-deps location for the embedding daemon's runtime dependencies.
 *
 * `@huggingface/transformers` (with onnxruntime-node + sharp) is roughly
 * 600 MB on disk — too large to ship in every agent's plugin install. We
 * install it ONCE here and symlink each agent's <plugin>/node_modules to
 * the shared `node_modules` so node's standard module resolution finds
 * the package via the symlink walk.
 */
export const SHARED_DIR = join(HOME, ".hivemind", "embed-deps");
export const SHARED_NODE_MODULES = join(SHARED_DIR, "node_modules");
export const SHARED_DAEMON_PATH = join(SHARED_DIR, "embed-daemon.js");
export const TRANSFORMERS_PKG = "@huggingface/transformers";
export const TRANSFORMERS_RANGE = "^3.0.0";

export interface AgentInstall {
  id: string;
  pluginDir: string;
}

/**
 * Discover every hivemind plugin install on disk. Each agent's installer
 * lays down the bundle in a known location; we look for those locations
 * and report any that have a `bundle/` directory present.
 *
 * Pure: takes `home` so tests can drive it against a tmp dir without
 * monkey-patching os.homedir().
 */
export function findHivemindInstalls(home: string = HOME): AgentInstall[] {
  const out: AgentInstall[] = [];
  const fixed: AgentInstall[] = [
    { id: "codex", pluginDir: join(home, ".codex", "hivemind") },
    { id: "cursor", pluginDir: join(home, ".cursor", "hivemind") },
    { id: "hermes", pluginDir: join(home, ".hermes", "hivemind") },
  ];
  for (const inst of fixed) {
    if (existsSync(join(inst.pluginDir, "bundle"))) out.push(inst);
  }
  // Claude Code marketplace cache: ~/.claude/plugins/cache/hivemind/hivemind/<version>/
  // Multiple versions can coexist — link each one that has a bundle.
  const ccCache = join(home, ".claude", "plugins", "cache", "hivemind", "hivemind");
  if (existsSync(ccCache)) {
    let entries: string[] = [];
    try { entries = readdirSync(ccCache); } catch { /* unreadable; skip */ }
    for (const ver of entries) {
      const dir = join(ccCache, ver);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      // Bundle layout differs slightly: marketplace installs put it directly
      // under <ver>/bundle, while local-clone-style layouts use <ver>/harnesses/claude-code/bundle.
      const candidates = [join(dir, "bundle"), join(dir, "harnesses", "claude-code", "bundle")];
      if (candidates.some(p => existsSync(p))) {
        out.push({ id: `claude (${ver})`, pluginDir: dir });
      }
    }
  }
  return out;
}

export function isSharedDepsInstalled(sharedNodeModules: string = SHARED_NODE_MODULES): boolean {
  return existsSync(join(sharedNodeModules, TRANSFORMERS_PKG));
}

/**
 * The code-graph feature resolves `tree-sitter` (+ language grammars) at
 * runtime from the SAME shared `embed-deps/node_modules` that the graph-on-stop
 * hook symlinks to. `ensureSharedDeps` only installs @huggingface/transformers
 * there, so on a real agent install tree-sitter is absent and the graph never
 * auto-builds (the hook degrades to a graceful skip). This provisions the
 * parsers where the hook looks.
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
 * bundles were built against — no drift, no ABI mismatch. Exported for tests.
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
export function ensureGraphDeps(): void {
  try {
    const specs = treeSitterSpecs();
    if (specs.length === 0) {
      warn(`  Graph          no tree-sitter optionalDependencies found in package.json — skipping`);
      return;
    }
    ensureDir(SHARED_DIR);
    // Create a package.json if none exists yet (user never ran embeddings
    // install). Don't clobber an existing one — it may already declare
    // transformers; `npm install <specs>` merges the parsers alongside.
    const pkgPath = join(SHARED_DIR, "package.json");
    if (!existsSync(pkgPath)) {
      writeJson(pkgPath, { name: "hivemind-embed-deps", version: "1.0.0", private: true, dependencies: {} });
    }
    // Skip the (re)download only when the exact spec set was installed before
    // AND every package is still present. The marker also catches version
    // bumps: a changed spec set forces a reinstall.
    const marker = join(SHARED_DIR, ".graph-deps");
    const wantKey = specs.join("\n");
    const haveKey = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (haveKey !== wantKey || !isGraphDepsInstalled(SHARED_NODE_MODULES, specs)) {
      log(`  Graph          installing tree-sitter parsers into ${SHARED_DIR} (code-graph; ~tens of MB)`);
      // --ignore-scripts: fetch the packages without the native build that
      //   fails on platforms lacking a prebuild; the heal below does the build.
      // The parsers ARE saved to the shared package.json (default): a plain
      //   `npm install` PRUNES unsaved packages (verified on npm 11), so an
      //   unsaved install would be wiped by ensureSharedDeps' transformers
      //   reconcile. Being declared, they're neither pruned nor (once present
      //   and version-satisfied) rebuilt by that reconcile — so ensureSharedDeps
      //   stays free of --ignore-scripts, which would break onnxruntime-node /
      //   sharp (both have real install/postinstall native steps).
      execFileSync("npm", ["install", ...specs, "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts"], {
        cwd: SHARED_DIR,
        stdio: "inherit",
      });
      writeFileSync(marker, wantKey);
    } else {
      log(`  Graph          tree-sitter parsers already present at ${SHARED_DIR}`);
    }
    // ALWAYS heal: validates bindings load + compiles from source where no
    // prebuild exists (arm64 / Node 24). Fast no-op on healthy prebuilt
    // installs; repairs an interrupted or ABI-mismatched one.
    const heal = join(pkgRoot(), "scripts", "ensure-tree-sitter.mjs");
    if (existsSync(heal)) {
      execFileSync(process.execPath, [heal], { cwd: SHARED_DIR, stdio: "inherit" });
    }
  } catch (err) {
    warn(`  Graph          tree-sitter provisioning failed (${err instanceof Error ? err.message : String(err)}); code graph stays disabled — everything else works`);
  }
}

function isSymlinkToSharedDeps(linkPath: string, sharedNodeModules: string): boolean {
  if (!existsSync(linkPath)) return false;
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    return readlinkSync(linkPath) === sharedNodeModules;
  } catch { return false; }
}

export type LinkState =
  | { kind: "linked-to-shared" }
  | { kind: "no-node-modules" }
  | { kind: "owns-own-node-modules" }
  | { kind: "linked-elsewhere"; target: string };

export function linkStateFor(install: AgentInstall, sharedNodeModules: string = SHARED_NODE_MODULES): LinkState {
  const link = join(install.pluginDir, "node_modules");
  if (!existsSync(link) && !isSymbolicLink(link)) return { kind: "no-node-modules" };
  try {
    if (lstatSync(link).isSymbolicLink()) {
      const target = readlinkSync(link);
      return target === sharedNodeModules
        ? { kind: "linked-to-shared" }
        : { kind: "linked-elsewhere", target };
    }
  } catch {
    return { kind: "no-node-modules" };
  }
  return { kind: "owns-own-node-modules" };
}

function isSymbolicLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function ensureSharedDeps(): void {
  if (!isSharedDepsInstalled()) {
    log(`  Embeddings     installing ${TRANSFORMERS_PKG}@${TRANSFORMERS_RANGE} into ${SHARED_DIR}`);
    log(`                 (~600 MB; first install only — every agent will share this)`);
    ensureDir(SHARED_DIR);
    // Merge, don't clobber: ensureGraphDeps may have already declared the
    // tree-sitter parsers here. Overwriting with transformers-only would drop
    // that declaration and let a subsequent reconcile prune the parsers.
    const pkgPath = join(SHARED_DIR, "package.json");
    let existing: { dependencies?: Record<string, string> } = {};
    try { existing = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* none yet */ }
    writeJson(pkgPath, {
      name: "hivemind-embed-deps",
      version: "1.0.0",
      private: true,
      dependencies: { ...(existing.dependencies ?? {}), [TRANSFORMERS_PKG]: TRANSFORMERS_RANGE },
    });
    execFileSync("npm", ["install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund"], {
      cwd: SHARED_DIR,
      stdio: "inherit",
    });
  } else {
    log(`  Embeddings     shared deps already present at ${SHARED_DIR}`);
  }
  // Always (re)deposit the canonical embed-daemon.js. Cheap copy; keeps the
  // daemon up-to-date when the user reinstalls hivemind without re-installing
  // the deps. Pi (and any agent that doesn't ship its own bundle) launches
  // this exact file.
  ensureDir(SHARED_DIR);
  const src = join(pkgRoot(), "embeddings", "embed-daemon.js");
  if (existsSync(src)) {
    copyFileSync(src, SHARED_DAEMON_PATH);
    chmodSync(SHARED_DAEMON_PATH, 0o755);
  } else {
    warn(`  Embeddings     standalone daemon bundle missing at ${src} (run 'npm run build' first)`);
  }
}

export function _linkAgentForTesting(install: AgentInstall): void {
  return linkAgent(install);
}

function linkAgent(install: AgentInstall): void {
  const link = join(install.pluginDir, "node_modules");
  // Don't try to overwrite a real `node_modules` directory: `symlinkForce`
  // calls `unlinkSync` first, which throws EISDIR on directories and would
  // abort `hivemind embeddings install` partway through, leaving some
  // agents linked and others not. Defer to whatever the user/marketplace
  // installed there — the same state `status` already surfaces as
  // `owns-own-node-modules`. (Symlinks at this path, including stale ones
  // pointing at a defunct shared-deps target, still go through
  // `symlinkForce` so we replace them with the canonical target.)
  const state = linkStateFor(install);
  if (state.kind === "owns-own-node-modules") {
    warn(`  Embeddings     ${install.id.padEnd(20)} owns its own node_modules — skipping symlink (status: owns-own-node-modules)`);
    return;
  }
  symlinkForce(SHARED_NODE_MODULES, link);
  log(`  Embeddings     linked ${install.id.padEnd(20)} -> shared deps`);
}

/**
 * Heavy "install" path: install shared embedding deps if missing, then
 * symlink every detected hivemind plugin install to them, then flip the
 * user-config flag to enabled. Idempotent: re-runs after installing a new
 * agent just add the missing symlink and skip the npm install.
 *
 * Running `install` is the canonical way to opt in to embeddings. After
 * this finishes, `embeddings.enabled` in `~/.deeplake/config.json` is
 * `true`, regardless of any prior value (running install overrides a
 * prior `disable`).
 */
export function installEmbeddings(): void {
  ensureSharedDeps();
  // Provision the code-graph parsers into the same shared dir so the
  // graph-on-stop hook (which symlinks here) can auto-build the graph.
  // Best-effort — a native-build failure never aborts the embeddings install.
  ensureGraphDeps();
  const installs = findHivemindInstalls();
  if (installs.length === 0) {
    warn("  Embeddings     no hivemind installs detected — run `hivemind install` first");
    warn("                 (the shared deps are in place; subsequent agent installs will pick them up if you re-run `hivemind embeddings install`)");
  } else {
    for (const inst of installs) linkAgent(inst);
  }
  setEmbeddingsEnabled(true);
  log(`  Embeddings     enabled in ~/.deeplake/config.json`);
  log(`  Embeddings     ready. Restart your agents to pick up.`);
}

/**
 * Lightweight opt-in: flip the config flag to enabled. Does NOT install
 * deps — use `install` for that. Warns if shared deps are missing so the
 * user knows to run install before sessions will actually generate
 * embeddings.
 */
export function enableEmbeddings(): void {
  setEmbeddingsEnabled(true);
  log(`  Embeddings     enabled in ~/.deeplake/config.json`);
  if (!isSharedDepsInstalled()) {
    warn(`  Embeddings     shared deps not installed yet — run \`hivemind embeddings install\` to download them`);
  } else {
    log(`  Embeddings     shared deps present — sessions will start producing embeddings on next restart`);
  }
}

/**
 * Heavy "uninstall" path: remove every agent's node_modules symlink into
 * the shared deps, optionally prune the shared dir itself, flip the
 * config flag off, and kill any running daemon so the change takes
 * effect immediately. Counterpart to `install`.
 */
export function uninstallEmbeddings(opts?: { prune?: boolean }): void {
  const installs = findHivemindInstalls();
  for (const inst of installs) {
    const link = join(inst.pluginDir, "node_modules");
    if (isSymlinkToSharedDeps(link, SHARED_NODE_MODULES)) {
      unlinkSync(link);
      log(`  Embeddings     unlinked ${inst.id}`);
    }
  }
  if (opts?.prune && existsSync(SHARED_DIR)) {
    rmSync(SHARED_DIR, { recursive: true, force: true });
    log(`  Embeddings     pruned ${SHARED_DIR}`);
  }
  setEmbeddingsEnabled(false);
  killEmbedDaemon();
  log(`  Embeddings     disabled in ~/.deeplake/config.json`);
}

/**
 * Lightweight opt-out: flip the config flag off and kill the running
 * daemon (if any) so the change takes effect immediately. Does NOT
 * remove the shared deps or per-agent symlinks — use `uninstall` to
 * reclaim disk space too.
 */
export function disableEmbeddings(): void {
  setEmbeddingsEnabled(false);
  killEmbedDaemon();
  log(`  Embeddings     disabled in ~/.deeplake/config.json`);
  log(`  Embeddings     daemon terminated; shared deps preserved (run \`hivemind embeddings uninstall\` to remove)`);
}

/**
 * Best-effort SIGTERM on the running embed daemon for this UID, then
 * unlink its socket and pidfile. Tolerant of any combination of missing
 * pidfile, missing socket, dead PID, or insufficient permissions.
 *
 * Identity check: before sending SIGTERM, we probe the socket the PID
 * is claimed to own. If the socket doesn't exist OR a short connect
 * fails, the daemon is already dead and the PID in the file is stale —
 * the OS may have recycled it to a totally unrelated process, so
 * SIGTERMing it would be a `disable` killing the user's text editor.
 * In that case we skip the kill and only clean up the file artifacts.
 */
export function killEmbedDaemon(socketDir?: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  // socketDir override is for tests only — production always lives in /tmp
  // (the protocol default). Tests pass mkdtemp dirs so they don't collide
  // with any real daemon for the same uid on the same machine.
  const pidPath = pidPathFor(String(uid), socketDir);
  const sockPath = socketPathFor(String(uid), socketDir);
  let pid: number | null = null;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  } catch { /* no pidfile */ }

  if (pid !== null && Number.isFinite(pid) && _isDaemonAliveOnSocket(sockPath)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  } else if (pid !== null) {
    // Pidfile present but socket isn't live — daemon crashed; the PID
    // value may now belong to an unrelated process. Skip the kill.
    log(`  Embeddings     pidfile present but socket dead — skipping SIGTERM on possibly-stale pid ${pid}`);
  }

  try { unlinkSync(sockPath); } catch { /* not present */ }
  try { unlinkSync(pidPath); } catch { /* not present */ }
}

/**
 * Probe whether the embed daemon socket is alive: try to connect with a
 * short timeout. Doesn't send any payload — a successful TCP/UDS handshake
 * is proof that some process is listening on this UDS path, and since
 * UDS paths are filesystem-rooted (not PID-rooted), the listener is
 * almost certainly the daemon whose pidfile sits next to it. Anything
 * else (file missing, ECONNREFUSED, ENOENT, timeout) means the daemon
 * isn't actually there.
 */
export function _isDaemonAliveOnSocket(sockPath: string, timeoutMs: number = 200): boolean {
  if (!existsSync(sockPath)) return false;
  try {
    const child = spawnSync("node", [
      "-e",
      `const n=require("node:net");` +
      `const s=n.connect(${JSON.stringify(sockPath)});` +
      `s.once("connect",()=>{s.end();process.exit(0)});` +
      `s.once("error",()=>process.exit(2));` +
      `setTimeout(()=>process.exit(3),${timeoutMs});`,
    ], { timeout: timeoutMs + 1000, stdio: "ignore" });
    return child.status === 0;
  } catch {
    return false;
  }
}

export function statusEmbeddings(): void {
  const enabled = getEmbeddingsEnabled();
  log(`Config:        ~/.deeplake/config.json embeddings.enabled = ${enabled}`);
  log(`Shared deps:   ${SHARED_DIR}`);
  log(`Installed:     ${isSharedDepsInstalled() ? "yes" : "no"}`);
  log(`Daemon:        ${existsSync(SHARED_DAEMON_PATH) ? SHARED_DAEMON_PATH : "(not present)"}`);
  if (!enabled) {
    log("");
    log(`Embeddings are DISABLED in user config. Run \`hivemind embeddings enable\` to opt in,`);
    log(`or \`hivemind embeddings install\` if the shared deps are not yet downloaded.`);
  } else if (!isSharedDepsInstalled()) {
    log("");
    warn(`Embeddings are enabled in config but shared deps are missing.`);
    warn(`Run \`hivemind embeddings install\` to download @huggingface/transformers.`);
  }
  log("");
  log(`Agent installs:`);
  const installs = findHivemindInstalls();
  if (installs.length === 0) {
    log(`  (none detected)`);
    return;
  }
  for (const inst of installs) {
    const state = linkStateFor(inst);
    let label: string;
    switch (state.kind) {
      case "linked-to-shared":      label = "✓ linked → shared"; break;
      case "no-node-modules":       label = "✗ not linked"; break;
      case "owns-own-node-modules": label = "△ has its own node_modules (not shared)"; break;
      case "linked-elsewhere":      label = `△ linked → ${state.target}`; break;
    }
    log(`  ${inst.id.padEnd(20)} ${label}`);
    log(`  ${" ".repeat(20)}   ${inst.pluginDir}`);
  }
}
