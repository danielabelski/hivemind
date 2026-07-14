// dist/src/cli/util.js
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
var HOME = homedir();
function pkgRoot() {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.name === "@deeplake/hivemind" || pkg.name === "hivemind")
        return dir;
    } catch {
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return fileURLToPath(new URL("..", import.meta.url));
}
function ensureDir(path, mode = 493) {
  if (!existsSync(path))
    mkdirSync(path, { recursive: true, mode });
}
function copyDir(src, dst) {
  cpSync(src, dst, { recursive: true, force: true, dereference: false });
}
function symlinkForce(target, link) {
  ensureDir(dirname(link));
  if (existsSync(link) || isLink(link))
    unlinkSync(link);
  symlinkSync(target, link);
}
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function readJson(path) {
  if (!existsSync(path))
    return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
function writeJson(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}
function writeJsonIfChanged(path, obj) {
  const next = JSON.stringify(obj, null, 2) + "\n";
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === next)
        return false;
    } catch {
    }
  }
  ensureDir(dirname(path));
  writeFileSync(path, next);
  return true;
}
function writeVersionStamp(dir, version) {
  ensureDir(dir);
  writeFileSync(join(dir, ".hivemind_version"), version);
}
function claudeDesktopConfigDir() {
  if (process.platform === "darwin")
    return join(HOME, "Library", "Application Support", "Claude");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(HOME, "AppData", "Roaming"), "Claude");
  return join(HOME, ".config", "Claude");
}
var PLATFORM_MARKERS = [
  { id: "claude", markerDir: join(HOME, ".claude") },
  { id: "codex", markerDir: join(HOME, ".codex") },
  { id: "claw", markerDir: join(HOME, ".openclaw") },
  { id: "cursor", markerDir: join(HOME, ".cursor") },
  { id: "hermes", markerDir: join(HOME, ".hermes") },
  // pi (badlogic/pi-mono coding-agent) — config at ~/.pi/agent/. pi exposes
  // a rich extension event API (session_start / input / tool_call /
  // tool_result / message_end / session_shutdown / etc.) — Tier 1 capable.
  { id: "pi", markerDir: join(HOME, ".pi") },
  // claude_cowork — Anthropic's agentic desktop assistant, hosted in the
  // Claude Desktop app. Registers the shared hivemind MCP server into
  // claude_desktop_config.json (recall-only; capture is the desktop app's
  // own concern). Marker is the OS-specific Claude Desktop config dir.
  { id: "claude_cowork", markerDir: claudeDesktopConfigDir() }
];
function detectPlatforms() {
  return PLATFORM_MARKERS.filter((p) => existsSync(p.markerDir));
}
function allPlatformIds() {
  return PLATFORM_MARKERS.map((p) => p.id);
}
function log(msg) {
  process.stdout.write(msg + "\n");
}
function warn(msg) {
  process.stderr.write(msg + "\n");
}
function confirm(message, defaultYes = true) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve4) => {
    rl.question(`${message} ${hint} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "")
        resolve4(defaultYes);
      else
        resolve4(a === "y" || a === "yes");
    });
  });
}
function promptLine(message) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve4) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve4(answer.trim());
    });
  });
}

// dist/src/cli/version.js
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync2(join2(pkgRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// dist/src/user-config.js
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync3, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
var _configPath = () => process.env.HIVEMIND_CONFIG_PATH ?? join3(homedir2(), ".deeplake", "config.json");
var _cache = null;
var _migrated = false;
function readUserConfig() {
  if (_cache !== null)
    return _cache;
  const path = _configPath();
  if (!existsSync2(path)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = readFileSync3(path, "utf-8");
    const parsed = JSON.parse(raw);
    _cache = isPlainObject(parsed) ? parsed : {};
  } catch {
    _cache = {};
  }
  return _cache;
}
function writeUserConfig(patch) {
  const current = readUserConfig();
  const merged = deepMerge(current, patch);
  const path = _configPath();
  const dir = dirname2(path);
  if (!existsSync2(dir))
    mkdirSync2(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync2(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
  _cache = merged;
  return merged;
}
function getEmbeddingsEnabled() {
  const cfg = readUserConfig();
  if (cfg.embeddings && typeof cfg.embeddings.enabled === "boolean") {
    return cfg.embeddings.enabled;
  }
  if (_migrated) {
    return migrationValueFromEnv();
  }
  _migrated = true;
  const enabled = migrationValueFromEnv();
  try {
    writeUserConfig({ embeddings: { enabled } });
  } catch {
    _cache = { ...cfg ?? {}, embeddings: { ...cfg?.embeddings ?? {}, enabled } };
  }
  return enabled;
}
function migrationValueFromEnv() {
  const raw = process.env.HIVEMIND_EMBEDDINGS;
  if (raw === void 0)
    return false;
  if (raw === "false")
    return false;
  return true;
}
function setEmbeddingsEnabled(enabled) {
  writeUserConfig({ embeddings: { enabled } });
}
function getDocsLlmAgent() {
  const v = readUserConfig().docs?.llmAgent;
  return typeof v === "string" && v.trim() !== "" ? v : void 0;
}
function setDocsLlmAgent(agent) {
  writeUserConfig({ docs: { llmAgent: agent } });
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const baseVal = base[key];
    if (isPlainObject(patchVal) && isPlainObject(baseVal)) {
      out[key] = { ...baseVal, ...patchVal };
    } else if (patchVal !== void 0) {
      out[key] = patchVal;
    }
  }
  return out;
}

// dist/src/config.js
import { readFileSync as readFileSync4, existsSync as existsSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { homedir as homedir3, userInfo } from "node:os";
function loadConfig() {
  const home = homedir3();
  const credPath = join4(home, ".deeplake", "credentials.json");
  let creds = null;
  if (existsSync3(credPath)) {
    try {
      creds = JSON.parse(readFileSync4(credPath, "utf-8"));
    } catch {
      return null;
    }
  }
  const token = process.env.HIVEMIND_TOKEN ?? creds?.token;
  const orgId = process.env.HIVEMIND_ORG_ID ?? creds?.orgId;
  if (!token || !orgId)
    return null;
  return {
    token,
    orgId,
    orgName: creds?.orgName ?? orgId,
    userName: creds?.userName || userInfo().username || "unknown",
    workspaceId: process.env.HIVEMIND_WORKSPACE_ID ?? creds?.workspaceId ?? "default",
    apiUrl: process.env.HIVEMIND_API_URL ?? creds?.apiUrl ?? "https://api.deeplake.ai",
    tableName: process.env.HIVEMIND_TABLE ?? "memory",
    sessionsTableName: process.env.HIVEMIND_SESSIONS_TABLE ?? "sessions",
    skillsTableName: process.env.HIVEMIND_SKILLS_TABLE ?? "skills",
    // Defaults match the table name written into the SQL — keep aligned
    // with RULES_COLUMNS in deeplake-schema.ts and with the e2e test-org
    // override convention (memory_test / sessions_test → goals_test, etc.)
    // documented in CLAUDE.md.
    rulesTableName: process.env.HIVEMIND_RULES_TABLE ?? "hivemind_rules",
    // Goals + KPIs (refined design — VFS path classifier maps
    //   memory/goal/<user>/<status>/<uuid>.md → hivemind_goals row
    //   memory/kpi/<uuid>/<kpi_id>.md → hivemind_kpis row
    // See src/shell/deeplake-fs.ts for the translation logic and
    // GOALS_COLUMNS / KPIS_COLUMNS in deeplake-schema.ts for the
    // table shape.
    goalsTableName: process.env.HIVEMIND_GOALS_TABLE ?? "hivemind_goals",
    kpisTableName: process.env.HIVEMIND_KPIS_TABLE ?? "hivemind_kpis",
    // Per-file documentation kept fresh on code deltas. INSERT-only
    // version-bumped table (see DOCS_COLUMNS in deeplake-schema.ts).
    // Phase 1: written/read through the `hivemind docs` CLI + worker via the
    // src/docs store. NOT yet routed through the VFS path classifier — when
    // VFS routing lands it MUST use the INSERT-only store, never the goals
    // UPDATE-or-INSERT path (which is vulnerable to UPDATE-coalescing).
    docsTableName: process.env.HIVEMIND_DOCS_TABLE ?? "hivemind_docs",
    codebaseTableName: process.env.HIVEMIND_CODEBASE_TABLE ?? "codebase",
    memoryPath: process.env.HIVEMIND_MEMORY_PATH ?? join4(home, ".deeplake", "memory")
  };
}

// dist/src/utils/sql.js
function sqlStr(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\0/g, "").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function sqlLike(value) {
  return sqlStr(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
}
function sqlIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

// dist/src/deeplake-schema.js
var MEMORY_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "summary", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "summary_embedding", sql: "FLOAT4[]" },
  { name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mime_type", sql: "TEXT NOT NULL DEFAULT 'text/plain'" },
  { name: "size_bytes", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var SESSIONS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "message", sql: "JSONB" },
  { name: "message_embedding", sql: "FLOAT4[]" },
  { name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mime_type", sql: "TEXT NOT NULL DEFAULT 'application/json'" },
  { name: "size_bytes", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var SKILLS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "project_key", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "local_path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "install", sql: "TEXT NOT NULL DEFAULT 'project'" },
  { name: "source_sessions", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "source_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "scope", sql: "TEXT NOT NULL DEFAULT 'me'" },
  { name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "contributors", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "trigger_text", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "body", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var RULES_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "rule_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "text", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "scope", sql: "TEXT NOT NULL DEFAULT 'team'" },
  { name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
  { name: "assigned_by", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT 'manual'" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var GOALS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "goal_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "owner", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "status", sql: "TEXT NOT NULL DEFAULT 'opened'" },
  { name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT 'manual'" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var KPIS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "goal_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "kpi_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT 'manual'" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" }
]);
var DOCS_COLUMNS = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "doc_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "anchors", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "tier", sql: "TEXT NOT NULL DEFAULT 'fast'" },
  { name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
  { name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
  // Which shared view a row belongs to: `main` = the canonical truth
  // (written only by the elected refresh turn); `u:<user>|b:<branch>` =
  // a personal branch overlay (v2, opt-in). Reads default to `main`.
  { name: "scope", sql: "TEXT NOT NULL DEFAULT 'main'" },
  // Per-page source fingerprint: JSON `{file: git-blob-sha}` the page was
  // generated from. Drives freshness (stale iff it differs from HEAD's), the
  // overlay-divergence decision, the origin publish gate, and merge promotion.
  // Read only where needed (scoped reads) so generic reads stay heal-safe.
  { name: "source_fp", sql: "TEXT NOT NULL DEFAULT '{}'" },
  { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "agent", sql: "TEXT NOT NULL DEFAULT 'manual'" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
  // Semantic-search vector over `content` (nomic, DOC_PREFIX). Nullable/empty
  // when embeddings are off or not yet backfilled — `docs/find/` guards with
  // ARRAY_LENGTH(...) > 0, exactly like grep-core does for summaries.
  { name: "content_embedding", sql: "FLOAT4[]" }
]);
function validateSchema(label, cols) {
  const seen = /* @__PURE__ */ new Set();
  for (const col of cols) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name)) {
      throw new Error(`${label}: column name "${col.name}" is not a valid SQL identifier`);
    }
    if (seen.has(col.name)) {
      throw new Error(`${label}: duplicate column "${col.name}"`);
    }
    seen.add(col.name);
    const notNull = /\bNOT\s+NULL\b/i.test(col.sql);
    const hasDefault = /\bDEFAULT\b/i.test(col.sql);
    if (notNull && !hasDefault) {
      throw new Error(`${label}: column "${col.name}" is NOT NULL but has no DEFAULT \u2014 ALTER TABLE ADD COLUMN on a populated table would fail.`);
    }
  }
}
var CODEBASE_COLUMNS = Object.freeze([
  // Identity key (matches the PK below)
  { name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "repo_slug", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "user_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "worktree_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "commit_sha", sql: "TEXT NOT NULL DEFAULT ''" },
  // Observation metadata
  { name: "parent_sha", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "branch", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "ts", sql: "TIMESTAMP" },
  { name: "pushed_by", sql: "TEXT NOT NULL DEFAULT ''" },
  // Snapshot payload
  { name: "snapshot_sha256", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "snapshot_jsonb", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "node_count", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "edge_count", sql: "BIGINT NOT NULL DEFAULT 0" },
  // Generator metadata (for drift diagnostics — what hivemind version produced this?)
  { name: "generator", sql: "TEXT NOT NULL DEFAULT 'hivemind-graph'" },
  { name: "generator_version", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "schema_version", sql: "BIGINT NOT NULL DEFAULT 1" }
]);
validateSchema("MEMORY_COLUMNS", MEMORY_COLUMNS);
validateSchema("SESSIONS_COLUMNS", SESSIONS_COLUMNS);
validateSchema("SKILLS_COLUMNS", SKILLS_COLUMNS);
validateSchema("RULES_COLUMNS", RULES_COLUMNS);
validateSchema("GOALS_COLUMNS", GOALS_COLUMNS);
validateSchema("KPIS_COLUMNS", KPIS_COLUMNS);
validateSchema("DOCS_COLUMNS", DOCS_COLUMNS);
validateSchema("CODEBASE_COLUMNS", CODEBASE_COLUMNS);
function buildCreateTableSql(tableName, cols) {
  const safe = sqlIdent(tableName);
  const colSql = cols.map((c) => `${c.name} ${c.sql}`).join(", ");
  return `CREATE TABLE IF NOT EXISTS "${safe}" (${colSql}) USING deeplake`;
}
function buildIntrospectionSql(tableName, workspaceId) {
  return `SELECT column_name FROM information_schema.columns WHERE table_name = '${sqlStr(tableName)}' AND table_schema = '${sqlStr(workspaceId)}'`;
}
async function healMissingColumns(args) {
  const safeTable = sqlIdent(args.tableName);
  const introspectSql = buildIntrospectionSql(args.tableName, args.workspaceId);
  const rows = await args.query(introspectSql);
  const existing = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const v = row?.column_name;
    if (typeof v === "string")
      existing.add(v.toLowerCase());
  }
  const missingCols = args.columns.filter((c) => !existing.has(c.name.toLowerCase()));
  const missing = missingCols.map((c) => c.name);
  if (missingCols.length === 0)
    return { missing, altered: [] };
  const altered = [];
  for (const col of missingCols) {
    try {
      await args.query(`ALTER TABLE "${safeTable}" ADD COLUMN ${col.name} ${col.sql}`);
      altered.push(col.name);
      args.log?.(`schema-heal: added "${args.tableName}"."${col.name}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg))
        throw e;
      const recheck = await args.query(introspectSql);
      const present = recheck.some((r) => {
        const v = r?.column_name;
        return typeof v === "string" && v.toLowerCase() === col.name.toLowerCase();
      });
      if (!present)
        throw e;
      args.log?.(`schema-heal: "${args.tableName}"."${col.name}" appeared via race, treating as success`);
    }
  }
  return { missing, altered };
}
function isMissingTableError(message) {
  if (!message)
    return false;
  if (/permission denied|must be owner/i.test(message))
    return false;
  if (/\bcolumn\b/i.test(message))
    return false;
  return /Table does not exist|relation .* does not exist|no such table/i.test(message);
}
function isMissingColumnError(message) {
  if (!message)
    return false;
  if (/permission denied|must be owner/i.test(message))
    return false;
  return /column ["']?[A-Za-z_][A-Za-z0-9_]*["']? .*does not exist/i.test(message) || /unknown column/i.test(message) || /no such column/i.test(message);
}

// dist/src/deeplake-api.js
import { randomUUID } from "node:crypto";

// dist/src/utils/debug.js
import { appendFileSync, mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
import { homedir as homedir4 } from "node:os";
var LOG = join5(homedir4(), ".deeplake", "hook-debug.log");
function isDebug() {
  return process.env.HIVEMIND_DEBUG === "1";
}
function utcTimestamp(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function log2(tag, msg) {
  if (!isDebug())
    return;
  try {
    mkdirSync3(dirname3(LOG), { recursive: true });
    appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} [${tag}] ${msg}
`);
  } catch {
  }
}

// dist/src/embeddings/columns.js
var SUMMARY_EMBEDDING_COL = "summary_embedding";

// dist/src/utils/client-header.js
var DEEPLAKE_CLIENT_HEADER = "X-Deeplake-Client";
function deeplakeClientValue() {
  return "hivemind";
}
function deeplakeClientHeader() {
  return { [DEEPLAKE_CLIENT_HEADER]: deeplakeClientValue() };
}

// dist/src/notifications/queue.js
import { readFileSync as readFileSync5, writeFileSync as writeFileSync3, mkdirSync as mkdirSync4, openSync, closeSync, unlinkSync as unlinkSync2, statSync } from "node:fs";
import { join as join6, resolve as resolve2 } from "node:path";
import { homedir as homedir5 } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

// dist/src/utils/atomic-write.js
import { renameSync as fsRenameSync, unlinkSync as fsUnlinkSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
function isPathInsideHome(path, home) {
  const r = resolve(path);
  const h = resolve(home);
  if (r === h)
    return true;
  const rel = relative(h, r);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function renameAtomic(tmp, dest, opts = {}) {
  const rename = opts.rename ?? fsRenameSync;
  const cleanup = opts.cleanup ?? defaultCleanup;
  const maxAttempts = opts.maxAttempts ?? 10;
  const backoff = opts.backoff ?? defaultBackoff;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, dest);
      return;
    } catch (e) {
      const code = e.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= maxAttempts - 1) {
        cleanup(tmp);
        throw e;
      }
      backoff(attempt);
    }
  }
}
function defaultCleanup(tmp) {
  try {
    fsUnlinkSync(tmp);
  } catch {
  }
}
function defaultBackoff(attempt) {
  const until = Date.now() + 10 * (attempt + 1);
  while (Date.now() < until) {
  }
}

// dist/src/notifications/queue.js
var log3 = (msg) => log2("notifications-queue", msg);
var LOCK_RETRY_MAX = 50;
var LOCK_RETRY_BASE_MS = 5;
var LOCK_STALE_MS = 5e3;
function queuePath() {
  return join6(homedir5(), ".deeplake", "notifications-queue.json");
}
function lockPath() {
  return `${queuePath()}.lock`;
}
function readQueue() {
  try {
    const raw = readFileSync5(queuePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.queue)) {
      log3(`queue malformed \u2192 treating as empty`);
      return { queue: [] };
    }
    return { queue: parsed.queue };
  } catch {
    return { queue: [] };
  }
}
function _isQueuePathInsideHome(path, home) {
  return isPathInsideHome(path, home);
}
function writeQueue(q) {
  const path = queuePath();
  const home = resolve2(homedir5());
  if (!_isQueuePathInsideHome(path, home)) {
    throw new Error(`notifications-queue write blocked: ${path} is outside ${home}`);
  }
  mkdirSync4(join6(home, ".deeplake"), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync3(tmp, JSON.stringify(q, null, 2), { mode: 384 });
  renameAtomic(tmp, path);
}
async function withQueueLock(fn) {
  const path = lockPath();
  mkdirSync4(join6(homedir5(), ".deeplake"), { recursive: true, mode: 448 });
  let fd = null;
  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      fd = openSync(path, "wx", 384);
      break;
    } catch (e) {
      const code = e.code;
      if (code !== "EEXIST")
        throw e;
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync2(path);
          continue;
        }
      } catch {
      }
      const delay = LOCK_RETRY_BASE_MS * (attempt + 1);
      await sleep(delay);
    }
  }
  if (fd === null) {
    log3(`lock acquisition gave up after ${LOCK_RETRY_MAX} attempts \u2014 proceeding unlocked (last-writer-wins)`);
    return fn();
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
    try {
      unlinkSync2(path);
    } catch {
    }
  }
}
function sameDedupKey(a, b) {
  if (a.id !== b.id)
    return false;
  return JSON.stringify(a.dedupKey) === JSON.stringify(b.dedupKey);
}
async function enqueueNotification(n) {
  await withQueueLock(() => {
    const q = readQueue();
    if (q.queue.some((existing) => sameDedupKey(existing, n))) {
      return;
    }
    q.queue.push(n);
    writeQueue(q);
  });
}

// dist/src/commands/auth-creds.js
import { readFileSync as readFileSync6, writeFileSync as writeFileSync4, mkdirSync as mkdirSync5, unlinkSync as unlinkSync3, renameSync as renameSync2 } from "node:fs";
import { join as join7 } from "node:path";
import { homedir as homedir6 } from "node:os";
function configDir() {
  return join7(homedir6(), ".deeplake");
}
function credsPath() {
  return join7(configDir(), "credentials.json");
}
function loadCredentials(readFile = (p) => readFileSync6(p, "utf-8")) {
  try {
    return JSON.parse(readFile(credsPath()));
  } catch (err) {
    if (err?.code === "ENOENT")
      return null;
    try {
      return JSON.parse(readFile(credsPath()));
    } catch {
      return null;
    }
  }
}
function saveCredentials(creds) {
  mkdirSync5(configDir(), { recursive: true, mode: 448 });
  const target = credsPath();
  const tmp = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const body = JSON.stringify({ ...creds, savedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2);
  try {
    writeFileSync4(tmp, body, { mode: 384 });
    renameSync2(tmp, target);
  } catch (err) {
    try {
      unlinkSync3(tmp);
    } catch {
    }
    throw err;
  }
}
function deleteCredentials() {
  try {
    unlinkSync3(credsPath());
    return true;
  } catch {
    return false;
  }
}

// dist/src/deeplake-api.js
var indexMarkerStorePromise = null;
function getIndexMarkerStore() {
  if (!indexMarkerStorePromise)
    indexMarkerStorePromise = import("./index-marker-store-OT7OEIYE.js");
  return indexMarkerStorePromise;
}
var log4 = (msg) => log2("sdk", msg);
function summarizeSql(sql, maxLen = 220) {
  const compact = sql.replace(/\s+/g, " ").trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}
function traceSql(msg) {
  const traceEnabled = process.env.HIVEMIND_TRACE_SQL === "1" || process.env.HIVEMIND_DEBUG === "1";
  if (!traceEnabled)
    return;
  process.stderr.write(`[deeplake-sql] ${msg}
`);
  if (process.env.HIVEMIND_DEBUG === "1")
    log4(msg);
}
var _signalledBalanceExhausted = false;
function maybeSignalBalanceExhausted(status, bodyText) {
  if (status !== 402)
    return;
  if (!bodyText.includes("balance_cents"))
    return;
  if (_signalledBalanceExhausted)
    return;
  _signalledBalanceExhausted = true;
  log4(`balance exhausted \u2014 enqueuing session-start banner (body=${bodyText.slice(0, 120)})`);
  enqueueNotification({
    id: "balance-exhausted",
    severity: "warn",
    transient: true,
    title: "Hivemind credits exhausted \u2014 top up to keep capturing",
    body: `Sessions are not being saved and memory recall is returning empty. Top up at ${billingUrl()} to restore capture and recall.`,
    dedupKey: { reason: "balance-zero" },
    // User-facing billing notice → user channel only. Never the model's
    // additionalContext: a "top up at <url>" instruction in the agent prompt
    // is a prompt-injection pattern external agents flag.
    userVisibleOnly: true
  }).catch((e) => {
    log4(`enqueue balance-exhausted failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
function billingUrl() {
  try {
    const c = loadCredentials();
    if (c?.orgName && c?.workspaceId) {
      return `https://deeplake.ai/${encodeURIComponent(c.orgName)}/workspace/${encodeURIComponent(c.workspaceId)}/billing`;
    }
  } catch {
  }
  return "https://deeplake.ai";
}
var RETRYABLE_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var MAX_RETRIES = 3;
var BASE_DELAY_MS = 500;
var MAX_CONCURRENCY = 5;
function getQueryTimeoutMs() {
  return Number(process.env.HIVEMIND_QUERY_TIMEOUT_MS ?? 1e4);
}
function sleep2(ms, signal) {
  if (signal?.aborted)
    return Promise.reject(new Error("aborted"));
  return new Promise((resolve4, reject) => {
    const t = setTimeout(resolve4, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
function isTimeoutError(error) {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return name.includes("timeout") || name === "aborterror" || message.includes("timeout") || message.includes("timed out");
}
function isDuplicateIndexError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("duplicate key value violates unique constraint") || message.includes("pg_class_relname_nsp_index") || message.includes("already exists");
}
function isSessionInsertQuery(sql) {
  return /^\s*insert\s+into\s+"[^"]+"\s*\(\s*id\s*,\s*path\s*,\s*filename\s*,\s*message\s*,/i.test(sql);
}
function isTransientHtml403(text) {
  const body = text.toLowerCase();
  return body.includes("<html") || body.includes("403 forbidden") || body.includes("cloudflare") || body.includes("nginx");
}
var Semaphore = class {
  max;
  waiting = [];
  active = 0;
  constructor(max) {
    this.max = max;
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve4) => this.waiting.push(resolve4));
  }
  release() {
    this.active--;
    const next = this.waiting.shift();
    if (next) {
      this.active++;
      next();
    }
  }
};
var DeeplakeApi = class {
  token;
  apiUrl;
  orgId;
  workspaceId;
  tableName;
  _pendingRows = [];
  _sem = new Semaphore(MAX_CONCURRENCY);
  _tablesCache = null;
  constructor(token, apiUrl, orgId, workspaceId, tableName) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.orgId = orgId;
    this.workspaceId = workspaceId;
    this.tableName = tableName;
  }
  /** Execute SQL with retry on transient errors and bounded concurrency. */
  async query(sql, signal) {
    const startedAt = Date.now();
    const summary = summarizeSql(sql);
    traceSql(`query start: ${summary}`);
    await this._sem.acquire();
    try {
      const rows = await this._queryWithRetry(sql, signal);
      traceSql(`query ok (${Date.now() - startedAt}ms, rows=${rows.length}): ${summary}`);
      return rows;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      traceSql(`query fail (${Date.now() - startedAt}ms): ${summary} :: ${message}`);
      throw e;
    } finally {
      this._sem.release();
    }
  }
  async _queryWithRetry(sql, externalSignal) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (externalSignal?.aborted)
        throw new Error("Query aborted");
      let resp;
      const timeoutMs = getQueryTimeoutMs();
      try {
        const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": this.orgId,
            ...deeplakeClientHeader()
          },
          signal,
          body: JSON.stringify({ query: sql })
        });
      } catch (e) {
        if (isTimeoutError(e)) {
          lastError = new Error(`Query timeout after ${timeoutMs}ms`);
          throw lastError;
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
          log4(`query retry ${attempt + 1}/${MAX_RETRIES} (fetch error: ${lastError.message}) in ${delay.toFixed(0)}ms`);
          await sleep2(delay, externalSignal);
          continue;
        }
        throw lastError;
      }
      if (resp.ok) {
        const raw = await resp.json();
        if (!raw?.rows || !raw?.columns)
          return [];
        return raw.rows.map((row) => Object.fromEntries(raw.columns.map((col, i) => [col, row[i]])));
      }
      const text = await resp.text().catch(() => "");
      const retryable403 = isSessionInsertQuery(sql) && (resp.status === 401 || resp.status === 403 && (text.length === 0 || isTransientHtml403(text)));
      const alreadyExists = resp.status === 500 && isDuplicateIndexError(text);
      if (!alreadyExists && attempt < MAX_RETRIES && (RETRYABLE_CODES.has(resp.status) || retryable403)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
        log4(`query retry ${attempt + 1}/${MAX_RETRIES} (${resp.status}) in ${delay.toFixed(0)}ms`);
        await sleep2(delay, externalSignal);
        continue;
      }
      maybeSignalBalanceExhausted(resp.status, text);
      throw new Error(`Query failed: ${resp.status}: ${text.slice(0, 200)}`);
    }
    throw lastError ?? new Error("Query failed: max retries exceeded");
  }
  // ── Writes ──────────────────────────────────────────────────────────────────
  /** Queue rows for writing. Call commit() to flush. */
  appendRows(rows) {
    this._pendingRows.push(...rows);
  }
  /** Flush pending rows via SQL. */
  async commit() {
    if (this._pendingRows.length === 0)
      return;
    const rows = this._pendingRows;
    this._pendingRows = [];
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map((r) => this.upsertRowSql(r)));
    }
    log4(`commit: ${rows.length} rows`);
  }
  async upsertRowSql(row) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const cd = row.creationDate ?? ts;
    const lud = row.lastUpdateDate ?? ts;
    const exists = await this.query(`SELECT path FROM "${this.tableName}" WHERE path = '${sqlStr(row.path)}' LIMIT 1`);
    if (exists.length > 0) {
      let setClauses = `summary = E'${sqlStr(row.contentText)}', ${SUMMARY_EMBEDDING_COL} = NULL, mime_type = '${sqlStr(row.mimeType)}', size_bytes = ${row.sizeBytes}, last_update_date = '${lud}'`;
      if (row.project !== void 0)
        setClauses += `, project = '${sqlStr(row.project)}'`;
      if (row.description !== void 0)
        setClauses += `, description = '${sqlStr(row.description)}'`;
      await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(row.path)}'`);
    } else {
      const id = randomUUID();
      let cols = `id, path, filename, summary, ${SUMMARY_EMBEDDING_COL}, mime_type, size_bytes, creation_date, last_update_date`;
      let vals = `'${id}', '${sqlStr(row.path)}', '${sqlStr(row.filename)}', E'${sqlStr(row.contentText)}', NULL, '${sqlStr(row.mimeType)}', ${row.sizeBytes}, '${cd}', '${lud}'`;
      if (row.project !== void 0) {
        cols += ", project";
        vals += `, '${sqlStr(row.project)}'`;
      }
      if (row.description !== void 0) {
        cols += ", description";
        vals += `, '${sqlStr(row.description)}'`;
      }
      await this.query(`INSERT INTO "${this.tableName}" (${cols}) VALUES (${vals})`);
    }
  }
  /** Update specific columns on a row by path. */
  async updateColumns(path, columns) {
    const setClauses = Object.entries(columns).map(([col, val]) => typeof val === "number" ? `${col} = ${val}` : `${col} = '${sqlStr(String(val))}'`).join(", ");
    await this.query(`UPDATE "${this.tableName}" SET ${setClauses} WHERE path = '${sqlStr(path)}'`);
  }
  // ── Convenience ─────────────────────────────────────────────────────────────
  /** Create a BM25 search index on a column. */
  async createIndex(column) {
    await this.query(`CREATE INDEX IF NOT EXISTS idx_${sqlStr(column)}_bm25 ON "${this.tableName}" USING deeplake_index ("${column}")`);
  }
  buildLookupIndexName(table, suffix) {
    return `idx_${table}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");
  }
  async ensureLookupIndex(table, suffix, columnsSql) {
    const markers = await getIndexMarkerStore();
    const markerPath = markers.buildIndexMarkerPath(this.workspaceId, this.orgId, table, suffix);
    if (markers.hasFreshIndexMarker(markerPath))
      return;
    const indexName = this.buildLookupIndexName(table, suffix);
    try {
      await this.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" ${columnsSql}`);
      markers.writeIndexMarker(markerPath);
    } catch (e) {
      if (isDuplicateIndexError(e)) {
        markers.writeIndexMarker(markerPath);
        return;
      }
      log4(`index "${indexName}" skipped: ${e.message}`);
    }
  }
  /**
   * Heal any missing columns on a table so it matches one of the schema
   * definitions in `deeplake-schema.ts`. One SELECT against
   * `information_schema.columns` per call, then `ALTER TABLE ADD COLUMN`
   * only the genuinely missing ones — never blanket, never `IF NOT
   * EXISTS`.
   *
   * History: an earlier path used a local marker file (`col_<name>` under
   * the index-marker dir) to skip even the SELECT after the first
   * confirmation, plus per-column ALTERs for `summary_embedding`,
   * `message_embedding`, `agent`, `plugin_version`. The marker existed
   * because Deeplake used to expose a ~30s post-ALTER bug where
   * subsequent INSERTs failed, so we wanted to keep ALTER traffic to a
   * minimum. The bug was re-verified on 2026-05-18 against
   * `api.deeplake.ai` (`test_plugin` org) and no longer reproduces
   * (71/71 INSERTs OK, first success 2ms after ALTER). The single SELECT
   * + targeted ALTER pattern survives the marker removal because: each
   * ALTER still costs ~800ms (so blanket sweeps are wasteful) and the
   * diff produces clearer logs than "ALTER all with IF NOT EXISTS".
   */
  async healSchema(table, columns) {
    await healMissingColumns({
      query: (sql) => this.query(sql),
      tableName: table,
      workspaceId: this.workspaceId,
      columns,
      log: log4
    });
  }
  /** List all tables in the workspace (with retry). */
  async listTables(forceRefresh = false) {
    if (!forceRefresh && this._tablesCache)
      return [...this._tablesCache];
    const { tables, cacheable } = await this._fetchTables();
    if (cacheable)
      this._tablesCache = [...tables];
    return tables;
  }
  /**
   * Like listTables() but returns null when the list could NOT be trusted
   * (the fetch failed / was non-cacheable). Callers gating a read on table
   * existence use this to tell a genuinely-empty workspace ([]) apart from a
   * failed lookup (null): on [] they can safely skip the read (no table → no
   * 42P01), on null they must fall back to SELECT-then-catch so a transient
   * lookup blip doesn't drop a read of a table that really exists.
   */
  async knownTablesOrNull() {
    if (this._tablesCache)
      return [...this._tablesCache];
    const { tables, cacheable } = await this._fetchTables();
    if (!cacheable)
      return null;
    this._tablesCache = [...tables];
    return [...tables];
  }
  async _fetchTables() {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${this.apiUrl}/workspaces/${this.workspaceId}/tables`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "X-Activeloop-Org-Id": this.orgId,
            ...deeplakeClientHeader()
          }
        });
        if (resp.ok) {
          const data = await resp.json();
          return {
            tables: (data.tables ?? []).map((t) => t.table_name),
            cacheable: true
          };
        }
        if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(resp.status)) {
          await sleep2(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        return { tables: [], cacheable: false };
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep2(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return { tables: [], cacheable: false };
      }
    }
    return { tables: [], cacheable: false };
  }
  /**
   * Run a `CREATE TABLE` with an extra outer retry budget. The base
   * `query()` already retries 3 times on fetch errors (~3.5s total), but a
   * failed CREATE is permanent corruption — every subsequent SELECT against
   * the missing table fails. Wrapping in an outer loop with longer backoff
   * (2s, 5s, then 10s) gives us ~17s of reach across transient network
   * blips before giving up. Failures still propagate; getApi() resets its
   * cache on init failure (openclaw plugin) so the next call retries the
   * whole init flow.
   */
  async createTableWithRetry(sql, label) {
    const OUTER_BACKOFFS_MS = [2e3, 5e3, 1e4];
    let lastErr = null;
    for (let attempt = 0; attempt <= OUTER_BACKOFFS_MS.length; attempt++) {
      try {
        await this.query(sql);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        log4(`CREATE TABLE "${label}" attempt ${attempt + 1}/${OUTER_BACKOFFS_MS.length + 1} failed: ${msg}`);
        if (attempt < OUTER_BACKOFFS_MS.length) {
          await sleep2(OUTER_BACKOFFS_MS[attempt]);
        }
      }
    }
    throw lastErr;
  }
  /** Create the memory table if it doesn't already exist. Heal missing columns on existing tables. */
  async ensureTable(name) {
    if (!MEMORY_COLUMNS.some((c) => c.name === SUMMARY_EMBEDDING_COL)) {
      throw new Error(`MEMORY_COLUMNS missing "${SUMMARY_EMBEDDING_COL}" (embeddings/columns.ts drift)`);
    }
    const tbl = sqlIdent(name ?? this.tableName);
    const tables = await this.listTables();
    if (!tables.includes(tbl)) {
      log4(`table "${tbl}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(tbl, MEMORY_COLUMNS), tbl);
      log4(`table "${tbl}" created`);
      if (!tables.includes(tbl))
        this._tablesCache = [...tables, tbl];
    }
    await this.healSchema(tbl, MEMORY_COLUMNS);
  }
  /** Create the sessions table (uses JSONB for message since every row is a JSON event). */
  async ensureSessionsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, SESSIONS_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, SESSIONS_COLUMNS);
    await this.ensureLookupIndex(safe, "path_creation_date", `("path", "creation_date")`);
  }
  /**
   * Create the skills table.
   *
   * One row per skill version. Workers INSERT a fresh row on every KEEP /
   * MERGE rather than UPDATE-ing in place, so the full version history is
   * recoverable. Uniqueness in the *current* state is by (project_key, name)
   * — newer rows shadow older ones at read time (ORDER BY version DESC).
   * This sidesteps the Deeplake UPDATE-coalescing quirk that bit the wiki
   * worker.
   */
  /**
   * Create the codebase table. One row per (org, workspace, repo, user,
   * worktree, commit) — see CODEBASE_COLUMNS for the schema. Healing
   * + index follow the same pattern as ensureSessionsTable.
   */
  async ensureCodebaseTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, CODEBASE_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, CODEBASE_COLUMNS);
    await this.ensureLookupIndex(safe, "codebase_identity", `("org_id", "workspace_id", "repo_slug", "user_id", "worktree_id", "commit_sha")`);
  }
  async ensureSkillsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, SKILLS_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, SKILLS_COLUMNS);
    await this.ensureLookupIndex(safe, "project_key_name", `("project_key", "name")`);
  }
  /**
   * Create the rules table.
   *
   * One row per rule version (same write pattern as skills): edits INSERT
   * a fresh row with version+1, reads pick latest per rule_id via
   * `ORDER BY version DESC LIMIT 1`. Sidesteps the Deeplake
   * UPDATE-coalescing quirk by never UPDATEing.
   */
  async ensureRulesTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, RULES_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, RULES_COLUMNS);
    await this.ensureLookupIndex(safe, "rule_id_version", `("rule_id", "version")`);
  }
  /**
   * Create the goals table.
   *
   * Backed by the VFS path convention memory/goal/<owner>/<status>/<goal_id>.md.
   * INSERT-only version-bumped: rm and mv operations translate to fresh
   * v=N+1 rows (status flips for mv → closed; rm is the same soft-close).
   * The (goal_id, version) index lets the VFS dispatch a cheap latest-row
   * read on cat / Read of a single goal.
   */
  async ensureGoalsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, GOALS_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, GOALS_COLUMNS);
    await this.ensureLookupIndex(safe, "goal_id_version", `("goal_id", "version")`);
    await this.ensureLookupIndex(safe, "owner_status", `("owner", "status")`);
  }
  /**
   * Create the kpis table.
   *
   * Backed by memory/kpi/<goal_id>/<kpi_id>.md. KPI rows do NOT carry
   * owner — ownership derives from the parent goal via logical join on
   * goal_id. INSERT-only version-bumped. (goal_id, kpi_id) index is the
   * canonical lookup the VFS uses on Read and Write.
   */
  async ensureKpisTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, KPIS_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, KPIS_COLUMNS);
    await this.ensureLookupIndex(safe, "goal_id_kpi_id", `("goal_id", "kpi_id")`);
  }
  /**
   * Create the docs table — per-file documentation kept fresh on code deltas.
   *
   * INSERT-only version-bumped (same write pattern as rules/skills): every
   * edit appends a fresh row with version+1, reads pick the latest per
   * doc_id via `ORDER BY version DESC LIMIT 1` (see src/docs/read.ts).
   * Sidesteps the Deeplake UPDATE-coalescing quirk by never UPDATEing.
   * The (doc_id, version) index is what the latest-row read scans.
   */
  async ensureDocsTable(name) {
    const safe = sqlIdent(name);
    const tables = await this.listTables();
    if (!tables.includes(safe)) {
      log4(`table "${safe}" not found, creating`);
      await this.createTableWithRetry(buildCreateTableSql(safe, DOCS_COLUMNS), safe);
      log4(`table "${safe}" created`);
      if (!tables.includes(safe))
        this._tablesCache = [...tables, safe];
    }
    await this.healSchema(safe, DOCS_COLUMNS);
    await this.ensureLookupIndex(safe, "doc_id_version", `("doc_id", "version")`);
  }
};

// dist/src/utils/repo-identity.js
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve as resolve3 } from "node:path";
var DEFAULT_PORTS = {
  http: "80",
  https: "443",
  ssh: "22",
  git: "9418"
};
function normalizeGitRemoteUrl(url) {
  let s = url.trim();
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  if (schemeMatch)
    s = s.slice(schemeMatch[0].length);
  if (!scheme) {
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp)
      s = `${scp[1]}/${scp[2]}`;
  }
  s = s.replace(/^[^@/]+@/, "");
  if (scheme && DEFAULT_PORTS[scheme]) {
    s = s.replace(new RegExp(`^([^/]+):${DEFAULT_PORTS[scheme]}(/|$)`), "$1$2");
  }
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}
function deriveProjectKey(cwd) {
  const absCwd = resolve3(cwd);
  const project = basename(absCwd) || "unknown";
  let signature = null;
  try {
    const raw = execSync("git config --get remote.origin.url", {
      cwd: absCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    signature = raw ? normalizeGitRemoteUrl(raw) : null;
  } catch {
  }
  const input = signature ?? absCwd;
  const key = createHash("sha1").update(input).digest("hex").slice(0, 16);
  return { key, project };
}

// dist/src/docs/branch-scope.js
var MAIN_SCOPE = "main";
var BRANCH_PREFIX = "b:";
function branchScope(branch) {
  return `${BRANCH_PREFIX}${branch}`;
}
function parseScope(scope) {
  if (scope && scope.startsWith(BRANCH_PREFIX)) {
    return { kind: "branch", branch: scope.slice(BRANCH_PREFIX.length) };
  }
  return { kind: "main" };
}
function currentBranch(git) {
  const out = git(["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  if (!out || out === "HEAD")
    return null;
  return out;
}
function trunkBranch(git) {
  const ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (ref) {
    const slash = ref.lastIndexOf("/");
    const name = slash >= 0 ? ref.slice(slash + 1) : ref;
    if (name)
      return name;
  }
  return "main";
}
function currentScope(git, trunk) {
  const branch = currentBranch(git);
  if (branch === null)
    return MAIN_SCOPE;
  const trunkName = trunk ?? trunkBranch(git);
  return branch === trunkName ? MAIN_SCOPE : branchScope(branch);
}
function pickByScopePrecedence(rows, readerScope) {
  let best = null;
  let bestRank = -1;
  for (const r of rows) {
    const s = r.scope || MAIN_SCOPE;
    const rank = s === readerScope ? 2 : s === MAIN_SCOPE ? 1 : 0;
    if (rank === 0)
      continue;
    if (best === null || rank > bestRank || rank === bestRank && r.version > best.version) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

// dist/src/docs/stable-read.js
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stableUnionRows(query, sql, opts = {}) {
  const idKey = opts.idKey ?? "id";
  const stableReads = Math.max(1, opts.stableReads ?? 3);
  const maxReads = Math.max(stableReads, opts.maxReads ?? 10);
  const delayMs = opts.delayMs ?? 0;
  const sleep3 = opts.sleep ?? defaultSleep;
  const union = /* @__PURE__ */ new Map();
  let stableStreak = 0;
  let reads = 0;
  while (reads < maxReads) {
    const rows = await query(sql);
    reads++;
    let grew = false;
    for (const row of rows) {
      const k = String(row[idKey] ?? "");
      if (k === "")
        continue;
      if (!union.has(k)) {
        union.set(k, row);
        grew = true;
      }
    }
    stableStreak = grew ? 0 : stableStreak + 1;
    if (stableStreak >= stableReads)
      break;
    if (reads < maxReads)
      await sleep3(delayMs);
  }
  opts.log?.(`stable-read: ${union.size} rows after ${reads} reads (streak ${stableStreak})`);
  return [...union.values()];
}

// dist/src/docs/read.js
function buildProjectFilter(opts) {
  const clauses = [];
  if (opts.project !== void 0) {
    clauses.push(`project = '${sqlStr(opts.project)}'`);
  } else if (opts.projectOrLegacy !== void 0) {
    clauses.push(`(project = '${sqlStr(opts.projectOrLegacy)}' OR project = '')`);
  }
  if (opts.scope !== void 0) {
    clauses.push(`scope = '${sqlStr(opts.scope)}'`);
  }
  return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
}
var SELECT_COLS = "id, doc_id, path, content, anchors, tier, status, project, version, created_at, updated_at, agent, plugin_version";
function isMissingColumnError2(err) {
  const m = err instanceof Error ? err.message : String(err);
  return /(does not exist|no such column|unknown column|undefined column)/i.test(m) && /(scope|source_fp|column)/i.test(m);
}
async function scopedUnion(query, buildSql) {
  const tiers = [`${SELECT_COLS}, scope, source_fp`, `${SELECT_COLS}, scope`, SELECT_COLS];
  let lastErr;
  for (let i = 0; i < tiers.length; i++) {
    try {
      return await stableUnionRows(query, buildSql(tiers[i]));
    } catch (e) {
      if (i === tiers.length - 1 || !isMissingColumnError2(e))
        throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
async function listDocs(query, tableName, opts = {}) {
  const safe = sqlIdent(tableName);
  const scoped = opts.readerScope !== void 0;
  const orderBy = "ORDER BY version DESC, updated_at DESC, id DESC";
  const rows = scoped ? await scopedUnion(query, (cols) => `SELECT ${cols} FROM "${safe}" ${orderBy}`) : await stableUnionRows(query, `SELECT ${SELECT_COLS} FROM "${safe}" ${orderBy}`);
  const candidates = /* @__PURE__ */ new Map();
  const latest = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const row = normalize(r);
    if (!row)
      continue;
    if (row.doc_id === "_meta")
      continue;
    if (opts.project !== void 0 && row.project !== opts.project)
      continue;
    if (opts.projectOrLegacy !== void 0 && row.project !== opts.projectOrLegacy && row.project !== "")
      continue;
    const key = `${row.project}\0${row.doc_id}`;
    if (scoped) {
      const list = candidates.get(key);
      if (list)
        list.push(row);
      else
        candidates.set(key, [row]);
      continue;
    }
    const prev = latest.get(key);
    if (!prev || row.version > prev.version || row.version === prev.version && (row.updated_at.localeCompare(prev.updated_at) > 0 || row.updated_at === prev.updated_at && row.id.localeCompare(prev.id) > 0)) {
      latest.set(key, row);
    }
  }
  if (scoped) {
    for (const [, list] of candidates) {
      const winner = pickByScopePrecedence(list, opts.readerScope);
      if (winner)
        latest.set(`${winner.project}\0${winner.doc_id}`, winner);
    }
  }
  const statusFilter = opts.status ?? "active";
  const filtered = [...latest.values()].filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter)
      return false;
    return true;
  });
  filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
  return filtered.slice(0, opts.limit ?? 200);
}
async function listDocMeta(query, tableName, opts = {}) {
  const safe = sqlIdent(tableName);
  const clauses = [];
  if (opts.dirPrefix !== void 0 && opts.dirPrefix !== "") {
    clauses.push(`doc_id LIKE '${sqlLike(opts.dirPrefix)}/%'`);
  }
  if (opts.project !== void 0) {
    clauses.push(`(project = '${sqlStr(opts.project)}' OR project = '')`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const scoped = opts.readerScope !== void 0;
  const baseCols = "id, doc_id, version, updated_at, status, tier";
  let rows;
  try {
    rows = await stableUnionRows(query, `SELECT ${scoped ? `${baseCols}, scope` : baseCols} FROM "${safe}"${where}`);
  } catch (e) {
    if (!scoped || !isMissingColumnError2(e))
      throw e;
    rows = await stableUnionRows(query, `SELECT ${baseCols} FROM "${safe}"${where}`);
  }
  const candidates = /* @__PURE__ */ new Map();
  const latest = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const doc_id = String(r.doc_id ?? "");
    if (doc_id === "")
      continue;
    if (doc_id === "_meta")
      continue;
    const vRaw = r.version;
    const version = typeof vRaw === "number" ? vRaw : Number(vRaw);
    if (!Number.isFinite(version))
      continue;
    const updated_at = String(r.updated_at ?? "");
    const tier = String(r.tier ?? "fast");
    const meta = { doc_id, version, updated_at, status: String(r.status ?? ""), tier: tier === "slow" ? "slow" : "fast" };
    if (scoped) {
      const cand = { ...meta, scope: String(r.scope || "main") };
      const list = candidates.get(doc_id);
      if (list)
        list.push(cand);
      else
        candidates.set(doc_id, [cand]);
      continue;
    }
    const prev = latest.get(doc_id);
    if (!prev || version > prev.version || version === prev.version && updated_at > prev.updated_at) {
      latest.set(doc_id, meta);
    }
  }
  if (scoped) {
    for (const [doc_id, list] of candidates) {
      const winner = pickByScopePrecedence(list, opts.readerScope);
      if (winner)
        latest.set(doc_id, { doc_id: winner.doc_id, version: winner.version, updated_at: winner.updated_at, status: winner.status, tier: winner.tier });
    }
  }
  return [...latest.values()];
}
async function listDocsByIds(query, tableName, docIds, opts = {}) {
  const ids = [...new Set(docIds.filter((d) => d !== ""))];
  if (ids.length === 0)
    return [];
  const safe = sqlIdent(tableName);
  const inList = ids.map((d) => `'${sqlStr(d)}'`).join(", ");
  const projFilter = buildProjectFilter(opts);
  const scoped = opts.readerScope !== void 0;
  const rows = scoped ? await scopedUnion(query, (cols) => `SELECT ${cols} FROM "${safe}" WHERE doc_id IN (${inList})${projFilter}`) : await stableUnionRows(query, `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id IN (${inList})${projFilter}`);
  const candidates = /* @__PURE__ */ new Map();
  const latest = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const row = normalize(r);
    if (!row)
      continue;
    if (scoped) {
      const list = candidates.get(row.doc_id);
      if (list)
        list.push(row);
      else
        candidates.set(row.doc_id, [row]);
      continue;
    }
    const prev = latest.get(row.doc_id);
    if (!prev || row.version > prev.version || row.version === prev.version && row.updated_at > prev.updated_at) {
      latest.set(row.doc_id, row);
    }
  }
  if (scoped) {
    for (const [doc_id, list] of candidates) {
      const winner = pickByScopePrecedence(list, opts.readerScope);
      if (winner)
        latest.set(doc_id, winner);
    }
  }
  return [...latest.values()];
}
async function getDocLatest(query, tableName, docId, opts = {}) {
  const safe = sqlIdent(tableName);
  const projFilter = buildProjectFilter(opts);
  if (opts.readerScope !== void 0) {
    const raw2 = await scopedUnion(query, (cols) => `SELECT ${cols} FROM "${safe}" WHERE doc_id = '${sqlStr(docId)}'${projFilter}`);
    const rows = raw2.map(normalize).filter((r) => r !== null);
    return pickByScopePrecedence(rows, opts.readerScope);
  }
  const raw = await stableUnionRows(query, `SELECT ${SELECT_COLS} FROM "${safe}" WHERE doc_id = '${sqlStr(docId)}'${projFilter}`);
  let best = null;
  for (const r of raw) {
    const row = normalize(r);
    if (!row)
      continue;
    if (best === null || row.version > best.version || row.version === best.version && (row.updated_at.localeCompare(best.updated_at) > 0 || row.updated_at === best.updated_at && row.id.localeCompare(best.id) > 0)) {
      best = row;
    }
  }
  return best;
}
function parseAnchors(raw) {
  let arr = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "")
      return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr))
    return [];
  const out = [];
  for (const item of arr) {
    if (item && typeof item === "object") {
      const sid = item.symbol_id;
      const hash = item.content_hash;
      if (typeof sid === "string" && typeof hash === "string") {
        out.push({ symbol_id: sid, content_hash: hash });
      }
    }
  }
  return out;
}
function normalize(row) {
  const vRaw = row.version;
  const version = typeof vRaw === "number" ? vRaw : typeof vRaw === "string" ? Number(vRaw) : NaN;
  if (!Number.isFinite(version))
    return null;
  const tier = String(row.tier ?? "fast");
  return {
    id: String(row.id ?? ""),
    doc_id: String(row.doc_id ?? ""),
    path: String(row.path ?? ""),
    content: String(row.content ?? ""),
    anchors: parseAnchors(row.anchors),
    tier: tier === "slow" ? "slow" : "fast",
    status: String(row.status ?? ""),
    project: String(row.project ?? ""),
    // `||` (not `??`): a stored empty scope is a legacy/unstamped row and must
    // resolve as main, not as a distinct "" identity that hides from precedence.
    scope: String(row.scope || "main"),
    source_fp: String(row.source_fp ?? "{}"),
    version,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    agent: String(row.agent ?? ""),
    plugin_version: String(row.plugin_version ?? "")
  };
}

// dist/src/docs/write.js
import { randomUUID as randomUUID2 } from "node:crypto";

// dist/src/embeddings/sql.js
function embeddingSqlLiteral(vec) {
  if (!vec || vec.length === 0)
    return "NULL";
  const parts = [];
  for (const v of vec) {
    if (!Number.isFinite(v))
      return "NULL";
    parts.push(String(v));
  }
  return `ARRAY[${parts.join(",")}]::float4[]`;
}

// dist/src/docs/write.js
function docRowId(project, scope, docId) {
  return `${project ?? ""}|${scope ?? "main"}|${docId}`;
}
var MAX_CONTENT_LENGTH = 5e4;
function assertValidContent(content) {
  if (content.length === 0)
    throw new Error("Doc content must not be empty");
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Doc content exceeds ${MAX_CONTENT_LENGTH} chars (got ${content.length})`);
  }
}
function serializeAnchors(anchors) {
  return JSON.stringify(anchors.map((a) => ({ symbol_id: a.symbol_id, content_hash: a.content_hash })));
}
async function insertDoc(query, tableName, input) {
  assertValidContent(input.content);
  if (input.doc_id.length === 0)
    throw new Error("Doc doc_id must not be empty");
  const safe = sqlIdent(tableName);
  const rowId = randomUUID2();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const anchors = serializeAnchors(input.anchors ?? []);
  const tier = input.tier ?? "fast";
  const sql = `INSERT INTO "${safe}" (id, doc_id, path, content, anchors, tier, status, project, scope, source_fp, version, created_at, updated_at, agent, plugin_version, content_embedding) VALUES ('${sqlStr(rowId)}', '${sqlStr(input.doc_id)}', '${sqlStr(input.path)}', E'${sqlStr(input.content)}', E'${sqlStr(anchors)}', '${sqlStr(tier)}', 'active', '${sqlStr(input.project ?? "")}', '${sqlStr(input.scope ?? "main")}', E'${sqlStr(input.source_fp ?? "{}")}', 1, '${sqlStr(now)}', '${sqlStr(now)}', '${sqlStr(input.agent ?? "manual")}', '${sqlStr(input.plugin_version ?? "")}', ${embeddingSqlLiteral(input.content_embedding)})`;
  await query(sql);
  return { doc_id: input.doc_id, version: 1 };
}
var WRITE_RETRIES = 3;
var WRITE_BACKOFF_MS = [500, 1500, 4e3];
function isTimeoutError2(err) {
  return err instanceof Error && /timeout/i.test(err.message);
}
async function upsertDoc(query, tableName, input, opts = {}) {
  assertValidContent(input.content);
  if (input.doc_id.length === 0)
    throw new Error("Doc doc_id must not be empty");
  const safe = sqlIdent(tableName);
  const scope = input.scope ?? "main";
  const id = docRowId(input.project, scope, input.doc_id);
  const anchors = serializeAnchors(input.anchors ?? []);
  const tier = input.tier ?? "fast";
  const retries = opts.retries ?? WRITE_RETRIES;
  const backoff = opts.backoffMs ?? WRITE_BACKOFF_MS;
  const sleep3 = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await query(`DELETE FROM "${safe}" WHERE id = '${sqlStr(id)}' OR (doc_id = '${sqlStr(input.doc_id)}' AND project = '${sqlStr(input.project ?? "")}' AND scope = '${sqlStr(scope)}')`);
      const sql = `INSERT INTO "${safe}" (id, doc_id, path, content, anchors, tier, status, project, scope, source_fp, version, created_at, updated_at, agent, plugin_version, content_embedding) VALUES ('${sqlStr(id)}', '${sqlStr(input.doc_id)}', '${sqlStr(input.path)}', E'${sqlStr(input.content)}', E'${sqlStr(anchors)}', '${sqlStr(tier)}', 'active', '${sqlStr(input.project ?? "")}', '${sqlStr(scope)}', E'${sqlStr(input.source_fp ?? "{}")}', 1, '${sqlStr(now)}', '${sqlStr(now)}', '${sqlStr(input.agent ?? "manual")}', '${sqlStr(input.plugin_version ?? "")}', ${embeddingSqlLiteral(input.content_embedding)})`;
      await query(sql);
      return { doc_id: input.doc_id, version: 1 };
    } catch (err) {
      if (!isTimeoutError2(err))
        throw err;
      lastErr = err;
      if (attempt === retries)
        break;
      await sleep3(backoff[Math.min(attempt, backoff.length - 1)]);
    }
  }
  throw lastErr ?? new Error("upsertDoc: exhausted retries");
}
async function editDoc(query, tableName, input, opts = {}) {
  const previous = await getDocLatest(query, tableName, input.doc_id, { project: opts.project, scope: opts.scope });
  if (!previous) {
    throw new Error(`Doc not found: ${input.doc_id}`);
  }
  return updateInPlace(query, tableName, previous, input);
}
async function setDoc(query, tableName, input, opts = {}) {
  const previous = await getDocLatest(query, tableName, input.doc_id, { project: opts.project, scope: opts.scope });
  if (!previous) {
    return insertDoc(query, tableName, {
      doc_id: input.doc_id,
      path: input.path,
      content: input.content,
      anchors: input.anchors,
      tier: input.tier,
      project: input.project,
      agent: input.agent,
      plugin_version: input.plugin_version,
      content_embedding: input.content_embedding
    });
  }
  return updateInPlace(query, tableName, previous, {
    doc_id: input.doc_id,
    content: input.content,
    anchors: input.anchors,
    tier: input.tier,
    status: input.status,
    path: input.path,
    project: input.project,
    agent: input.agent,
    plugin_version: input.plugin_version,
    content_embedding: input.content_embedding
  });
}
async function archiveDoc(query, tableName, input, opts = {}) {
  return editDoc(query, tableName, {
    doc_id: input.doc_id,
    status: "archived",
    agent: input.agent,
    plugin_version: input.plugin_version
  }, opts);
}
async function updateInPlace(query, tableName, previous, next) {
  const content = next.content ?? previous.content;
  assertValidContent(content);
  const safe = sqlIdent(tableName);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const nextVersion = previous.version + 1;
  const anchors = serializeAnchors(next.anchors ?? previous.anchors);
  const tier = next.tier ?? previous.tier;
  const status = next.status ?? previous.status;
  const path = next.path ?? previous.path;
  const project = next.project ?? previous.project;
  const sql = `UPDATE "${safe}" SET path = '${sqlStr(path)}', content = E'${sqlStr(content)}', anchors = E'${sqlStr(anchors)}', tier = '${sqlStr(tier)}', status = '${sqlStr(status)}', project = '${sqlStr(project)}', ${next.content_embedding !== void 0 ? `content_embedding = ${embeddingSqlLiteral(next.content_embedding)}, ` : next.content !== void 0 && next.content !== previous.content ? `content_embedding = NULL, ` : ""}${next.source_fp !== void 0 ? `source_fp = E'${sqlStr(next.source_fp)}', ` : ""}version = ${nextVersion}, updated_at = '${sqlStr(now)}', agent = '${sqlStr(next.agent ?? "manual")}', plugin_version = '${sqlStr(next.plugin_version ?? "")}' WHERE id = '${sqlStr(previous.id)}'`;
  await query(sql);
  return { doc_id: previous.doc_id, version: nextVersion };
}

// dist/src/docs/candidates.js
import { execFileSync } from "node:child_process";

// dist/src/graph/render/impact.js
var MAX_DEPTH = 25;
var DEP_RELATIONS = /* @__PURE__ */ new Set(["calls", "imports", "extends", "implements", "method_of"]);
function reverseBfs(snap, seeds, maxDepth = MAX_DEPTH) {
  const nodeIds = new Set(snap.nodes.map((n) => n.id));
  const incoming = /* @__PURE__ */ new Map();
  for (const e of snap.links) {
    if (!DEP_RELATIONS.has(e.relation))
      continue;
    if (!nodeIds.has(e.source))
      continue;
    const list = incoming.get(e.target);
    if (list)
      list.push(e);
    else
      incoming.set(e.target, [e]);
  }
  const depthOf = /* @__PURE__ */ new Map();
  const viaOf = /* @__PURE__ */ new Map();
  let frontier = [];
  for (const s of seeds) {
    if (!depthOf.has(s)) {
      depthOf.set(s, 0);
      frontier.push(s);
    }
  }
  frontier.sort();
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    depth++;
    const next = [];
    for (const id of frontier) {
      const edges = (incoming.get(id) ?? []).slice().sort((a, b) => a.source.localeCompare(b.source) || a.relation.localeCompare(b.relation));
      for (const e of edges) {
        if (depthOf.has(e.source))
          continue;
        depthOf.set(e.source, depth);
        viaOf.set(e.source, { rel: e.relation, from: id });
        next.push(e.source);
      }
    }
    next.sort();
    frontier = next;
  }
  return { depthOf, viaOf };
}
function impactedNodes(snap, seeds, opts) {
  return new Set(reverseBfs(snap, seeds, opts?.maxDepth).depthOf.keys());
}

// dist/src/docs/candidates.js
function defaultGit(cwd) {
  return (args) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return null;
    }
  };
}
function collect(out, into) {
  if (out === null)
    return;
  for (const line of out.split("\n")) {
    const f = line.trim();
    if (f)
      into.add(f);
  }
}
function changedFilesFromGit(cwd, git = defaultGit(cwd)) {
  const workingTree = git(["diff", "--name-only", "HEAD"]);
  if (workingTree === null)
    return null;
  const files = /* @__PURE__ */ new Set();
  collect(workingTree, files);
  collect(git(["ls-files", "--others", "--exclude-standard"]), files);
  collect(git(["diff", "--name-only", "HEAD~1", "HEAD"]), files);
  return [...files];
}
function expandToCandidateFiles(snap, changedFiles2) {
  const changed = new Set(changedFiles2);
  const out = new Set(changed);
  const seedIds = snap.nodes.filter((n) => changed.has(n.source_file)).map((n) => n.id);
  if (seedIds.length > 0) {
    const byId = new Map(snap.nodes.map((n) => [n.id, n]));
    for (const id of impactedNodes(snap, seedIds)) {
      const node = byId.get(id);
      if (node)
        out.add(node.source_file);
    }
  }
  return [...out];
}

// dist/src/docs/anchors.js
import { createHash as createHash2 } from "node:crypto";
import { readFileSync as readFileSync7 } from "node:fs";
import { join as join8 } from "node:path";
function parseSourceLocation(loc) {
  const m = loc.match(/^L(\d+)(?:-L?(\d+))?$/);
  if (!m)
    return null;
  const startLine = Number(m[1]);
  const endLine = m[2] ? Number(m[2]) : startLine;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine))
    return null;
  if (startLine < 1 || endLine < startLine)
    return null;
  return { startLine, endLine };
}
function readSymbolSource(node, repoRoot) {
  const loc = parseSourceLocation(node.source_location);
  if (!loc)
    return null;
  let text;
  try {
    text = readFileSync7(join8(repoRoot, node.source_file), "utf-8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (loc.endLine > lines.length)
    return null;
  return lines.slice(loc.startLine - 1, loc.endLine).join("\n");
}
function normalizeForHash(src, language) {
  let s = src;
  if (language === "python" || language === "ruby") {
    s = s.replace(/(^|\s)#.*$/gm, "$1");
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    s = s.replace(/(^|\s)\/\/.*$/gm, "$1");
  }
  return s.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "").join("\n");
}
function hashSource(src, language) {
  return createHash2("sha256").update(normalizeForHash(src, language)).digest("hex");
}
function computeSymbolHash(node, repoRoot) {
  const src = readSymbolSource(node, repoRoot);
  return src === null ? null : hashSource(src, node.language);
}
function buildAnchor(node, repoRoot) {
  const hash = computeSymbolHash(node, repoRoot);
  return hash === null ? null : { symbol_id: node.id, content_hash: hash };
}

// dist/src/docs/pool.js
async function runPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}
function isRateLimitError(err) {
  return err instanceof Error && /rate.?limit|429|overloaded|too many requests|quota/i.test(err.message);
}
async function withRateLimitRetry(fn, opts = {}) {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? [1e3, 4e3, 1e4];
  const sleep3 = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err))
        throw err;
      lastErr = err;
      if (attempt === retries)
        break;
      await sleep3(backoff[Math.min(attempt, backoff.length - 1)]);
    }
  }
  throw lastErr ?? new Error("withRateLimitRetry: exhausted retries");
}

// dist/src/docs/generate.js
var DOCUMENTABLE_KINDS = /* @__PURE__ */ new Set(["function", "class", "method", "interface", "type_alias", "enum"]);
var DEFAULT_EXCLUDE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.d.ts",
  "**/*.config.*",
  "**/index.ts",
  "**/index.js"
];
var BATCH_MARKER_RE = /<<<DOC file=(.+?)>>>[ \t]*\n?/;
function globToRegExp(glob) {
  if (glob.length > 512)
    throw new Error(`glob pattern too long (${glob.length} > 512 chars)`);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/")
          i++;
      } else {
        re += "[^/]*";
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
function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}
function selectTargets(snap, opts = {}) {
  const scope = opts.scope ?? "file";
  const excludes = [...DEFAULT_EXCLUDE_GLOBS, ...opts.exclude ?? []];
  const includes = opts.include ?? [];
  const docNodes = snap.nodes.filter((n) => DOCUMENTABLE_KINDS.has(n.kind));
  const keep = (file) => {
    if (includes.length > 0 && !matchesAny(file, includes))
      return false;
    if (matchesAny(file, excludes))
      return false;
    return true;
  };
  if (scope === "symbol") {
    return docNodes.filter((n) => keep(n.source_file)).map((n) => ({ doc_id: n.id, file: n.source_file, symbols: [n] }));
  }
  const byFile = /* @__PURE__ */ new Map();
  for (const n of docNodes) {
    if (!keep(n.source_file))
      continue;
    const list = byFile.get(n.source_file);
    if (list)
      list.push(n);
    else
      byFile.set(n.source_file, [n]);
  }
  return [...byFile.entries()].map(([file, symbols]) => ({ doc_id: file, file, symbols })).sort((a, b) => a.doc_id.localeCompare(b.doc_id));
}
function buildGeneratePrompt(input) {
  const syms = input.symbols.map((s) => `### ${s.id}
${s.signature ? s.signature + "\n" : ""}
\`\`\`
${s.source}
\`\`\``).join("\n\n");
  return [
    "You are writing concise internal documentation for ONE source file.",
    "Describe what the file is for and what its key symbols do \u2014 one short line per symbol.",
    "Be precise and grounded in the code below. Output ONLY markdown, no preamble, no outer code fence. Keep it under ~1500 characters.",
    "",
    `## File: ${input.file}`,
    "",
    "## Symbols",
    syms || "(none)"
  ].join("\n");
}
function renderSymbols(input) {
  return input.symbols.map((s) => `### ${s.id}
${s.signature ? s.signature + "\n" : ""}
\`\`\`
${s.source}
\`\`\``).join("\n\n") || "(none)";
}
function buildBatchGeneratePrompt(inputs) {
  const blocks = inputs.map((input) => [`<<<DOC file=${input.file}>>>`, `## File: ${input.file}`, "", "## Symbols", renderSymbols(input)].join("\n"));
  return [
    "You are writing concise internal documentation for MULTIPLE source files.",
    "For EACH file below, output its doc PREFIXED by a line EXACTLY of the form:",
    "<<<DOC file=RELATIVE/PATH.ts>>>",
    "using the exact path shown for that file, then the markdown doc (what the file",
    "is for + one short line per key symbol, under ~1200 characters).",
    "Output ONLY these marker+doc sections, in order. No preamble, no outer code fence.",
    "",
    "=== FILES ===",
    "",
    blocks.join("\n\n----------\n\n")
  ].join("\n");
}
function parseBatchDocs(response, inputs) {
  const wanted = new Map(inputs.map((i) => [i.file, i.doc_id]));
  const out = /* @__PURE__ */ new Map();
  const marker = new RegExp(BATCH_MARKER_RE.source, "g");
  const matches = [...response.matchAll(marker)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const file = m[1].trim();
    const docId = wanted.get(file);
    if (!docId)
      continue;
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : response.length;
    const body = response.slice(start, end).trim();
    if (body)
      out.set(docId, body);
  }
  return out;
}
function defaultVfsPath(project, docId) {
  return `/docs/${project || "default"}/${docId}.md`;
}
async function generateDocs(args) {
  const project = args.project ?? "";
  let targets = selectTargets(args.snap, { scope: args.scope, include: args.include, exclude: args.exclude });
  if (!args.force)
    targets = targets.filter((t) => !args.existing.has(t.doc_id));
  if (args.limit !== void 0)
    targets = targets.slice(0, args.limit);
  const outcomes = [];
  const prep = (t) => {
    const symInput = [];
    const anchors = [];
    for (const n of t.symbols) {
      const source = readSymbolSource(n, args.repoRoot);
      const anchor = buildAnchor(n, args.repoRoot);
      if (source !== null)
        symInput.push({ id: n.id, signature: n.signature, source });
      if (anchor)
        anchors.push(anchor);
    }
    if (anchors.length === 0) {
      outcomes.push({ doc_id: t.doc_id, status: "skipped", reason: "no readable symbols to anchor" });
      return null;
    }
    return { input: { doc_id: t.doc_id, file: t.file, symbols: symInput }, anchors };
  };
  const writeDoc = async (docId, content, anchors) => {
    if (content.trim() === "") {
      outcomes.push({ doc_id: docId, status: "failed", reason: "empty content" });
      return;
    }
    try {
      const content_embedding = args.embed ? await args.embed(content) ?? void 0 : void 0;
      await upsertDoc(args.query, args.tableName, {
        doc_id: docId,
        path: defaultVfsPath(project, docId),
        content,
        anchors,
        tier: "fast",
        project,
        agent: args.agent ?? "docs-generate",
        plugin_version: args.pluginVersion,
        content_embedding
      });
      outcomes.push({ doc_id: docId, status: "created" });
    } catch (err) {
      outcomes.push({ doc_id: docId, status: "failed", reason: `write failed: ${err.message}` });
    }
  };
  const genSingle = async (input, anchors) => {
    let content;
    try {
      content = await args.generate(input);
    } catch (err) {
      outcomes.push({ doc_id: input.doc_id, status: "failed", reason: `generate failed: ${err.message}` });
      return;
    }
    await writeDoc(input.doc_id, content, anchors);
  };
  const concurrency = args.concurrency ?? 4;
  const batchSize = args.batchSize ?? 1;
  if (batchSize > 1 && args.batchGenerate) {
    const prepped = targets.map(prep).filter((p) => p !== null);
    const batches = [];
    for (let i = 0; i < prepped.length; i += batchSize)
      batches.push(prepped.slice(i, i + batchSize));
    const batchGen = args.batchGenerate;
    await runPool(batches, concurrency, async (batch) => {
      let map;
      try {
        map = await batchGen(batch.map((b) => b.input));
      } catch {
        map = /* @__PURE__ */ new Map();
      }
      for (const b of batch) {
        const content = map.get(b.input.doc_id);
        if (content && content.trim() !== "")
          await writeDoc(b.input.doc_id, content, b.anchors);
        else
          await genSingle(b.input, b.anchors);
      }
    });
  } else {
    await runPool(targets, concurrency, async (t) => {
      const p = prep(t);
      if (p)
        await genSingle(p.input, p.anchors);
    });
  }
  return {
    outcomes,
    targets: targets.length,
    created: outcomes.filter((o) => o.status === "created").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length
  };
}

// dist/src/docs/wiki-generate.js
import { readFileSync as readFileSync8, statSync as statSync2 } from "node:fs";
import { join as join9 } from "node:path";

// dist/src/docs/fingerprint.js
function computeFingerprintAt(git, ref, files) {
  const fp = {};
  if (files.length === 0)
    return fp;
  const out = git(["ls-tree", ref, "--", ...files]);
  if (out === null)
    return fp;
  for (const line of out.split("\n")) {
    const tab = line.indexOf("	");
    if (tab < 0)
      continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const path = line.slice(tab + 1);
    if (meta.length >= 3 && meta[1] === "blob" && path)
      fp[path] = meta[2];
  }
  return fp;
}
function computeFingerprint(git, files) {
  return computeFingerprintAt(git, "HEAD", files);
}
function workingTreeClean(git, files) {
  if (files.length === 0)
    return true;
  const out = git(["status", "--porcelain", "--", ...files]);
  if (out === null)
    return true;
  return out.trim() === "";
}
function sourcePushed(git, files, branch) {
  if (files.length === 0)
    return true;
  const head = computeFingerprint(git, files);
  const origin = computeFingerprintAt(git, `origin/${branch}`, files);
  return isFresh(head, origin);
}
function serializeFingerprint(fp) {
  const sorted = {};
  for (const k of Object.keys(fp).sort())
    sorted[k] = fp[k];
  return JSON.stringify(sorted);
}
function parseFingerprint(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string")
        out[k] = v;
    }
    return out;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      return parseFingerprint(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}
function changedFiles(a, b) {
  const changed = [];
  const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys)
    if (a[k] !== b[k])
      changed.push(k);
  return changed.sort();
}
function isFresh(stored, current) {
  return changedFiles(stored, current).length === 0;
}

// dist/src/docs/wiki-groups.js
var DEFAULT_MAX_FILES = 40;
function keyFor(file, depth) {
  const parts = file.split("/");
  if (parts.length <= depth)
    return parts.slice(0, -1).join("/") || parts[0];
  return parts.slice(0, depth).join("/");
}
function baseDepth(file) {
  return file.split("/")[0] === "src" ? 3 : 2;
}
function groupFilesBySubsystem(files, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const groups = /* @__PURE__ */ new Map();
  for (const f of files) {
    const key = keyFor(f, baseDepth(f));
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [key, members] of groups) {
    if (members.length <= maxFiles) {
      out.set(key, members);
      continue;
    }
    const depth = key.split("/").length + 1;
    for (const f of members) {
      const deeper = keyFor(f, depth);
      const target = deeper === f ? key : deeper;
      const list = out.get(target) ?? [];
      list.push(f);
      out.set(target, list);
    }
  }
  return [...out.entries()].map(([key, members]) => ({ key, files: [...members].sort() })).sort((a, b) => a.key.localeCompare(b.key));
}

// dist/src/docs/wiki-generate.js
var WIKI_DOC_PREFIX = "wiki/";
function wikiDocId(key) {
  return `${WIKI_DOC_PREFIX}${key}`;
}
var DEFAULT_CHUNK_CHARS = 12e4;
var MIN_GROUP_FILES = 3;
var MIN_GROUP_CHARS = 8e3;
function splitOversizedFile(s, maxChars) {
  if (s.content.length <= maxChars)
    return [s];
  const parts = [];
  const total = Math.ceil(s.content.length / maxChars);
  for (let i = 0; i < total; i++) {
    parts.push({
      file: `${s.file} [part ${i + 1}/${total}]`,
      content: s.content.slice(i * maxChars, (i + 1) * maxChars)
    });
  }
  return parts;
}
function chunkFiles(sources, chunkChars = DEFAULT_CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const raw of sources) {
    for (const s of splitOversizedFile(raw, chunkChars)) {
      const len = s.content.length + s.file.length + 32;
      if (current.length > 0 && size + len > chunkChars) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(s);
      size += len;
    }
  }
  if (current.length > 0)
    chunks.push(current);
  return chunks;
}
function renderSources(sources) {
  return sources.map((s) => `### ${s.file}
\`\`\`
${s.content}
\`\`\``).join("\n\n");
}
var PAGE_STYLE = [
  "Write for an engineer new to this subsystem. Cover: what the subsystem is for,",
  "how its pieces fit together (data flow, who calls whom), and any surprising",
  "behavior. Use `## ` section headings.",
  "EVIDENCE RULE: state ONLY facts you can tie to a specific file and symbol you",
  "actually saw. Name the file when you attribute behavior to it. If you did not",
  "see the code for a claim, do not make the claim. Never state general rules or",
  'invariants ("X is immutable", "Y rejects Z", "almost everything goes through W")',
  "unless a specific line you saw says exactly that \u2014 prefer describing what one",
  "named function does over generalizing across the subsystem.",
  'NEVER cite line numbers or numeric counts ("line 887", "~60 methods") \u2014 line',
  "numbers rot with every commit and you cannot know them reliably; anchor claims",
  "to file + symbol names only.",
  "Do NOT include a file listing section; one is appended mechanically.",
  "Output ONLY markdown, no preamble, no outer code fence. Keep it under ~4000 characters."
].join("\n");
function buildWikiPagePrompt(key, sources) {
  return [
    `You are writing an internal wiki page for the subsystem \`${key}\`.`,
    PAGE_STYLE,
    "",
    "=== SOURCE ===",
    "",
    renderSources(sources)
  ].join("\n");
}
function buildWikiNotesPrompt(key, sources, chunkIdx, chunkTotal) {
  return [
    `You are reading part ${chunkIdx + 1} of ${chunkTotal} of the subsystem \`${key}\` to prepare notes for a wiki page.`,
    "For each file: 1-3 bullet points on its responsibility and how it connects to the",
    "rest (imports/exports/calls). Note cross-file flows you can SEE in this code.",
    "Every bullet must name the file and symbol it comes from \u2014 the synthesis step",
    "can only trust attributed notes. Do not generalize beyond this chunk.",
    "Never record line numbers (they rot and mislead the synthesis); file + symbol only.",
    "Be terse and factual \u2014 these notes feed a synthesis step, not humans.",
    "Output ONLY markdown bullets grouped under `### <file>` headings.",
    "",
    "=== SOURCE ===",
    "",
    renderSources(sources)
  ].join("\n");
}
function buildWikiSynthesisPrompt(key, notes) {
  return [
    `You are writing an internal wiki page for the subsystem \`${key}\`,`,
    "synthesized from the reading notes below (taken across the whole subsystem).",
    "The notes are your ONLY source: keep every claim attributed to the file the",
    "note attributes it to \u2014 never move behavior to a different file, and never",
    "merge two notes into a broader rule neither of them states.",
    PAGE_STYLE,
    "",
    "=== NOTES ===",
    "",
    notes.map((n, i) => `--- notes part ${i + 1} ---
${n}`).join("\n\n")
  ].join("\n");
}
var REFUSAL_RE = /\b(I can only|I cannot|I can't|I'm unable|I am unable|I don't have|I do not have|could you (provide|share)|please (provide|share)|as an AI)\b/i;
function validateWikiNarrative(narrative) {
  if (narrative.trim() === "")
    return { ok: false, reason: "empty content" };
  if (REFUSAL_RE.test(narrative))
    return { ok: false, reason: "model refused instead of writing the page" };
  if (!/^##? /m.test(narrative))
    return { ok: false, reason: "no markdown section headings \u2014 not a page" };
  return { ok: true };
}
var FILES_INDEX_HEADER = "## Files";
function stripFilesIndex(content) {
  return content.replace(/^## Files\s*$[\s\S]*?(?=^## |\n*$(?![\s\S]))/gm, "").trimEnd();
}
function appendFilesIndex(narrative, files) {
  const index = [FILES_INDEX_HEADER, "", ...files.map((f) => `- \`${f}\``)].join("\n");
  return `${stripFilesIndex(narrative)}

${index}
`;
}
function parseFilesIndex(content) {
  const m = /^## Files\s*$([\s\S]*?)(?=^## |\n*$(?![\s\S]))/m.exec(content);
  if (!m)
    return [];
  const files = [];
  for (const line of m[1].split("\n")) {
    const item = /^- `(.+)`\s*$/.exec(line.trim());
    if (item)
      files.push(item[1]);
  }
  return files;
}
function collectWikiAnchors(snap, files, repoRoot) {
  const wanted = new Set(files);
  const anchors = [];
  for (const t of selectTargets(snap, { scope: "file", include: [...wanted] })) {
    if (!wanted.has(t.file))
      continue;
    for (const node of t.symbols) {
      const a = buildAnchor(node, repoRoot);
      if (a)
        anchors.push(a);
    }
  }
  return anchors;
}
function selectWikiGroups(snap, opts = {}) {
  const targets = selectTargets(snap, { scope: "file", include: opts.include, exclude: opts.exclude });
  return groupFilesBySubsystem(targets.map((t) => t.file), { maxFiles: opts.maxFiles });
}
function defaultWikiVfsPath(project, key) {
  return `/docs/${project || "default"}/wiki/${key}.md`;
}
function wikiGroupEligible(files, repoRoot, minFiles = MIN_GROUP_FILES, minChars = MIN_GROUP_CHARS) {
  let total = 0;
  let present = 0;
  for (const f of files) {
    try {
      total += statSync2(join9(repoRoot, f)).size;
      present++;
    } catch {
    }
  }
  return !(present < minFiles && total < minChars);
}
async function generateWikiPages(args) {
  const project = args.project ?? "";
  const scope = args.scope ?? "main";
  let groups = selectWikiGroups(args.snap, {
    include: args.include,
    exclude: args.exclude,
    maxFiles: args.maxFilesPerGroup
  });
  if (!args.force)
    groups = groups.filter((g) => !args.existing.has(wikiDocId(g.key)));
  if (args.limit !== void 0)
    groups = groups.slice(0, args.limit);
  const outcomes = [];
  await runPool(groups, args.concurrency ?? 2, async (group) => {
    const docId = wikiDocId(group.key);
    const sources = [];
    for (const file of group.files) {
      try {
        sources.push({ file, content: readFileSync8(join9(args.repoRoot, file), "utf-8") });
      } catch {
      }
    }
    if (sources.length === 0) {
      outcomes.push({ doc_id: docId, key: group.key, files: group.files.length, chunks: 0, status: "skipped", reason: "no readable member sources" });
      return;
    }
    const totalChars = sources.reduce((n, s) => n + s.content.length, 0);
    if (sources.length < (args.minGroupFiles ?? MIN_GROUP_FILES) && totalChars < (args.minGroupChars ?? MIN_GROUP_CHARS)) {
      outcomes.push({ doc_id: docId, key: group.key, files: group.files.length, chunks: 0, status: "skipped", reason: `below min size (${sources.length} file(s), ${totalChars} chars)` });
      return;
    }
    const chunks = chunkFiles(sources, args.chunkChars ?? DEFAULT_CHUNK_CHARS);
    const runPage = args.runPage ?? args.run;
    let narrative;
    try {
      if (chunks.length === 1) {
        narrative = await runPage(buildWikiPagePrompt(group.key, chunks[0]));
      } else {
        const notes = [];
        for (let i = 0; i < chunks.length; i++) {
          notes.push(await args.run(buildWikiNotesPrompt(group.key, chunks[i], i, chunks.length)));
        }
        narrative = await runPage(buildWikiSynthesisPrompt(group.key, notes));
      }
    } catch (err) {
      outcomes.push({ doc_id: docId, key: group.key, files: group.files.length, chunks: chunks.length, status: "failed", reason: `generate failed: ${err.message}` });
      return;
    }
    const valid = validateWikiNarrative(narrative);
    if (!valid.ok) {
      outcomes.push({ doc_id: docId, key: group.key, files: group.files.length, chunks: chunks.length, status: "failed", reason: valid.reason });
      return;
    }
    const content = appendFilesIndex(narrative, group.files);
    const anchors = collectWikiAnchors(args.snap, group.files, args.repoRoot);
    try {
      const content_embedding = args.embed ? await args.embed(content) ?? void 0 : void 0;
      const source_fp = serializeFingerprint(computeFingerprint(defaultGit(args.repoRoot), group.files));
      await upsertDoc(args.query, args.tableName, {
        doc_id: docId,
        path: defaultWikiVfsPath(project, group.key),
        content,
        anchors,
        tier: "slow",
        project,
        scope,
        source_fp,
        agent: args.agent ?? "docs-wiki",
        plugin_version: args.pluginVersion,
        content_embedding
      });
      outcomes.push({ doc_id: docId, key: group.key, files: group.files.length, chunks: chunks.length, status: "created" });
    } catch (err) {
      outcomes.push({ doc_id: docId, key: group.key, files: group.files.length, chunks: chunks.length, status: "failed", reason: `write failed: ${err.message}` });
    }
  });
  return {
    outcomes,
    groups: groups.length,
    created: outcomes.filter((o) => o.status === "created").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length
  };
}

// dist/src/docs/gate.js
var DEFAULT_MAX_CHANGED_LINES = 40;
var GATE_MAX_CONTENT_LENGTH = 5e4;
function countChangedLines(prev, next) {
  const a = prev === "" ? [] : prev.split("\n");
  const b = next === "" ? [] : next.split("\n");
  const n = a.length;
  const m = b.length;
  if (n === 0)
    return m;
  if (m === 0)
    return n;
  let prevRow = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const curRow = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      curRow[j] = a[i - 1] === b[j - 1] ? prevRow[j - 1] + 1 : Math.max(prevRow[j], curRow[j - 1]);
    }
    prevRow = curRow;
  }
  const lcs = prevRow[m];
  return n - lcs + (m - lcs);
}
function gateDocEdit(input) {
  const reasons = [];
  const tooLong = input.newContent.length > GATE_MAX_CONTENT_LENGTH;
  if (input.newContent.length === 0) {
    reasons.push("proposed content is empty");
  }
  if (tooLong) {
    reasons.push(`proposed content exceeds ${GATE_MAX_CONTENT_LENGTH} chars (got ${input.newContent.length})`);
  }
  if (input.tier === "slow" && !input.allowSlow) {
    reasons.push("slow-tier docs are human-curated; automatic refresh is not allowed");
  }
  const nodeIds = new Set(input.snap.nodes.map((n) => n.id));
  for (const a of input.newAnchors) {
    if (!nodeIds.has(a.symbol_id)) {
      reasons.push(`anchor references a symbol absent from the graph: ${a.symbol_id}`);
    }
  }
  let changedLines = 0;
  if (!tooLong) {
    changedLines = countChangedLines(input.prevContent, input.newContent);
    const budget = input.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
    if (changedLines > budget) {
      reasons.push(`edit exceeds the bounded-change budget: ${changedLines} > ${budget} lines`);
    }
  }
  return { ok: reasons.length === 0, reasons, changedLines };
}

// dist/src/docs/refresh.js
function buildRefreshPrompt(ctx) {
  const changed = ctx.changedSymbols.map((s) => `### ${s.symbol_id}
${s.signature ? s.signature + "\n" : ""}
\`\`\`
${s.source}
\`\`\``).join("\n\n");
  return [
    "You are updating ONE internal documentation file so it matches the code again.",
    "The code below changed; the current doc may now be inaccurate.",
    "",
    "RULES:",
    "- Make the SMALLEST edit that restores accuracy. Do NOT rewrite the whole doc.",
    "- Preserve the existing structure, headings, and any sections unrelated to the change.",
    "- Output ONLY the full updated markdown body. No preamble, no code fences around the whole thing.",
    "",
    `## Current doc (${ctx.doc.doc_id})`,
    ctx.doc.content,
    "",
    "## Code that changed (current source)",
    changed || "(no symbol source available)"
  ].join("\n");
}
function reanchor(doc, nodeById, repoRoot) {
  const out = [];
  for (const a of doc.anchors) {
    const node = nodeById.get(a.symbol_id);
    if (!node)
      continue;
    const fresh = buildAnchor(node, repoRoot);
    if (fresh)
      out.push(fresh);
  }
  return out;
}
function gatherChangedSymbols(reasons, nodeById, repoRoot) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const r of reasons) {
    if (seen.has(r.symbol_id))
      continue;
    seen.add(r.symbol_id);
    const node = nodeById.get(r.symbol_id);
    if (!node)
      continue;
    const source = readSymbolSource(node, repoRoot);
    if (source === null)
      continue;
    out.push({ symbol_id: r.symbol_id, signature: node.signature, source });
  }
  return out;
}
async function refreshDocs(args) {
  const nodeById = new Map(args.snap.nodes.map((n) => [n.id, n]));
  const outcomes = [];
  await runPool(args.impacted, args.concurrency ?? 4, async (imp) => {
    const doc = args.docsById.get(imp.doc_id);
    if (!doc) {
      outcomes.push({ doc_id: imp.doc_id, status: "skipped", reasons: ["no current doc row"] });
      return;
    }
    if (doc.tier === "slow") {
      outcomes.push({
        doc_id: imp.doc_id,
        status: "rejected",
        reasons: ["slow-tier docs are human-curated; automatic refresh is not allowed"]
      });
      return;
    }
    const newAnchors = reanchor(doc, nodeById, args.repoRoot);
    if (doc.anchors.length > 0 && newAnchors.length === 0) {
      const res2 = await archiveDoc(args.query, args.tableName, {
        doc_id: doc.doc_id,
        agent: args.agent ?? "docs-refresh",
        plugin_version: args.pluginVersion
      }, { project: doc.project });
      outcomes.push({
        doc_id: imp.doc_id,
        status: "archived",
        version: res2.version,
        reasons: ["all anchored symbols gone (file deleted/renamed)"]
      });
      return;
    }
    const changedSymbols = gatherChangedSymbols(imp.reasons, nodeById, args.repoRoot);
    let newContent;
    try {
      newContent = await withRateLimitRetry(() => args.generate({ doc, reasons: imp.reasons, changedSymbols }));
    } catch (err) {
      outcomes.push({ doc_id: imp.doc_id, status: "skipped", reasons: [`generate failed: ${err.message}`] });
      return;
    }
    const gate = gateDocEdit({
      tier: doc.tier,
      prevContent: doc.content,
      newContent,
      newAnchors,
      snap: args.snap,
      maxChangedLines: args.maxChangedLines
    });
    if (!gate.ok) {
      outcomes.push({ doc_id: imp.doc_id, status: "rejected", reasons: gate.reasons });
      return;
    }
    const content_embedding = args.embed ? await args.embed(newContent).catch(() => null) ?? void 0 : void 0;
    const res = await setDoc(args.query, args.tableName, {
      doc_id: doc.doc_id,
      path: doc.path,
      content: newContent,
      anchors: newAnchors,
      tier: doc.tier,
      project: doc.project,
      agent: args.agent ?? "docs-refresh",
      plugin_version: args.pluginVersion,
      content_embedding
    }, { project: doc.project });
    outcomes.push({ doc_id: imp.doc_id, status: "refreshed", version: res.version });
  });
  return {
    outcomes,
    refreshed: outcomes.filter((o) => o.status === "refreshed").length,
    rejected: outcomes.filter((o) => o.status === "rejected").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    archived: outcomes.filter((o) => o.status === "archived").length
  };
}

// dist/src/docs/refresh-llm.js
import { execFileSync as execFileSync3 } from "node:child_process";

// dist/src/utils/resolve-cli-bin.js
import { execFileSync as execFileSync2 } from "node:child_process";
import { homedir as homedir7 } from "node:os";
import { join as join10 } from "node:path";
function resolveCliBin(cli, fallback) {
  const isWin = process.platform === "win32";
  try {
    const out = execFileSync2(isWin ? "where" : "which", [cli], { encoding: "utf-8" });
    const matches = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (matches.length > 0) {
      if (!isWin)
        return matches[0];
      return matches.find((m) => m.toLowerCase().endsWith(".exe")) ?? matches.find((m) => /\.(cmd|bat)$/i.test(m)) ?? matches[0];
    }
  } catch {
  }
  if (fallback !== void 0)
    return fallback;
  const local = join10(homedir7(), ".claude", "local", cli);
  return isWin ? `${local}.cmd` : local;
}
function binNeedsShell(bin) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

// dist/src/hooks/wiki-worker-spawn.js
var CLAUDE_FLAGS = [
  "--no-session-persistence",
  "--model",
  "haiku",
  "--permission-mode",
  "bypassPermissions"
];
function buildClaudeInvocation(claudeBin, prompt) {
  if (binNeedsShell(claudeBin)) {
    return {
      file: claudeBin,
      args: ["-p", ...CLAUDE_FLAGS],
      options: { input: prompt, stdio: ["pipe", "pipe", "pipe"], shell: true }
    };
  }
  return {
    file: claudeBin,
    args: ["-p", prompt, ...CLAUDE_FLAGS],
    options: { stdio: ["ignore", "pipe", "pipe"] }
  };
}
function buildTrailingPromptInvocation(bin, flags, prompt) {
  if (binNeedsShell(bin)) {
    return {
      file: bin,
      args: [...flags],
      options: { input: prompt, stdio: ["pipe", "pipe", "pipe"], shell: true }
    };
  }
  return {
    file: bin,
    args: [...flags, prompt],
    options: { stdio: ["ignore", "pipe", "pipe"] }
  };
}
function buildStdinPromptInvocation(bin, flags, prompt) {
  return {
    file: bin,
    args: [...flags],
    options: {
      input: prompt,
      stdio: ["pipe", "pipe", "pipe"],
      ...binNeedsShell(bin) ? { shell: true } : {}
    }
  };
}
function buildClaudeStdinInvocation(claudeBin, prompt) {
  return buildStdinPromptInvocation(claudeBin, ["-p", ...CLAUDE_FLAGS], prompt);
}

// dist/src/docs/refresh-llm.js
function unwrapModelOutput(raw) {
  const text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  return fence ? fence[1].trim() : text;
}
function codexSpec(env) {
  const model = env.HIVEMIND_DOCS_CODEX_MODEL;
  const flags = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    ...model && model.trim() !== "" ? ["-m", model] : [],
    "-c",
    'model_reasoning_effort="low"',
    "-"
  ];
  return { label: "codex", bin: "codex", build: (b, p) => buildStdinPromptInvocation(b, flags, p) };
}
var REGISTRY = {
  claude: () => ({ label: "claude", bin: "claude", build: (b, p) => buildClaudeStdinInvocation(b, p) }),
  codex: codexSpec,
  pi: (env) => ({
    label: "pi",
    bin: "pi",
    // No provider/model defaults: pi uses whatever the user logged into
    // (forcing e.g. google would break an anthropic-OAuth login — verified
    // live). Env overrides remain for explicit pinning.
    build: (b, p) => buildTrailingPromptInvocation(b, [
      "--print",
      ...env.HIVEMIND_PI_PROVIDER ? ["--provider", env.HIVEMIND_PI_PROVIDER] : [],
      ...env.HIVEMIND_PI_MODEL ? ["--model", env.HIVEMIND_PI_MODEL] : []
    ], p)
  }),
  cursor: (env) => ({
    label: "cursor",
    bin: "cursor-agent",
    build: (b, p) => buildTrailingPromptInvocation(b, [
      "--print",
      "--model",
      env.HIVEMIND_CURSOR_MODEL ?? "auto",
      "--force",
      "--output-format",
      "text"
    ], p)
  })
};
function detectHostAgent(resolve4 = tryResolveCliBin) {
  for (const name of ["claude", "codex", "pi", "cursor"]) {
    const spec = REGISTRY[name]({});
    if (resolve4(spec.bin) !== null)
      return name;
  }
  throw new Error("No host agent CLI found for doc generation (looked for: claude, codex, pi, cursor-agent). Install one, or set HIVEMIND_DOCS_LLM_AGENT / HIVEMIND_DOCS_LLM_BIN explicitly.");
}
function tryResolveCliBin(bin) {
  try {
    return resolveCliBin(bin);
  } catch {
    return null;
  }
}
function knownDocsAgents() {
  return ["claude", "codex", "pi", "cursor"];
}
function detectAvailableAgents(resolve4 = tryResolveCliBin) {
  return knownDocsAgents().filter((name) => resolve4(REGISTRY[name]({}).bin) !== null);
}
function resolvePageLlmSpec(env = process.env) {
  const base = resolveDocLlmSpec(env);
  if (base.label === "claude") {
    const model = env.HIVEMIND_DOCS_PAGE_MODEL ?? "sonnet";
    const flags = ["-p", "--no-session-persistence", "--model", model, "--permission-mode", "bypassPermissions"];
    return { label: `claude:${model}`, bin: base.bin, build: (b, p) => buildStdinPromptInvocation(b, flags, p) };
  }
  if (base.label === "codex") {
    const model = env.HIVEMIND_DOCS_CODEX_MODEL;
    const flags = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      ...model && model.trim() !== "" ? ["-m", model] : [],
      "-c",
      'model_reasoning_effort="medium"',
      "-"
    ];
    return { label: "codex:medium", bin: base.bin, build: (b, p) => buildStdinPromptInvocation(b, flags, p) };
  }
  return base;
}
function makeHostPageRunPrompt(timeoutMs = 3e5, env = process.env) {
  const spec = resolvePageLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (prompt) => runHostPrompt(spec, bin, prompt, timeoutMs);
}
function resolveDocLlmSpec(env = process.env) {
  const customBin = env.HIVEMIND_DOCS_LLM_BIN;
  if (customBin && customBin.trim() !== "") {
    const flags = (env.HIVEMIND_DOCS_LLM_FLAGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const viaStdin = env.HIVEMIND_DOCS_LLM_STDIN === "1";
    return {
      label: `custom:${customBin}`,
      bin: customBin,
      build: (b, p) => viaStdin ? buildStdinPromptInvocation(b, flags, p) : buildTrailingPromptInvocation(b, flags, p)
    };
  }
  const agent = (env.HIVEMIND_DOCS_LLM_AGENT ?? getDocsLlmAgent() ?? detectHostAgent()).toLowerCase();
  const spec = REGISTRY[agent]?.(env);
  if (!spec) {
    throw new Error(`Unknown HIVEMIND_DOCS_LLM_AGENT="${agent}". Known: ${Object.keys(REGISTRY).join(", ")}. For any other CLI set HIVEMIND_DOCS_LLM_BIN (and HIVEMIND_DOCS_LLM_FLAGS).`);
  }
  return spec;
}
function runHostPrompt(spec, bin, prompt, timeoutMs = 12e4) {
  const inv = spec.build(bin, prompt);
  const out = execFileSync3(inv.file, inv.args, {
    ...inv.options,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, HIVEMIND_WIKI_WORKER: "1", HIVEMIND_CAPTURE: "false" }
  });
  return unwrapModelOutput((out ?? "").toString());
}
function makeHostGenerate(timeoutMs = 12e4, env = process.env) {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (ctx) => runHostPrompt(spec, bin, buildRefreshPrompt(ctx), timeoutMs);
}
function makeHostGenerateDoc(timeoutMs = 12e4, env = process.env) {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (input) => runHostPrompt(spec, bin, buildGeneratePrompt(input), timeoutMs);
}
function makeHostBatchGenerateDoc(timeoutMs = 24e4, env = process.env) {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (inputs) => {
    const raw = runHostPrompt(spec, bin, buildBatchGeneratePrompt(inputs), timeoutMs);
    return parseBatchDocs(raw, inputs);
  };
}
function makeHostRunPrompt(timeoutMs = 3e5, env = process.env) {
  const spec = resolveDocLlmSpec(env);
  const bin = resolveCliBin(spec.bin);
  return async (prompt) => runHostPrompt(spec, bin, prompt, timeoutMs);
}

// dist/src/graph/diff.js
import { existsSync as existsSync4, readFileSync as readFileSync9 } from "node:fs";
import { join as join11 } from "node:path";
function edgeKey(e) {
  return `${e.source}${e.target}${e.relation}${e.ord ?? 0}`;
}
function diffSnapshots(from, to) {
  const fromById = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodeIds = new Set(to.nodes.map((n) => n.id));
  const nodesAdded = to.nodes.filter((n) => !fromById.has(n.id));
  const nodesRemoved = from.nodes.filter((n) => !toNodeIds.has(n.id));
  const nodesModified = [];
  for (const after of to.nodes) {
    const before = fromById.get(after.id);
    if (before && (before.signature ?? "") !== (after.signature ?? "")) {
      nodesModified.push({ before, after });
    }
  }
  const fromEdgeKeys = new Set(from.links.map(edgeKey));
  const toEdgeKeys = new Set(to.links.map(edgeKey));
  const edgesAdded = to.links.filter((e) => !fromEdgeKeys.has(edgeKey(e)));
  const edgesRemoved = from.links.filter((e) => !toEdgeKeys.has(edgeKey(e)));
  return {
    nodes: { added: nodesAdded, removed: nodesRemoved, modified: nodesModified },
    edges: { added: edgesAdded, removed: edgesRemoved },
    counts: {
      nodes_added: nodesAdded.length,
      nodes_removed: nodesRemoved.length,
      nodes_modified: nodesModified.length,
      edges_added: edgesAdded.length,
      edges_removed: edgesRemoved.length
    }
  };
}
function loadSnapshotByCommit(baseDir, commitSha) {
  if (!/^[0-9a-f]{4,64}$/i.test(commitSha))
    return null;
  const path = join11(baseDir, "snapshots", `${commitSha}.json`);
  if (!existsSync4(path))
    return null;
  let raw;
  try {
    raw = readFileSync9(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isGraphSnapshotLike(parsed))
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function isGraphSnapshotLike(v) {
  if (v === null || typeof v !== "object")
    return false;
  const s = v;
  return Array.isArray(s.nodes) && Array.isArray(s.links);
}
function printDiffHuman(diff, sampleSize = 10) {
  const { counts } = diff;
  console.log(`Nodes: +${counts.nodes_added} -${counts.nodes_removed}   Edges: +${counts.edges_added} -${counts.edges_removed}`);
  const showNodes = (label, ns) => {
    if (ns.length === 0)
      return;
    console.log("");
    console.log(`${label} (${ns.length}, showing up to ${sampleSize}):`);
    const sorted = [...ns].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const n of sorted.slice(0, sampleSize)) {
      console.log(`  ${n.id} [${n.kind}]${n.exported ? " (exported)" : ""}  ${n.source_file}:${n.source_location}`);
    }
    if (sorted.length > sampleSize)
      console.log(`  \u2026 and ${sorted.length - sampleSize} more`);
  };
  const showEdges = (label, es) => {
    if (es.length === 0)
      return;
    console.log("");
    console.log(`${label} (${es.length}, showing up to ${sampleSize}):`);
    const sorted = [...es].sort((a, b) => edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0);
    for (const e of sorted.slice(0, sampleSize)) {
      console.log(`  ${e.source} --${e.relation}--> ${e.target}${e.ord !== void 0 ? ` (ord=${e.ord})` : ""}`);
    }
    if (sorted.length > sampleSize)
      console.log(`  \u2026 and ${sorted.length - sampleSize} more`);
  };
  showNodes("Nodes added", diff.nodes.added);
  showNodes("Nodes removed", diff.nodes.removed);
  showEdges("Edges added", diff.edges.added);
  showEdges("Edges removed", diff.edges.removed);
}

// dist/src/docs/auto-registry.js
import { mkdirSync as mkdirSync6, readFileSync as readFileSync10, renameSync as renameSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { dirname as dirname4, join as join12 } from "node:path";
function registryPath() {
  return process.env.HIVEMIND_DOCS_AUTO_FILE ?? join12(homedir8(), ".deeplake", "docs-auto.json");
}
function readAutoRegistry(file = registryPath()) {
  try {
    const raw = JSON.parse(readFileSync10(file, "utf-8"));
    if (!Array.isArray(raw.entries))
      return { entries: [] };
    const entries = raw.entries.filter((e) => !!e && typeof e === "object" && typeof e.orgId === "string" && typeof e.project === "string" && typeof e.path === "string" && typeof e.auto === "boolean");
    return { entries };
  } catch {
    return { entries: [] };
  }
}
function writeAutoRegistry(reg, file = registryPath()) {
  mkdirSync6(dirname4(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync5(tmp, JSON.stringify(reg, null, 1) + "\n");
  renameSync3(tmp, file);
}
function isAutoEnabled(orgId, project, file = registryPath()) {
  return readAutoRegistry(file).entries.some((e) => e.orgId === orgId && e.project === project && e.auto);
}
function findEntry(orgId, project, file = registryPath()) {
  return readAutoRegistry(file).entries.find((e) => e.orgId === orgId && e.project === project);
}
function setAuto(entry, file = registryPath(), now = () => /* @__PURE__ */ new Date()) {
  const reg = readAutoRegistry(file);
  const existing = reg.entries.find((e) => e.orgId === entry.orgId && e.project === entry.project);
  const next = {
    orgId: entry.orgId,
    orgName: entry.orgName ?? existing?.orgName,
    project: entry.project,
    path: entry.path,
    auto: entry.auto,
    enabledAt: entry.auto && !existing?.auto ? now().toISOString() : existing?.enabledAt ?? now().toISOString()
  };
  reg.entries = [...reg.entries.filter((e) => !(e.orgId === entry.orgId && e.project === entry.project)), next];
  writeAutoRegistry(reg, file);
  return next;
}
function listEntries(file = registryPath()) {
  return [...readAutoRegistry(file).entries].sort((a, b) => a.path.localeCompare(b.path));
}

// dist/src/docs/onboarding.js
import { createInterface as createInterface2 } from "node:readline";
function defaultIo() {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    say: (line) => console.log(line),
    ask: (question) => new Promise((resolve4) => {
      const rl = createInterface2({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve4(answer);
      });
    })
  };
}
var YES = /^y(es)?$/i;
var STATUS_HINT = "See sync status anytime with: hivemind docs list";
async function runDocsOnboarding(args) {
  const io = args.io ?? defaultIo();
  const rootLine = `project root: ${args.root} (${args.isGitRepo ? "git repository" : "no git \u2014 current folder"}${args.orgName ? `, org: ${args.orgName}` : ""})`;
  if (!args.isGitRepo) {
    io.say(rootLine);
    io.say("Auto doc sync requires a git repository (it reacts to commits).");
    io.say("Docs can still be generated manually with: hivemind docs wiki");
    return { generate: false, auto: false, asked: false };
  }
  if (!io.interactive) {
    return { generate: false, auto: false, asked: false };
  }
  io.say(rootLine);
  const pages = args.snap ? selectWikiGroups(args.snap).length : null;
  const estimate = pages !== null ? `~${pages} pages, one-time LLM cost` : "one-time LLM cost";
  const genAnswer = await io.ask(`Generate wiki docs for this repo now? (${estimate}) [y/N] `);
  if (!YES.test(genAnswer.trim())) {
    io.say("Skipped. Generate later with: hivemind docs wiki");
    io.say(STATUS_HINT);
    return { generate: false, auto: false, asked: true };
  }
  const getAgent = args.getAgent ?? getDocsLlmAgent;
  const setAgent = args.setAgent ?? setDocsLlmAgent;
  const detectAgents = args.detectAgents ?? detectAvailableAgents;
  if (!getAgent()) {
    const available = detectAgents();
    if (available.length > 1) {
      const raw = (await io.ask(`Which agent should write the docs? [${available.join("/")}] (default: ${available[0]}) `)).trim().toLowerCase();
      const chosen = available.includes(raw) ? raw : available[0];
      setAgent(chosen);
      io.say(`Docs will be authored by: ${chosen}. Change with: hivemind docs agent <name>`);
    }
  }
  const autoAnswer = await io.ask("Keep them automatically in sync on every commit? Docs stay fresh but this consumes more LLM tokens over time. [y/N] ");
  const auto = YES.test(autoAnswer.trim());
  if (auto) {
    setAuto({ orgId: args.orgId, orgName: args.orgName, project: args.project, path: args.root, auto: true });
    io.say(`Auto sync ON for this repo on org ${args.orgName ?? args.orgId}. Turn off with: hivemind docs auto off`);
  } else {
    io.say("Manual mode: sync when you want with: hivemind docs sync");
  }
  io.say(STATUS_HINT);
  return { generate: true, auto, asked: true };
}

// dist/src/graph/history.js
import { appendFileSync as appendFileSync2, existsSync as existsSync5, mkdirSync as mkdirSync7, readFileSync as readFileSync11 } from "node:fs";
import { dirname as dirname5, join as join13 } from "node:path";
function historyPath(baseDir) {
  return join13(baseDir, "history.jsonl");
}
function appendHistoryEntry(baseDir, entry) {
  const path = historyPath(baseDir);
  try {
    mkdirSync7(dirname5(path), { recursive: true });
    appendFileSync2(path, JSON.stringify(entry) + "\n");
  } catch {
  }
}
function entryFromSnapshot(snapshot, snapshot_sha256, trigger) {
  return {
    ts: snapshot.observation.ts,
    commit_sha: snapshot.graph.commit_sha,
    snapshot_sha256,
    node_count: snapshot.nodes.length,
    edge_count: snapshot.links.length,
    trigger
  };
}
function readHistoryTail(baseDir, n) {
  const path = historyPath(baseDir);
  if (!existsSync5(path))
    return [];
  let raw;
  try {
    raw = readFileSync11(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < n; i--) {
    const parsed = parseLine(lines[i]);
    if (parsed !== null)
      entries.unshift(parsed);
  }
  return entries;
}
function countHistoryEntries(baseDir) {
  const path = historyPath(baseDir);
  if (!existsSync5(path))
    return 0;
  try {
    const raw = readFileSync11(path, "utf8");
    return raw.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}
function parseLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object")
    return null;
  const o = obj;
  if (typeof o.ts !== "string")
    return null;
  if (o.commit_sha !== null && typeof o.commit_sha !== "string")
    return null;
  if (typeof o.snapshot_sha256 !== "string")
    return null;
  if (typeof o.node_count !== "number")
    return null;
  if (typeof o.edge_count !== "number")
    return null;
  if (typeof o.trigger !== "string")
    return null;
  return {
    ts: o.ts,
    commit_sha: o.commit_sha,
    snapshot_sha256: o.snapshot_sha256,
    node_count: o.node_count,
    edge_count: o.edge_count,
    trigger: o.trigger
  };
}

// dist/src/graph/snapshot.js
import { createHash as createHash3 } from "node:crypto";
import { mkdirSync as mkdirSync9, renameSync as renameSync5, writeFileSync as writeFileSync7 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { dirname as dirname7, join as join15 } from "node:path";

// dist/src/graph/last-build.js
import { existsSync as existsSync6, mkdirSync as mkdirSync8, readFileSync as readFileSync12, renameSync as renameSync4, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname6, join as join14 } from "node:path";
function lastBuildPath(baseDir, worktreeId) {
  if (worktreeId !== void 0) {
    return join14(baseDir, "worktrees", worktreeId, ".last-build.json");
  }
  return join14(baseDir, ".last-build.json");
}
function writeLastBuild(baseDir, state, worktreeId) {
  const path = lastBuildPath(baseDir, worktreeId);
  try {
    mkdirSync8(dirname6(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync6(tmp, JSON.stringify(state));
    renameSync4(tmp, path);
  } catch {
  }
}
function readLastBuild(baseDir, worktreeId) {
  let path = lastBuildPath(baseDir, worktreeId);
  if (!existsSync6(path)) {
    if (worktreeId === void 0)
      return null;
    const legacy = lastBuildPath(baseDir, void 0);
    if (!existsSync6(legacy))
      return null;
    path = legacy;
  }
  let raw;
  try {
    raw = readFileSync12(path, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object")
    return null;
  const o = parsed;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts))
    return null;
  if (o.commit_sha !== null && typeof o.commit_sha !== "string")
    return null;
  if (typeof o.snapshot_sha256 !== "string")
    return null;
  const out = { ts: o.ts, commit_sha: o.commit_sha, snapshot_sha256: o.snapshot_sha256 };
  if (typeof o.node_count === "number" && Number.isFinite(o.node_count) && o.node_count >= 0) {
    out.node_count = o.node_count;
  }
  if (typeof o.edge_count === "number" && Number.isFinite(o.edge_count) && o.edge_count >= 0) {
    out.edge_count = o.edge_count;
  }
  return out;
}

// dist/src/graph/resolve/cross-file.js
import { posix } from "node:path";
var EXPORTABLE_KINDS = /* @__PURE__ */ new Set([
  "function",
  "class",
  "const",
  "interface",
  "type_alias",
  "enum"
]);
var HERITAGE_KINDS = /* @__PURE__ */ new Set([
  "class",
  "interface",
  "type_alias",
  "enum"
]);
function buildExportIndex(nodes) {
  const idx = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (!n.exported || !EXPORTABLE_KINDS.has(n.kind))
      continue;
    let m = idx.get(n.source_file);
    if (!m) {
      m = /* @__PURE__ */ new Map();
      idx.set(n.source_file, m);
    }
    if (!m.has(n.label))
      m.set(n.label, n.id);
  }
  return idx;
}
function resolveCrossFileCalls(extractions, nodes) {
  const knownFiles = /* @__PURE__ */ new Set();
  for (const ex of extractions)
    knownFiles.add(ex.source_file);
  const exportIndex = buildExportIndex(nodes);
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  for (const ex of extractions) {
    const rawCalls = ex.raw_calls ?? [];
    const bindings = ex.import_bindings ?? [];
    if (rawCalls.length === 0 || bindings.length === 0)
      continue;
    const byLocal = /* @__PURE__ */ new Map();
    for (const b of bindings) {
      if (!byLocal.has(b.local_name))
        byLocal.set(b.local_name, b);
    }
    for (const rc of rawCalls) {
      const target = resolveOne(rc, byLocal, ex.source_file, knownFiles, exportIndex);
      if (target === null)
        continue;
      const key = `${rc.caller_id}\0${target}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      edges.push({
        source: rc.caller_id,
        target,
        relation: "calls",
        confidence: "EXTRACTED"
      });
    }
  }
  return edges;
}
function resolveOne(rc, byLocal, fromFile, knownFiles, exportIndex) {
  let binding;
  let exportName;
  if (rc.receiver !== void 0) {
    binding = byLocal.get(rc.receiver);
    if (binding === void 0 || binding.kind !== "namespace")
      return null;
    if (binding.type_only)
      return null;
    exportName = rc.callee_name;
  } else {
    binding = byLocal.get(rc.callee_name);
    if (binding === void 0)
      return null;
    if (binding.type_only)
      return null;
    if (binding.kind !== "named")
      return null;
    exportName = binding.imported_name;
  }
  const targetFile = resolveModule(fromFile, binding.specifier, knownFiles);
  if (targetFile === null)
    return null;
  return exportIndex.get(targetFile)?.get(exportName) ?? null;
}
var MODULE_SUFFIX = "::module";
var EXTERNAL_PREFIX = "external:";
function repointImportEdges(links, knownFiles) {
  return links.map((e) => {
    if (e.relation !== "imports" || !e.target.startsWith(EXTERNAL_PREFIX))
      return e;
    if (!e.source.endsWith(MODULE_SUFFIX))
      return e;
    const fromFile = e.source.slice(0, -MODULE_SUFFIX.length);
    const specifier = e.target.slice(EXTERNAL_PREFIX.length);
    const resolved = resolveModule(fromFile, specifier, knownFiles);
    if (resolved === null)
      return e;
    return { ...e, target: `${resolved}${MODULE_SUFFIX}` };
  });
}
var UNRESOLVED_PREFIX = "unresolved:";
function resolveHeritageEdges(links, extractions, nodes) {
  const knownFiles = /* @__PURE__ */ new Set();
  for (const ex of extractions)
    knownFiles.add(ex.source_file);
  const exportIndex = buildExportIndex(nodes);
  const localIndex = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (!HERITAGE_KINDS.has(n.kind))
      continue;
    let m = localIndex.get(n.source_file);
    if (!m) {
      m = /* @__PURE__ */ new Map();
      localIndex.set(n.source_file, m);
    }
    if (!m.has(n.label))
      m.set(n.label, n.id);
  }
  const bindingsByFile = /* @__PURE__ */ new Map();
  for (const ex of extractions) {
    const m = /* @__PURE__ */ new Map();
    for (const b of ex.import_bindings ?? [])
      if (!m.has(b.local_name))
        m.set(b.local_name, b);
    bindingsByFile.set(ex.source_file, m);
  }
  return links.map((e) => {
    if (e.relation !== "extends" && e.relation !== "implements")
      return e;
    if (!e.target.startsWith(UNRESOLVED_PREFIX))
      return e;
    const parsed = parseUnresolved(e.target);
    if (parsed === null)
      return e;
    const { file, name } = parsed;
    const local = localIndex.get(file)?.get(name);
    if (local !== void 0)
      return { ...e, target: local };
    const binding = bindingsByFile.get(file)?.get(name);
    if (binding !== void 0 && binding.kind === "named") {
      const targetFile = resolveModule(file, binding.specifier, knownFiles);
      if (targetFile !== null) {
        const id = exportIndex.get(targetFile)?.get(binding.imported_name);
        if (id !== void 0)
          return { ...e, target: id };
      }
    }
    return e;
  });
}
function parseUnresolved(target) {
  const body = target.slice(UNRESOLVED_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0)
    return null;
  const rest = body.slice(0, lastColon);
  const nameColon = rest.lastIndexOf(":");
  if (nameColon <= 0)
    return null;
  const file = rest.slice(0, nameColon);
  const name = rest.slice(nameColon + 1);
  if (file.length === 0 || name.length === 0)
    return null;
  return { file, name };
}
function resolveModule(fromFile, specifier, knownFiles) {
  if (isPythonFile(fromFile))
    return resolvePythonModule(fromFile, specifier, knownFiles);
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    return null;
  const baseDir = posix.dirname(fromFile);
  const explicit = specifier.match(/\.(tsx?|jsx?|mjs|cjs)$/)?.[0] ?? null;
  const stem = explicit ? specifier.slice(0, -explicit.length) : specifier;
  const joined = posix.normalize(posix.join(baseDir, stem));
  const TS_EXTS = [".ts", ".tsx"];
  const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs"];
  const importerIsJs = /\.(jsx?|mjs|cjs)$/.test(fromFile);
  const primary = importerIsJs ? JS_EXTS : TS_EXTS;
  const secondary = importerIsJs ? TS_EXTS : JS_EXTS;
  const exts = [
    ...explicit ? [explicit] : [],
    ...primary,
    ...secondary
  ].filter((e, i, a) => a.indexOf(e) === i);
  for (const e of exts) {
    const c = `${joined}${e}`;
    if (knownFiles.has(c))
      return c;
  }
  for (const e of exts) {
    const c = `${joined}/index${e}`;
    if (knownFiles.has(c))
      return c;
  }
  return null;
}
var PY_EXTS = [".py", ".pyi"];
function isPythonFile(p) {
  return p.endsWith(".py") || p.endsWith(".pyi");
}
function resolvePythonModule(fromFile, specifier, knownFiles) {
  let dots = 0;
  while (dots < specifier.length && specifier[dots] === ".")
    dots++;
  const tail = specifier.slice(dots);
  const segs = tail.length > 0 ? tail.split(".") : [];
  if (dots === 0) {
    if (segs.length === 0)
      return null;
    return matchPythonSuffix(segs.join("/"), knownFiles);
  }
  let dir = posix.dirname(fromFile);
  let climbed = 1;
  for (; climbed < dots && dir !== "" && dir !== "."; climbed++)
    dir = posix.dirname(dir);
  if (climbed < dots)
    return null;
  const base = segs.length > 0 ? posix.normalize(posix.join(dir, ...segs)) : dir;
  for (const e of PY_EXTS)
    if (knownFiles.has(`${base}${e}`))
      return `${base}${e}`;
  for (const e of PY_EXTS)
    if (knownFiles.has(`${base}/__init__${e}`))
      return `${base}/__init__${e}`;
  return null;
}
function matchPythonSuffix(suffix, knownFiles) {
  const targets = [
    ...PY_EXTS.map((e) => `${suffix}${e}`),
    ...PY_EXTS.map((e) => `${suffix}/__init__${e}`)
  ];
  for (const t of targets) {
    if (knownFiles.has(t))
      return t;
    let hit = null;
    let count = 0;
    for (const f of knownFiles) {
      if (f.endsWith(`/${t}`)) {
        hit = f;
        count++;
      }
    }
    if (count === 1)
      return hit;
    if (count > 1)
      return null;
  }
  return null;
}

// dist/src/graph/node-metadata.js
function annotateNodeDegrees(nodes, links) {
  const inDeg = /* @__PURE__ */ new Map();
  const outDeg = /* @__PURE__ */ new Map();
  for (const e of links) {
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  for (const n of nodes) {
    const fi = inDeg.get(n.id) ?? 0;
    const fo = outDeg.get(n.id) ?? 0;
    n.fan_in = fi;
    n.fan_out = fo;
    n.is_entrypoint = n.exported && fi === 0;
  }
}

// dist/src/graph/snapshot.js
function graphsRoot() {
  return process.env.HIVEMIND_GRAPHS_HOME ?? join15(homedir9(), ".hivemind", "graphs");
}
function repoDir(repoKey) {
  return join15(graphsRoot(), repoKey);
}
function buildSnapshot(extractions, metadata, observation) {
  const nodes = [];
  const links = [];
  for (const ex of extractions) {
    for (const n of ex.nodes)
      nodes.push(n);
    for (const e of ex.edges)
      links.push(e);
  }
  for (const e of resolveCrossFileCalls(extractions, nodes))
    links.push(e);
  const knownFiles = /* @__PURE__ */ new Set();
  for (const ex of extractions)
    knownFiles.add(ex.source_file);
  let resolvedLinks = repointImportEdges(links, knownFiles);
  resolvedLinks = resolveHeritageEdges(resolvedLinks, extractions, nodes);
  annotateNodeDegrees(nodes, resolvedLinks);
  nodes.sort(compareNodes);
  resolvedLinks.sort(compareEdges);
  return {
    directed: true,
    multigraph: true,
    graph: metadata,
    observation,
    nodes,
    links: resolvedLinks
  };
}
function compareNodes(a, b) {
  return cmp(a.id, b.id);
}
function compareEdges(a, b) {
  let c = cmp(a.source, b.source);
  if (c !== 0)
    return c;
  c = cmp(a.target, b.target);
  if (c !== 0)
    return c;
  c = cmp(a.relation, b.relation);
  if (c !== 0)
    return c;
  return (a.ord ?? 0) - (b.ord ?? 0);
}
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function canonicalSnapshot(snapshot) {
  return canonicalJSON(snapshot);
}
function computeSnapshotSha256(snapshot) {
  const stable = {
    directed: snapshot.directed,
    multigraph: snapshot.multigraph,
    graph: snapshot.graph,
    nodes: snapshot.nodes,
    links: snapshot.links
  };
  return createHash3("sha256").update(canonicalJSON(stable)).digest("hex");
}
function canonicalJSON(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) {
        sorted[k] = v[k];
      }
      return sorted;
    }
    return v;
  });
}
function writeSnapshot(snapshot, baseDir, trigger = "unknown", worktreeId) {
  const sha256 = computeSnapshotSha256(snapshot);
  const commitSha = snapshot.graph.commit_sha;
  const fileBase = commitSha ?? sha256;
  const snapshotsDir = join15(baseDir, "snapshots");
  const snapshotPath = join15(snapshotsDir, `${fileBase}.json`);
  const canonical = canonicalSnapshot(snapshot);
  writeFileAtomic(snapshotPath, canonical);
  const worktreeRoot = worktreeId !== void 0 ? join15(baseDir, "worktrees", worktreeId) : baseDir;
  let latestCommitPath = null;
  if (commitSha !== null) {
    latestCommitPath = join15(worktreeRoot, "latest-commit.txt");
    writeFileAtomic(latestCommitPath, `${commitSha}
`);
  }
  writeLastBuild(baseDir, {
    ts: Date.now(),
    commit_sha: commitSha,
    snapshot_sha256: sha256,
    node_count: snapshot.nodes.length,
    edge_count: snapshot.links.length
  }, worktreeId);
  appendHistoryEntry(baseDir, entryFromSnapshot(snapshot, sha256, trigger));
  return { snapshotPath, latestCommitPath, snapshotSha256: sha256 };
}
function writeFileAtomic(filePath, contents) {
  mkdirSync9(dirname7(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync7(tmp, contents);
  renameSync5(tmp, filePath);
}

// dist/src/graph/load-current.js
import { createHash as createHash4 } from "node:crypto";
import { existsSync as existsSync7, readFileSync as readFileSync13 } from "node:fs";
import { join as join16 } from "node:path";
function workTreeIdFor(cwd) {
  return createHash4("sha256").update(cwd).digest("hex").slice(0, 16);
}
function loadCurrentSnapshot(cwd) {
  let baseDir;
  try {
    baseDir = repoDir(deriveProjectKey(cwd).key);
  } catch {
    return null;
  }
  const last = readLastBuild(baseDir, workTreeIdFor(cwd));
  if (last === null)
    return null;
  const fileBase = last.commit_sha ?? last.snapshot_sha256;
  const snapPath = join16(baseDir, "snapshots", `${fileBase}.json`);
  if (!existsSync7(snapPath))
    return null;
  try {
    const snap = JSON.parse(readFileSync13(snapPath, "utf8"));
    if (!Array.isArray(snap.nodes) || !Array.isArray(snap.links))
      return null;
    return snap;
  } catch {
    return null;
  }
}

export {
  HOME,
  pkgRoot,
  ensureDir,
  copyDir,
  symlinkForce,
  readJson,
  writeJson,
  writeJsonIfChanged,
  writeVersionStamp,
  claudeDesktopConfigDir,
  detectPlatforms,
  allPlatformIds,
  log,
  warn,
  confirm,
  promptLine,
  getVersion,
  getEmbeddingsEnabled,
  setEmbeddingsEnabled,
  getDocsLlmAgent,
  setDocsLlmAgent,
  deeplakeClientHeader,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  loadConfig,
  utcTimestamp,
  log2,
  sqlStr,
  sqlLike,
  sqlIdent,
  SKILLS_COLUMNS,
  buildCreateTableSql,
  healMissingColumns,
  isMissingTableError,
  isMissingColumnError,
  DeeplakeApi,
  deriveProjectKey,
  embeddingSqlLiteral,
  stableUnionRows,
  MAIN_SCOPE,
  parseScope,
  currentBranch,
  trunkBranch,
  currentScope,
  listDocs,
  listDocMeta,
  listDocsByIds,
  getDocLatest,
  docRowId,
  upsertDoc,
  editDoc,
  setDoc,
  archiveDoc,
  impactedNodes,
  defaultGit,
  changedFilesFromGit,
  expandToCandidateFiles,
  computeSymbolHash,
  buildAnchor,
  gateDocEdit,
  runPool,
  selectTargets,
  generateDocs,
  computeFingerprint,
  workingTreeClean,
  sourcePushed,
  serializeFingerprint,
  parseFingerprint,
  isFresh,
  WIKI_DOC_PREFIX,
  wikiDocId,
  stripFilesIndex,
  appendFilesIndex,
  parseFilesIndex,
  collectWikiAnchors,
  selectWikiGroups,
  wikiGroupEligible,
  generateWikiPages,
  resolveCliBin,
  buildClaudeInvocation,
  refreshDocs,
  unwrapModelOutput,
  knownDocsAgents,
  detectAvailableAgents,
  makeHostPageRunPrompt,
  makeHostGenerate,
  makeHostGenerateDoc,
  makeHostBatchGenerateDoc,
  makeHostRunPrompt,
  diffSnapshots,
  loadSnapshotByCommit,
  printDiffHuman,
  isAutoEnabled,
  findEntry,
  setAuto,
  listEntries,
  defaultIo,
  runDocsOnboarding,
  appendHistoryEntry,
  readHistoryTail,
  countHistoryEntries,
  writeLastBuild,
  readLastBuild,
  repoDir,
  buildSnapshot,
  computeSnapshotSha256,
  writeSnapshot,
  loadCurrentSnapshot
};
