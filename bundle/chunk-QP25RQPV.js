import {
  DeeplakeApi,
  MAIN_SCOPE,
  WIKI_DOC_PREFIX,
  appendFilesIndex,
  archiveDoc,
  buildAnchor,
  changedFilesFromGit,
  collectWikiAnchors,
  computeFingerprint,
  computeSymbolHash,
  currentBranch,
  currentScope,
  defaultGit,
  defaultIo,
  deriveProjectKey,
  detectAvailableAgents,
  diffSnapshots,
  docRowId,
  editDoc,
  embeddingSqlLiteral,
  expandToCandidateFiles,
  findEntry,
  gateDocEdit,
  generateDocs,
  generateWikiPages,
  getDocLatest,
  getDocsLlmAgent,
  getEmbeddingsEnabled,
  getVersion,
  impactedNodes,
  isAutoEnabled,
  isFresh,
  isMissingTableError,
  knownDocsAgents,
  listDocMeta,
  listDocs,
  listDocsByIds,
  listEntries,
  loadConfig,
  loadCurrentSnapshot,
  loadSnapshotByCommit,
  log2 as log,
  makeHostBatchGenerateDoc,
  makeHostGenerate,
  makeHostGenerateDoc,
  makeHostPageRunPrompt,
  makeHostRunPrompt,
  parseFilesIndex,
  parseFingerprint,
  parseScope,
  refreshDocs,
  repoDir,
  runDocsOnboarding,
  runPool,
  selectTargets,
  selectWikiGroups,
  serializeFingerprint,
  setAuto,
  setDoc,
  setDocsLlmAgent,
  sourcePushed,
  sqlIdent,
  sqlLike,
  sqlStr,
  stableUnionRows,
  stripFilesIndex,
  trunkBranch,
  unwrapModelOutput,
  upsertDoc,
  wikiDocId,
  wikiGroupEligible,
  workingTreeClean
} from "./chunk-COCWAHUT.js";
import {
  containsOurMarkers,
  postCommitHookPath,
  tryGitTopLevel
} from "./chunk-5M4YA7ZO.js";

// dist/src/commands/docs.js
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "node:fs";

// dist/src/docs/index-render.js
function dirOf(docId) {
  const i = docId.lastIndexOf("/");
  return i < 0 ? "" : docId.slice(0, i);
}
function childUnder(atDir, docId) {
  const prefix = atDir === "" ? "" : atDir + "/";
  if (!docId.startsWith(prefix))
    return null;
  const rest = docId.slice(prefix.length);
  if (rest === "" || rest.startsWith("/"))
    return null;
  const slash = rest.indexOf("/");
  if (slash < 0)
    return { kind: "file", name: rest };
  return { kind: "dir", name: rest.slice(0, slash) };
}
function firstDocLine(content, max = 90) {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line === "---")
      continue;
    return line.length > max ? line.slice(0, max - 1).trimEnd() + "\u2026" : line;
  }
  return "";
}
function dateOnly(ts) {
  return ts.slice(0, 10);
}
function buildDocsIndex(meta, atDir = "", summaries = /* @__PURE__ */ new Map()) {
  const active = meta.filter((m) => m.status === "active");
  const subdirs = /* @__PURE__ */ new Map();
  const files = [];
  for (const m of active) {
    const child = childUnder(atDir, m.doc_id);
    if (!child)
      continue;
    if (child.kind === "file") {
      files.push(m);
    } else {
      const agg = subdirs.get(child.name);
      if (agg) {
        agg.count++;
        if (m.updated_at > agg.latest)
          agg.latest = m.updated_at;
      } else {
        subdirs.set(child.name, { count: 1, latest: m.updated_at });
      }
    }
  }
  const title = atDir === "" ? "# Docs Index" : `# Docs: ${atDir}/`;
  const lines = [
    title,
    "",
    "Per-file documentation, kept fresh on code changes. Drill into a directory,",
    "or open a file's doc directly. Metadata only \u2014 open a leaf for the content.",
    ""
  ];
  if (subdirs.size > 0) {
    lines.push("## Directories", "");
    lines.push("| Directory | Docs | Last updated |");
    lines.push("|-----------|------|--------------|");
    for (const name of [...subdirs.keys()].sort()) {
      const agg = subdirs.get(name);
      const rel = `${name}/index.md`;
      lines.push(`| [${name}/](${rel}) | ${agg.count} | ${dateOnly(agg.latest)} |`);
    }
    lines.push("");
  }
  if (files.length > 0) {
    lines.push("## Files", "");
    const hasSummary = files.some((f) => (summaries.get(f.doc_id) ?? "") !== "");
    if (hasSummary) {
      lines.push("| File | Version | Updated | Summary |");
      lines.push("|------|---------|---------|---------|");
    } else {
      lines.push("| File | Version | Updated |");
      lines.push("|------|---------|---------|");
    }
    for (const f of files.sort((a, b) => a.doc_id.localeCompare(b.doc_id))) {
      const base = f.doc_id.slice(f.doc_id.lastIndexOf("/") + 1);
      const rel = `${base}.md`;
      const ver = `v${f.version}`;
      if (hasSummary) {
        lines.push(`| [${base}](${rel}) | ${ver} | ${dateOnly(f.updated_at)} | ${summaries.get(f.doc_id) ?? ""} |`);
      } else {
        lines.push(`| [${base}](${rel}) | ${ver} | ${dateOnly(f.updated_at)} |`);
      }
    }
    lines.push("");
  }
  if (subdirs.size === 0 && files.length === 0) {
    lines.push(atDir === "" ? "_(no docs yet \u2014 run `hivemind docs generate`)_" : `_(no docs under ${atDir}/)_`);
    lines.push("");
  }
  const totalActive = active.length;
  const archived = meta.length - totalActive;
  lines.push("---", `${totalActive} active doc(s)${archived > 0 ? `, ${archived} archived` : ""}.`);
  return lines.join("\n");
}

// dist/src/docs/impact.js
function computeStaleDocs(args) {
  const nodeById = new Map(args.snap.nodes.map((n) => [n.id, n]));
  const out = [];
  for (const doc of args.docs) {
    const reasons = [];
    for (const anchor of doc.anchors) {
      const node = nodeById.get(anchor.symbol_id);
      if (!node) {
        reasons.push({ kind: "symbol_missing", symbol_id: anchor.symbol_id });
        continue;
      }
      const current = computeSymbolHash(node, args.repoRoot);
      if (current === null) {
        reasons.push({ kind: "symbol_missing", symbol_id: anchor.symbol_id });
        continue;
      }
      if (current !== anchor.content_hash) {
        reasons.push({ kind: "code_changed", symbol_id: anchor.symbol_id });
      }
    }
    if (reasons.length > 0)
      out.push({ doc_id: doc.doc_id, reasons });
  }
  return out;
}
function widenByBlastRadius(args) {
  const changed = new Set(args.changedSymbolIds);
  if (changed.size === 0)
    return [];
  const closure = impactedNodes(args.snap, changed);
  const out = [];
  for (const doc of args.docs) {
    const reasons = [];
    for (const anchor of doc.anchors) {
      if (closure.has(anchor.symbol_id) && !changed.has(anchor.symbol_id)) {
        reasons.push({ kind: "caller_changed", symbol_id: anchor.symbol_id });
      }
    }
    if (reasons.length > 0)
      out.push({ doc_id: doc.doc_id, reasons });
  }
  return out;
}
function computeImpactedDocs(args) {
  const merged = /* @__PURE__ */ new Map();
  const add = (d) => {
    const cur = merged.get(d.doc_id);
    if (cur)
      cur.push(...d.reasons);
    else
      merged.set(d.doc_id, [...d.reasons]);
  };
  const direct = computeStaleDocs({ snap: args.snap, docs: args.docs, repoRoot: args.repoRoot });
  for (const d of direct)
    add(d);
  const seeds = /* @__PURE__ */ new Set();
  if (args.diff) {
    for (const n of args.diff.nodes.added)
      seeds.add(n.id);
    for (const n of args.diff.nodes.removed)
      seeds.add(n.id);
  }
  for (const d of direct) {
    for (const r of d.reasons) {
      if (r.kind === "code_changed")
        seeds.add(r.symbol_id);
    }
  }
  for (const d of widenByBlastRadius({ snap: args.snap, changedSymbolIds: seeds, docs: args.docs })) {
    add(d);
  }
  return [...merged.entries()].map(([doc_id, reasons]) => ({ doc_id, reasons }));
}

// dist/src/docs/wiki-refresh.js
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// dist/src/docs/meta.js
var META_DOC_ID = "_meta";
var CLAIM_TTL_MS = 30 * 60 * 1e3;
var EMPTY_META = {
  last_refresh_sha: "",
  claimed_by: null,
  claimed_at: null,
  patch_counts: {}
};
function parseMeta(content) {
  try {
    const raw = JSON.parse(content);
    return {
      last_refresh_sha: typeof raw.last_refresh_sha === "string" ? raw.last_refresh_sha : "",
      claimed_by: typeof raw.claimed_by === "string" ? raw.claimed_by : null,
      claimed_at: typeof raw.claimed_at === "string" ? raw.claimed_at : null,
      patch_counts: raw.patch_counts && typeof raw.patch_counts === "object" ? raw.patch_counts : {}
    };
  } catch {
    return { ...EMPTY_META };
  }
}
async function readRefreshMeta(query, tableName, project, scope = "main") {
  const safe = sqlIdent(tableName);
  const id = docRowId(project, scope, META_DOC_ID);
  const rows = await query(`SELECT content, updated_at FROM "${safe}" WHERE id = '${sqlStr(id)}' ORDER BY updated_at DESC LIMIT 1`);
  if (!rows.length)
    return null;
  return {
    meta: parseMeta(String(rows[0].content ?? "")),
    updated_at: String(rows[0].updated_at ?? "")
  };
}
async function writeMetaRow(query, tableName, project, scope, meta, now) {
  const safe = sqlIdent(tableName);
  const id = docRowId(project, scope, META_DOC_ID);
  await query(`DELETE FROM "${safe}" WHERE id = '${sqlStr(id)}'`);
  await query(`INSERT INTO "${safe}" (id, doc_id, path, content, anchors, tier, status, project, scope, version, created_at, updated_at, agent, plugin_version) VALUES ('${sqlStr(id)}', '${META_DOC_ID}', '', E'${sqlStr(JSON.stringify(meta))}', '[]', 'slow', 'meta', '${sqlStr(project)}', '${sqlStr(scope)}', 1, '${sqlStr(now)}', '${sqlStr(now)}', 'refresh-meta', '')`);
  await query(`DELETE FROM "${safe}" WHERE id = '${sqlStr(id)}' AND updated_at < '${sqlStr(now)}'`);
}
async function tryClaimTurn(query, tableName, project, scope, opts) {
  const ttl = opts.ttlMs ?? CLAIM_TTL_MS;
  const nowFn = opts.now ?? (() => /* @__PURE__ */ new Date());
  const sleep2 = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const current = await readRefreshMeta(query, tableName, project, scope);
  const nowIso = nowFn().toISOString();
  if (current?.meta.claimed_at && current.meta.claimed_by) {
    const age = nowFn().getTime() - new Date(current.meta.claimed_at).getTime();
    if (age < ttl)
      return { won: false, reason: "held" };
  }
  const fresh = await readRefreshMeta(query, tableName, project, scope);
  const claimed = {
    ...fresh?.meta ?? current?.meta ?? EMPTY_META,
    claimed_by: opts.owner,
    claimed_at: nowIso
  };
  await writeMetaRow(query, tableName, project, scope, claimed, nowIso);
  await sleep2(250);
  const after = await readRefreshMeta(query, tableName, project, scope);
  if (after?.meta.claimed_by === opts.owner && after.meta.claimed_at === nowIso) {
    return { won: true, meta: after.meta };
  }
  return { won: false, reason: "lost-race" };
}
async function releaseClaim(query, tableName, project, scope, opts) {
  const nowFn = opts.now ?? (() => /* @__PURE__ */ new Date());
  const current = await readRefreshMeta(query, tableName, project, scope);
  if (current?.meta.claimed_by !== opts.owner)
    return false;
  await writeMetaRow(query, tableName, project, scope, {
    last_refresh_sha: current.meta.last_refresh_sha,
    claimed_by: null,
    claimed_at: null,
    patch_counts: opts.patchCounts ?? current.meta.patch_counts
  }, nowFn().toISOString());
  return true;
}
async function commitRefresh(query, tableName, project, scope, sha, patchCounts, opts) {
  const nowFn = opts.now ?? (() => /* @__PURE__ */ new Date());
  const current = await readRefreshMeta(query, tableName, project, scope);
  if (current?.meta.claimed_by !== opts.owner) {
    return { committed: false, reason: "lost-lease" };
  }
  const meta = {
    last_refresh_sha: sha,
    claimed_by: null,
    claimed_at: null,
    patch_counts: patchCounts
  };
  await writeMetaRow(query, tableName, project, scope, meta, nowFn().toISOString());
  return { committed: true };
}

// dist/src/docs/wiki-update.js
var NO_CHANGE = "NO_CHANGE";
var DEFAULT_MAX_PATCHES = 15;
var DEFAULT_MAX_SIGNATURE_CHANGES = 5;
var DEFAULT_WIKI_MAX_CHANGED_LINES = 60;
function buildUpdatePrompt(pageKey, narrative, diff) {
  return [
    `Below is the internal wiki page for the subsystem \`${pageKey}\`, followed by`,
    "the unified diff of the code changes since the page was last verified.",
    "",
    "Correct ONLY the statements this diff makes false. Do NOT rephrase, restyle,",
    "or expand anything the diff does not contradict. Keep every untouched line",
    "byte-identical. Do NOT add a file listing section.",
    `If nothing in the page is contradicted by the diff, reply with exactly: ${NO_CHANGE}`,
    "Otherwise output the FULL corrected page as raw markdown (no preamble, no outer code fence).",
    "",
    "=== CURRENT PAGE ===",
    "",
    narrative,
    "",
    "=== CODE DIFF ===",
    "",
    diff
  ].join("\n");
}
function shouldEscalate(input) {
  const reasons = [];
  if (input.membershipChanged)
    reasons.push("group membership changed");
  const maxSig = input.maxSignatureChanges ?? DEFAULT_MAX_SIGNATURE_CHANGES;
  if (input.signatureChanges > maxSig) {
    reasons.push(`too many signature changes: ${input.signatureChanges} > ${maxSig}`);
  }
  const maxPatches = input.maxPatches ?? DEFAULT_MAX_PATCHES;
  if (input.patchCount >= maxPatches) {
    reasons.push(`patch budget exhausted: ${input.patchCount} >= ${maxPatches}`);
  }
  return { escalate: reasons.length > 0, reasons };
}
function anchorsEqual(a, b) {
  if (a.length !== b.length)
    return false;
  const key = (x) => `${x.symbol_id}\0${x.content_hash}`;
  const set = new Set(a.map(key));
  return b.every((x) => set.has(key(x)));
}
async function updateWikiPage(args) {
  const pre = shouldEscalate(args.escalation);
  if (pre.escalate)
    return { action: "escalate", reasons: pre.reasons };
  const narrative = stripFilesIndex(args.page.content);
  let response;
  try {
    response = (await args.run(buildUpdatePrompt(args.pageKey, narrative, args.diff))).trim();
  } catch (err) {
    return { action: "failed", reason: `update failed: ${err.message}` };
  }
  const noChange = response === NO_CHANGE;
  if (!noChange && response === "")
    return { action: "failed", reason: "empty patch response" };
  let newNarrative = narrative;
  if (!noChange) {
    const unwrapped = unwrapModelOutput(response);
    const firstHeading = unwrapped.search(/^#{1,6} /m);
    if (firstHeading < 0)
      return { action: "failed", reason: "patch response has no markdown heading \u2014 not a page" };
    newNarrative = unwrapped.slice(firstHeading).trimEnd();
  }
  const newContent = appendFilesIndex(newNarrative, args.files);
  const newAnchors = collectWikiAnchors(args.snap, args.files, args.repoRoot);
  if (newContent === args.page.content && anchorsEqual(newAnchors, args.page.anchors)) {
    return { action: "no_change" };
  }
  const gate = gateDocEdit({
    tier: args.page.tier,
    allowSlow: true,
    // wiki pages are slow-tier but machine-authored — see gate.ts
    prevContent: args.page.content,
    newContent,
    newAnchors,
    snap: args.snap,
    maxChangedLines: args.maxChangedLines ?? DEFAULT_WIKI_MAX_CHANGED_LINES
  });
  if (!gate.ok) {
    return { action: "escalate", reasons: gate.reasons };
  }
  try {
    const source_fp = serializeFingerprint(computeFingerprint(defaultGit(args.repoRoot), args.files));
    if (args.privateSink) {
      args.privateSink({ doc_id: args.page.doc_id, path: args.page.path, content: newContent, source_fp, tier: args.page.tier });
      return noChange ? { action: "mechanics_refreshed", version: args.page.version } : { action: "patched", version: args.page.version, changedLines: gate.changedLines };
    }
    const content_embedding = args.embed ? await args.embed(newContent) ?? void 0 : void 0;
    const targetScope = args.scope ?? "main";
    const pageScope = args.page.scope ?? "main";
    let res;
    if (pageScope === targetScope) {
      res = await editDoc(args.query, args.tableName, {
        doc_id: args.page.doc_id,
        content: newContent,
        anchors: newAnchors,
        source_fp,
        agent: args.agent ?? "docs-wiki-update",
        plugin_version: args.pluginVersion,
        content_embedding
      }, { project: args.page.project, scope: targetScope });
    } else {
      res = await upsertDoc(args.query, args.tableName, {
        doc_id: args.page.doc_id,
        path: args.page.path,
        content: newContent,
        anchors: newAnchors,
        tier: args.page.tier,
        project: args.page.project,
        scope: targetScope,
        source_fp,
        agent: args.agent ?? "docs-wiki-update",
        plugin_version: args.pluginVersion,
        content_embedding
      });
    }
    return noChange ? { action: "mechanics_refreshed", version: res.version } : { action: "patched", version: res.version, changedLines: gate.changedLines };
  } catch (err) {
    return { action: "failed", reason: `write failed: ${err.message}` };
  }
}

// dist/src/docs/promote.js
function planPromotions(rows, git, groupFiles) {
  const byDoc = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (!r.doc_id.startsWith(WIKI_DOC_PREFIX))
      continue;
    const g = byDoc.get(r.doc_id) ?? { overlays: [] };
    if (parseScope(r.scope).kind === "branch")
      g.overlays.push(r);
    else
      g.main = r;
    byDoc.set(r.doc_id, g);
  }
  const out = [];
  for (const [doc_id, g] of byDoc) {
    if (g.overlays.length === 0)
      continue;
    const files = groupFiles.get(doc_id);
    if (!files || files.length === 0)
      continue;
    const mainFp = computeFingerprint(git, files);
    if (Object.keys(mainFp).length === 0)
      continue;
    const mainFpStr = serializeFingerprint(mainFp);
    for (const ov of g.overlays) {
      if (!sameFileSet(parseFilesIndex(ov.content), files))
        continue;
      if (isFresh(parseFingerprint(ov.source_fp), mainFp)) {
        out.push({ doc_id, fromScope: ov.scope, path: ov.path, content: ov.content, tier: ov.tier, mainFp: mainFpStr });
      }
    }
  }
  return out;
}
function sameFileSet(a, b) {
  if (a.length !== b.length)
    return false;
  const s = new Set(a);
  return b.every((f) => s.has(f));
}
async function promoteMergedOverlays(query, tableName, project, git, groupFiles, opts = {}) {
  const safe = sqlIdent(tableName);
  const raw = await stableUnionRows(query, `SELECT id, doc_id, path, content, tier, scope, source_fp FROM "${safe}" WHERE project = '${sqlStr(project)}' AND status = 'active'`);
  const rows = raw.map((r) => ({
    doc_id: String(r.doc_id ?? ""),
    path: String(r.path ?? ""),
    content: String(r.content ?? ""),
    tier: String(r.tier ?? "slow"),
    scope: String(r.scope ?? MAIN_SCOPE),
    source_fp: String(r.source_fp ?? "{}")
  }));
  const outcomes = [];
  for (const p of planPromotions(rows, git, groupFiles)) {
    try {
      await upsertDoc(query, tableName, {
        doc_id: p.doc_id,
        path: p.path,
        content: p.content,
        tier: p.tier === "fast" ? "fast" : "slow",
        project,
        scope: MAIN_SCOPE,
        source_fp: p.mainFp,
        agent: opts.agent ?? "docs-wiki-promote",
        plugin_version: opts.pluginVersion
      });
      await editDoc(query, tableName, { doc_id: p.doc_id, status: "archived" }, { project, scope: p.fromScope });
      outcomes.push({ doc_id: p.doc_id, fromScope: p.fromScope, action: "promoted" });
    } catch {
    }
  }
  return outcomes;
}

// dist/src/docs/private-store.js
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
function privateStoreRoot() {
  return process.env.HIVEMIND_DOCS_PRIVATE_DIR || join(homedir(), ".hivemind", "docs-private");
}
function storeFile(project, scope) {
  const key = createHash("sha256").update(`${project}\0${scope}`).digest("hex");
  return join(privateStoreRoot(), `${key}.json`);
}
function readMap(file) {
  try {
    if (!existsSync(file))
      return {};
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return {};
    return raw;
  } catch {
    return {};
  }
}
function writeMap(file, map) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 1) + "\n");
  renameSync(tmp, file);
}
function writePrivateDoc(project, scope, doc) {
  const file = storeFile(project, scope);
  const map = readMap(file);
  map[doc.doc_id] = doc;
  writeMap(file, map);
}
function deletePrivateDoc(project, scope, docId) {
  const file = storeFile(project, scope);
  const map = readMap(file);
  if (docId in map) {
    delete map[docId];
    writeMap(file, map);
  }
}

// dist/src/docs/wiki-refresh.js
var DEFAULT_MIN_PERIOD_MS = 6 * 60 * 60 * 1e3;
function defaultRegenerate(args) {
  return async (group) => {
    const report = await generateWikiPages({
      query: args.query,
      tableName: args.tableName,
      snap: args.snap,
      repoRoot: args.repoRoot,
      project: args.project,
      scope: args.scope,
      include: group.files,
      existing: /* @__PURE__ */ new Set(),
      force: true,
      run: args.run,
      runPage: args.runPage,
      embed: args.embed,
      agent: args.agent,
      pluginVersion: args.pluginVersion
    });
    if (report.created > 0 && report.failed === 0)
      return "created";
    if (report.failed === 0 && report.skipped > 0)
      return "skipped";
    return "failed";
  };
}
async function runLocalWikiRefresh(args) {
  const changedOut = args.git(["diff", "--name-only", "HEAD"]);
  const changed = new Set((changedOut ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  const untracked = args.git(["ls-files", "--others", "--exclude-standard"]);
  for (const l of (untracked ?? "").split("\n"))
    if (l.trim())
      changed.add(l.trim());
  const outcomes = [];
  if (changed.size === 0)
    return { outcomes };
  for (const group of selectWikiGroups(args.snap)) {
    const touched = group.files.filter((f) => changed.has(f));
    if (touched.length === 0)
      continue;
    const localFile = `${group.key}.wiki.hivemind.md`;
    const abs = join2(args.repoRoot, localFile);
    if (!existsSync2(abs)) {
      outcomes.push({ file: localFile, action: "not-materialized", reasons: ["run `hivemind docs pull` first"] });
      continue;
    }
    const diff = args.git(["diff", "HEAD", "--", ...touched]) ?? "";
    if (diff.trim() === "")
      continue;
    let current;
    try {
      current = readFileSync2(abs, "utf-8");
    } catch {
      outcomes.push({ file: localFile, action: "not-materialized", reasons: ["file vanished during refresh"] });
      continue;
    }
    let response;
    try {
      response = (await args.run(buildUpdatePrompt(group.key, stripFilesIndex(current), diff))).trim();
    } catch (err) {
      outcomes.push({ file: localFile, action: "failed", reasons: [err.message] });
      continue;
    }
    if (response === NO_CHANGE || response === "") {
      outcomes.push({ file: localFile, action: "no_change" });
      continue;
    }
    const next = appendFilesIndex(response, group.files);
    const gate = gateDocEdit({
      tier: "slow",
      allowSlow: true,
      prevContent: current,
      newContent: next,
      newAnchors: [],
      snap: args.snap,
      maxChangedLines: args.maxChangedLines ?? DEFAULT_WIKI_MAX_CHANGED_LINES
    });
    if (!gate.ok) {
      outcomes.push({ file: localFile, action: "escalate-skipped", reasons: gate.reasons });
      continue;
    }
    writeFileSync2(abs, next.endsWith("\n") ? next : next + "\n");
    outcomes.push({ file: localFile, action: "patched" });
  }
  return { outcomes };
}
async function runWikiRefreshCycle(args) {
  const log3 = args.log ?? (() => {
  });
  const nowFn = args.now ?? (() => /* @__PURE__ */ new Date());
  const scope = args.scope ?? "main";
  const head = args.git(["rev-parse", "HEAD"])?.trim();
  if (!head)
    return { status: "no-git", outcomes: [] };
  const metaBefore = await readRefreshMeta(args.query, args.tableName, args.project, scope);
  if (metaBefore?.meta.last_refresh_sha === head) {
    return { status: "up-to-date", head, outcomes: [] };
  }
  if (metaBefore && !args.force) {
    const sinceLastTouch = nowFn().getTime() - new Date(metaBefore.updated_at).getTime();
    const minPeriod = args.minPeriodMs ?? DEFAULT_MIN_PERIOD_MS;
    if (Number.isFinite(sinceLastTouch) && sinceLastTouch < minPeriod) {
      return { status: "too-soon", head, outcomes: [] };
    }
  }
  const claim = await tryClaimTurn(args.query, args.tableName, args.project, scope, {
    owner: args.owner,
    now: args.now,
    sleep: args.sleep
  });
  if (!claim.won)
    return { status: "not-claimed", head, outcomes: [] };
  if (claim.meta.last_refresh_sha === head) {
    await commitRefresh(args.query, args.tableName, args.project, scope, head, claim.meta.patch_counts, {
      owner: args.owner,
      now: args.now
    });
    return { status: "up-to-date", head, outcomes: [] };
  }
  const lastSha = claim.meta.last_refresh_sha;
  const patchCounts = { ...claim.meta.patch_counts };
  let baseSha = lastSha;
  if (lastSha === "" && parseScope(scope).kind === "branch") {
    const trunk = trunkBranch(args.git);
    const mb = (args.git(["merge-base", "HEAD", `origin/${trunk}`]) ?? args.git(["merge-base", "HEAD", trunk]))?.trim();
    if (mb) {
      baseSha = mb;
      log3(`branch first cycle \u2014 window from merge-base ${mb.slice(0, 8)}..HEAD`);
    }
  }
  let changed = null;
  if (baseSha !== "") {
    const out = args.git(["diff", "--name-only", `${baseSha}..HEAD`]);
    if (out !== null) {
      changed = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
    } else {
      log3(`diff ${baseSha}..HEAD unavailable \u2014 full-candidate cycle`);
    }
  } else {
    log3("first refresh cycle \u2014 full-candidate cycle");
  }
  let modified = [];
  if (lastSha !== "" && args.loadSnapshotAt) {
    const prevSnap = args.loadSnapshotAt(lastSha);
    if (prevSnap)
      modified = diffSnapshots(prevSnap, args.snap).nodes.modified ?? [];
    else
      log3(`no graph snapshot at ${lastSha} \u2014 signature-churn escalation disabled this cycle`);
  }
  const sigChangesByFile = /* @__PURE__ */ new Map();
  for (const m of modified) {
    sigChangesByFile.set(m.after.source_file, (sigChangesByFile.get(m.after.source_file) ?? 0) + 1);
  }
  const groups = selectWikiGroups(args.snap);
  const pages = /* @__PURE__ */ new Map();
  for (const d of await listDocs(args.query, args.tableName, { project: args.project, status: "active", limit: 1e5, readerScope: scope })) {
    if (d.doc_id.startsWith(WIKI_DOC_PREFIX))
      pages.set(d.doc_id, d);
  }
  const regenerate = args.regenerate ?? defaultRegenerate(args);
  const outcomes = [];
  let failures = 0;
  let pendingPublish = 0;
  const parsedScope = parseScope(scope);
  const branchName = parsedScope.kind === "branch" ? parsedScope.branch : null;
  const detached = branchName === null && currentBranch(args.git) === null;
  const promotedIds = /* @__PURE__ */ new Set();
  if (branchName === null && !detached) {
    const groupFiles = new Map(groups.map((g) => [wikiDocId(g.key), g.files]));
    for (const p of await promoteMergedOverlays(args.query, args.tableName, args.project, args.git, groupFiles, { agent: args.agent, pluginVersion: args.pluginVersion })) {
      promotedIds.add(p.doc_id);
      outcomes.push({ doc_id: p.doc_id, action: "promoted", reasons: [`from ${p.fromScope}`] });
    }
  }
  const holdReason = (files) => {
    if (detached)
      return "detached HEAD \u2014 ambiguous branch identity";
    if (!workingTreeClean(args.git, files))
      return "uncommitted changes in member files";
    return null;
  };
  const isPrivate = (files) => branchName !== null && !sourcePushed(args.git, files, branchName);
  const stampPrivate = (doc) => writePrivateDoc(args.project, scope, { ...doc, updated_at: nowFn().toISOString() });
  for (const group of groups) {
    const docId = wikiDocId(group.key);
    const page = pages.get(docId);
    if (promotedIds.has(docId))
      continue;
    if (!page) {
      const hr2 = holdReason(group.files);
      if (hr2) {
        outcomes.push({ doc_id: docId, action: "held", reasons: [hr2] });
        continue;
      }
      if (isPrivate(group.files)) {
        outcomes.push({ doc_id: docId, action: "held", reasons: ["new subsystem on an unpushed branch \u2014 publishes on push"] });
        pendingPublish++;
        continue;
      }
      const res = await regenerate(group);
      if (res === "skipped") {
        outcomes.push({ doc_id: docId, action: "skipped", reasons: ["below min size \u2014 no page wanted"] });
        continue;
      }
      outcomes.push({ doc_id: docId, action: res === "created" ? "generated" : "failed" });
      if (res === "failed")
        failures++;
      else {
        patchCounts[docId] = 0;
        if (branchName)
          deletePrivateDoc(args.project, scope, docId);
      }
      continue;
    }
    const pageFiles = parseFilesIndex(page.content);
    const membershipChanged = pageFiles.length > 0 && (pageFiles.length !== group.files.length || group.files.some((f) => !pageFiles.includes(f)));
    const touched = changed === null || group.files.some((f) => changed.has(f));
    if (!touched && !membershipChanged)
      continue;
    const hr = holdReason(group.files);
    if (hr) {
      outcomes.push({ doc_id: docId, action: "held", reasons: [hr] });
      continue;
    }
    const priv = isPrivate(group.files);
    const diff = baseSha === "" ? null : args.git(["diff", `${baseSha}..HEAD`, "--", ...group.files]);
    if (diff === null && !membershipChanged) {
      if (priv) {
        outcomes.push({ doc_id: docId, action: "held", reasons: ["private page needs regeneration \u2014 publishes on push"] });
        pendingPublish++;
        continue;
      }
      const res = await regenerate(group);
      outcomes.push({ doc_id: docId, action: res === "failed" ? "failed" : "regenerated", reasons: ["no usable diff"] });
      if (res === "failed")
        failures++;
      else
        patchCounts[docId] = 0;
      continue;
    }
    const out = await updateWikiPage({
      query: args.query,
      tableName: args.tableName,
      page,
      scope,
      privateSink: priv ? stampPrivate : void 0,
      pageKey: group.key,
      files: group.files,
      snap: args.snap,
      repoRoot: args.repoRoot,
      diff: diff ?? "",
      run: args.run,
      escalation: {
        membershipChanged,
        signatureChanges: group.files.reduce((n, f) => n + (sigChangesByFile.get(f) ?? 0), 0),
        patchCount: patchCounts[docId] ?? 0
      },
      embed: args.embed,
      agent: args.agent,
      pluginVersion: args.pluginVersion
    });
    if (priv) {
      pendingPublish++;
    } else if (branchName) {
      deletePrivateDoc(args.project, scope, docId);
    }
    if (out.action === "escalate") {
      if (priv) {
        outcomes.push({ doc_id: docId, action: "held", reasons: ["private page over patch budget \u2014 regenerates on push"] });
      } else {
        const res = await regenerate(group);
        outcomes.push({ doc_id: docId, action: res === "failed" ? "failed" : "regenerated", reasons: out.reasons });
        if (res === "failed")
          failures++;
        else
          patchCounts[docId] = 0;
      }
    } else if (out.action === "failed") {
      outcomes.push({ doc_id: docId, action: "failed", reasons: [out.reason] });
      failures++;
    } else if (out.action === "patched") {
      outcomes.push({ doc_id: docId, action: "patched" });
      patchCounts[docId] = (patchCounts[docId] ?? 0) + 1;
    } else {
      outcomes.push({ doc_id: docId, action: out.action });
    }
  }
  if (failures > 0 || pendingPublish > 0) {
    log3(`${failures} failed, ${pendingPublish} pending publish \u2014 sha NOT advanced, next turn redoes the window`);
    await releaseClaim(args.query, args.tableName, args.project, scope, {
      owner: args.owner,
      patchCounts,
      now: args.now
    });
    return { status: "incomplete", head, outcomes };
  }
  const committed = await commitRefresh(args.query, args.tableName, args.project, scope, head, patchCounts, {
    owner: args.owner,
    now: args.now
  });
  if (!committed.committed)
    return { status: "lost-lease", head, outcomes };
  return { status: "committed", head, outcomes };
}

// dist/src/docs/pull.js
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join3, resolve, sep } from "node:path";
var PULL_MANIFEST_DIR = ".hivemind";
var PULL_MANIFEST_FILE = "docs-pull.json";
var GITIGNORE_ENTRIES = ["*.hivemind.md", ".hivemind/"];
function localDocPath(docId) {
  const isWiki = docId.startsWith(WIKI_DOC_PREFIX);
  const rel = isWiki ? docId.slice(WIKI_DOC_PREFIX.length) : docId;
  if (rel === "" || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel))
    return null;
  if (rel.split("/").some((seg) => seg === ".." || seg === ""))
    return null;
  return isWiki ? `${rel}.wiki.hivemind.md` : `${rel}.hivemind.md`;
}
function readPullManifest(repoRoot) {
  try {
    const raw = JSON.parse(readFileSync3(join3(repoRoot, PULL_MANIFEST_DIR, PULL_MANIFEST_FILE), "utf-8"));
    return { cursor: typeof raw?.cursor === "string" ? raw.cursor : "" };
  } catch {
    return { cursor: "" };
  }
}
function writePullManifest(repoRoot, manifest) {
  const dir = join3(repoRoot, PULL_MANIFEST_DIR);
  mkdirSync2(dir, { recursive: true });
  writeFileSync3(join3(dir, PULL_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
}
function ensureGitignoreEntries(repoRoot) {
  const path = join3(repoRoot, ".gitignore");
  let current = "";
  try {
    current = readFileSync3(path, "utf-8");
  } catch {
  }
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length === 0)
    return false;
  const prefix = current === "" || current.endsWith("\n") ? current : current + "\n";
  writeFileSync3(path, prefix + missing.join("\n") + "\n");
  return true;
}
async function pullDocs(args) {
  const scope = args.scope ?? "main";
  const manifest = readPullManifest(args.repoRoot);
  const cursor = args.force ? "" : manifest.cursor;
  const safe = sqlIdent(args.tableName);
  const idPrefix = docRowId(args.project, scope, "");
  const cursorFilter = cursor === "" ? "" : ` AND updated_at >= '${sqlStr(cursor)}'`;
  const rows = await stableUnionRows(args.query, `SELECT id, doc_id, content, status, updated_at FROM "${safe}" WHERE id LIKE '${sqlLike(idPrefix)}%'${cursorFilter}`);
  const latest = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const doc_id = String(r.doc_id ?? "");
    if (doc_id === "" || doc_id === META_DOC_ID)
      continue;
    const updated_at = String(r.updated_at ?? "");
    const prev = latest.get(doc_id);
    if (!prev || updated_at > prev.updated_at) {
      latest.set(doc_id, { doc_id, content: String(r.content ?? ""), status: String(r.status ?? ""), updated_at });
    }
  }
  const written = [];
  const removed = [];
  let unchanged = 0;
  let maxSeen = manifest.cursor;
  const rootAbs = resolve(args.repoRoot);
  for (const doc of latest.values()) {
    if (doc.updated_at > maxSeen)
      maxSeen = doc.updated_at;
    const rel = localDocPath(doc.doc_id);
    if (rel === null)
      continue;
    const abs = resolve(rootAbs, rel);
    if (!abs.startsWith(rootAbs + sep))
      continue;
    if (doc.status !== "active") {
      if (existsSync3(abs)) {
        rmSync(abs);
        removed.push(rel);
      }
      continue;
    }
    const body = doc.content.endsWith("\n") ? doc.content : doc.content + "\n";
    let existing = null;
    try {
      existing = readFileSync3(abs, "utf-8");
    } catch {
    }
    if (existing === body) {
      unchanged++;
      continue;
    }
    mkdirSync2(dirname2(abs), { recursive: true });
    writeFileSync3(abs, body);
    written.push(rel);
  }
  ensureGitignoreEntries(args.repoRoot);
  writePullManifest(args.repoRoot, { cursor: maxSeen });
  return { written, removed, unchanged, cursor: maxSeen };
}

// dist/src/commands/docs.js
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";

// dist/src/docs/embed.js
import { dirname as dirname3, join as join6 } from "node:path";
import { fileURLToPath } from "node:url";

// dist/src/embeddings/client.js
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync, unlinkSync, existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";

// dist/src/embeddings/protocol.js
var DEFAULT_SOCKET_DIR = "/tmp";
var DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1e3;
var DEFAULT_CLIENT_TIMEOUT_MS = 2e3;
function socketPathFor(uid, dir = DEFAULT_SOCKET_DIR) {
  return `${dir}/hivemind-embed-${uid}.sock`;
}
function pidPathFor(uid, dir = DEFAULT_SOCKET_DIR) {
  return `${dir}/hivemind-embed-${uid}.pid`;
}

// dist/src/embeddings/client.js
var SHARED_DAEMON_PATH = join4(homedir2(), ".hivemind", "embed-deps", "embed-daemon.js");
var log2 = (m) => log("embed-client", m);
function getUid() {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid !== void 0 ? String(uid) : process.env.USER ?? "default";
}
var _recycledStuckDaemon = false;
var EmbedClient = class {
  socketPath;
  pidPath;
  timeoutMs;
  daemonEntry;
  autoSpawn;
  spawnWaitMs;
  nextId = 0;
  helloVerified = false;
  constructor(opts = {}) {
    const uid = getUid();
    const dir = opts.socketDir ?? "/tmp";
    this.socketPath = socketPathFor(uid, dir);
    this.pidPath = pidPathFor(uid, dir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.daemonEntry = opts.daemonEntry ?? process.env.HIVEMIND_EMBED_DAEMON ?? (existsSync4(SHARED_DAEMON_PATH) ? SHARED_DAEMON_PATH : void 0);
    this.autoSpawn = opts.autoSpawn ?? true;
    this.spawnWaitMs = opts.spawnWaitMs ?? 5e3;
  }
  /**
   * Returns an embedding vector, or null on timeout/failure. Hooks MUST treat
   * null as "skip embedding column" — never block the write path on us.
   *
   * Fire-and-forget spawn on miss: if the daemon isn't up, this call returns
   * null AND kicks off a background spawn. The next call finds a ready daemon.
   *
   * Stuck-daemon recycle: if the daemon returns a transformers-missing
   * error (typical after a marketplace upgrade left an older daemon process
   * alive but with no node_modules accessible from its bundle path), we
   * SIGTERM it and clear its sock/pid so the very next call spawns a fresh
   * daemon from the current bundle. Without this, the stuck daemon would
   * keep poisoning every session until its 10-minute idle-out fires.
   */
  async embed(text, kind = "document") {
    const v = await this.embedAttempt(text, kind);
    if (v !== "recycled")
      return v;
    if (!this.autoSpawn)
      return null;
    this.trySpawnDaemon();
    await this.waitForDaemonReady();
    const retry = await this.embedAttempt(text, kind);
    return retry === "recycled" ? null : retry;
  }
  /**
   * One round-trip: connect → verify → embed. Returns:
   *  - number[]  : embedding vector (happy path)
   *  - null      : timeout / daemon error / transformers-missing
   *  - "recycled": verifyDaemonOnce killed the daemon mid-call;
   *                caller should respawn and retry once.
   */
  async embedAttempt(text, kind) {
    let sock;
    try {
      sock = await this.connectOnce();
    } catch {
      if (this.autoSpawn)
        this.trySpawnDaemon();
      return null;
    }
    try {
      const recycled = await this.verifyDaemonOnce(sock);
      if (recycled) {
        return "recycled";
      }
      const id = String(++this.nextId);
      const req = { op: "embed", id, kind, text };
      const resp = await this.sendAndWait(sock, req);
      if (resp.error || !("embedding" in resp) || !resp.embedding) {
        const err = resp.error ?? "no embedding";
        log2(`embed err: ${err}`);
        if (isTransformersMissingError(err)) {
          this.handleTransformersMissing(err);
        }
        return null;
      }
      return resp.embedding;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log2(`embed failed: ${err}`);
      return null;
    } finally {
      try {
        sock.end();
      } catch {
      }
    }
  }
  /**
   * Poll for the sock file to come back after `trySpawnDaemon` — used by
   * the recycle retry path. Best-effort: caps at `spawnWaitMs` and
   * returns regardless so the retry attempt can run.
   */
  async waitForDaemonReady() {
    const deadline = Date.now() + this.spawnWaitMs;
    while (Date.now() < deadline) {
      if (existsSync4(this.socketPath))
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /**
   * Send a `hello` on first successful connect per EmbedClient instance.
   * If the daemon answers with a path that doesn't match our configured
   * daemonEntry — typical after a marketplace upgrade replaced the bundle
   * — SIGTERM the daemon + clear sock/pid so the next call spawns from the
   * current bundle.
   *
   * `helloVerified` is set ONLY after we've seen a compatible response,
   * so a transient probe failure or a recycle-triggering mismatch leaves
   * the flag false; the next reconnect re-runs verification against
   * whatever daemon is then live (typically the fresh spawn).
   */
  async verifyDaemonOnce(sock) {
    if (this.helloVerified)
      return false;
    if (!this.daemonEntry) {
      this.helloVerified = true;
      return false;
    }
    const id = String(++this.nextId);
    const req = { op: "hello", id };
    let resp;
    try {
      resp = await this.sendAndWait(sock, req);
    } catch (e) {
      log2(`hello probe failed (inconclusive, will retry next connect): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const hello = resp;
    if (_recycledStuckDaemon) {
      return false;
    }
    if (!hello.daemonPath) {
      _recycledStuckDaemon = true;
      log2(`daemon does not implement hello (older protocol); recycling`);
      this.recycleDaemon(hello.pid);
      return true;
    }
    if (hello.daemonPath !== this.daemonEntry && !existsSync4(hello.daemonPath)) {
      _recycledStuckDaemon = true;
      log2(`daemon path no longer on disk \u2014 running=${hello.daemonPath} (gone) expected=${this.daemonEntry}; recycling`);
      this.recycleDaemon(hello.pid);
      return true;
    }
    this.helloVerified = true;
    return false;
  }
  /**
   * On a transformers-missing error from the daemon, SIGTERM the stuck
   * daemon (the bundle daemon that can't find its deps) and clear
   * sock/pid so the next call spawns fresh.
   *
   * Previously this also enqueued a user-visible "Hivemind embeddings
   * disabled — deps missing" notification telling the user to run
   * `hivemind embeddings install`. The notification was removed because
   * (a) the recycle alone often fixes the issue silently, and (b) the
   * warning kept stacking on top of the primary session-start banner
   * which clashed with the single-slot priority model. The `detail`
   * argument is retained for future telemetry / debug logging.
   */
  handleTransformersMissing(_detail) {
    if (!_recycledStuckDaemon) {
      _recycledStuckDaemon = true;
      this.recycleDaemon(null);
    }
  }
  /**
   * Best-effort SIGTERM + sock/pid cleanup. Tolerant of every missing-file
   * combination and dead-PID cases.
   *
   * Identity check: gate the SIGTERM on the daemon's socket file still
   * existing. We know the daemon was alive moments ago (we either just
   * got a hello response or the caller saw a transformers-missing error
   * the daemon emitted), but if the socket file is gone by the time we
   * try to kill, the daemon process is also gone and the PID we
   * captured may already have been recycled by the OS to an unrelated
   * user process. Mirrors the gate added to `killEmbedDaemon` in the
   * CLI — same failure mode, rarer trigger.
   */
  recycleDaemon(reportedPid) {
    let pid = reportedPid;
    if (pid === null) {
      try {
        pid = Number.parseInt(readFileSync4(this.pidPath, "utf-8").trim(), 10);
      } catch {
      }
    }
    if (Number.isFinite(pid) && pid !== null && pid > 0 && existsSync4(this.socketPath)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    } else if (pid !== null) {
      log2(`recycle: socket gone, skipping SIGTERM on possibly-stale pid ${pid}`);
    }
    try {
      unlinkSync(this.socketPath);
    } catch {
    }
    try {
      unlinkSync(this.pidPath);
    } catch {
    }
  }
  /**
   * Wait up to spawnWaitMs for the daemon to accept connections, spawning if
   * necessary. Meant for SessionStart / long-running batches — not the hot path.
   */
  async warmup() {
    try {
      const s = await this.connectOnce();
      s.end();
      return true;
    } catch {
      if (!this.autoSpawn)
        return false;
      this.trySpawnDaemon();
      try {
        const s = await this.waitForSocket();
        s.end();
        return true;
      } catch {
        return false;
      }
    }
  }
  connectOnce() {
    return new Promise((resolve2, reject) => {
      const sock = connect(this.socketPath);
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("connect timeout"));
      }, this.timeoutMs);
      sock.once("connect", () => {
        clearTimeout(to);
        resolve2(sock);
      });
      sock.once("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
    });
  }
  trySpawnDaemon() {
    let fd;
    try {
      fd = openSync(this.pidPath, "wx", 384);
      writeSync(fd, String(process.pid));
    } catch (e) {
      if (this.isPidFileStale()) {
        try {
          unlinkSync(this.pidPath);
        } catch {
        }
        try {
          fd = openSync(this.pidPath, "wx", 384);
          writeSync(fd, String(process.pid));
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    if (!this.daemonEntry || !existsSync4(this.daemonEntry)) {
      log2(`daemonEntry not configured or missing: ${this.daemonEntry}`);
      try {
        closeSync(fd);
        unlinkSync(this.pidPath);
      } catch {
      }
      return;
    }
    try {
      const child = spawn(process.execPath, [this.daemonEntry], {
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      log2(`spawned daemon pid=${child.pid}`);
    } finally {
      closeSync(fd);
    }
  }
  isPidFileStale() {
    try {
      const raw = readFileSync4(this.pidPath, "utf-8").trim();
      const pid = Number(raw);
      if (!pid || Number.isNaN(pid))
        return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }
  async waitForSocket() {
    const deadline = Date.now() + this.spawnWaitMs;
    let delay = 30;
    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 300);
      if (!existsSync4(this.socketPath))
        continue;
      try {
        return await this.connectOnce();
      } catch {
      }
    }
    throw new Error("daemon did not become ready within spawnWaitMs");
  }
  sendAndWait(sock, req) {
    return new Promise((resolve2, reject) => {
      let buf = "";
      const to = setTimeout(() => {
        sock.destroy();
        reject(new Error("request timeout"));
      }, this.timeoutMs);
      sock.setEncoding("utf-8");
      sock.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1)
          return;
        const line = buf.slice(0, nl);
        clearTimeout(to);
        try {
          resolve2(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      });
      sock.on("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
      sock.on("end", () => {
        clearTimeout(to);
        reject(new Error("connection closed without response"));
      });
      sock.write(JSON.stringify(req) + "\n");
    });
  }
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isTransformersMissingError(err) {
  if (/hivemind embeddings install/i.test(err))
    return true;
  return /@huggingface\/transformers/i.test(err);
}

// dist/src/embeddings/disable.js
import { createRequire } from "node:module";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
import { pathToFileURL } from "node:url";
var cachedStatus = null;
function defaultResolveTransformers() {
  const sharedDir = join5(homedir3(), ".hivemind", "embed-deps");
  try {
    createRequire(pathToFileURL(`${sharedDir}/`).href).resolve("@huggingface/transformers");
    return;
  } catch {
  }
  createRequire(import.meta.url).resolve("@huggingface/transformers");
}
var _resolve = defaultResolveTransformers;
var _readEnabled = getEmbeddingsEnabled;
function detectStatus() {
  if (!_readEnabled())
    return "user-disabled";
  try {
    _resolve();
    return "enabled";
  } catch {
    return "no-transformers";
  }
}
function embeddingsStatus() {
  if (cachedStatus !== null)
    return cachedStatus;
  cachedStatus = detectStatus();
  return cachedStatus;
}
function embeddingsDisabled() {
  return embeddingsStatus() !== "enabled";
}

// dist/src/docs/embed.js
function resolveEmbedDaemonPath() {
  return join6(dirname3(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
}
function makeDocEmbedder() {
  if (embeddingsDisabled())
    return async () => null;
  const client = new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() });
  return async (text) => {
    try {
      return await client.embed(text, "document");
    } catch {
      return null;
    }
  };
}

// dist/src/docs/backfill.js
async function backfillDocEmbeddings(query, tableName, embed, concurrency = 4) {
  const safe = sqlIdent(tableName);
  const rows = await query(`SELECT id, content, ARRAY_LENGTH(content_embedding, 1) AS dims FROM "${safe}" WHERE status = 'active'`);
  const missing = rows.filter((r) => r["dims"] == null || Number(r["dims"]) === 0);
  let embedded = 0;
  await runPool(missing, concurrency, async (r) => {
    const vec = await embed(String(r["content"] ?? ""));
    if (!vec || vec.length === 0)
      return;
    await query(`UPDATE "${safe}" SET content_embedding = ${embeddingSqlLiteral(vec)} WHERE id = '${sqlStr(String(r["id"]))}'`);
    embedded++;
  });
  return { scanned: rows.length, embedded, skipped: rows.length - embedded };
}

// dist/src/commands/docs.js
var USAGE = `
hivemind docs \u2014 documentation that stays in sync with the code

Everyday:
  hivemind docs list [--repos] [--all] [--project P]
      Status header for this repo (root, org, auto ON/off, sync freshness,
      graph) + THIS repo's pages. --project P shows another repo's pages
      (accepts a repo name, path, or key prefix). --all shows every repo,
      grouped one section per repo. --repos lists every repo registered
      for auto sync.
  hivemind docs sync [--cwd <dir>] [--force] [--local]
      Bring the docs up to date with the code (wiki pages + per-file docs).
      Builds the code graph under the hood if missing. First interactive run
      on an empty corpus walks the same consent flow as graph init. --local
      previews WIKI-page patches on the working tree only (never writes the
      table; per-file docs have no local preview).
  hivemind docs pull [--cwd <dir>] [--project P] [--scope S] [--force]
      Materialize the docs locally as gitignored *.hivemind.md files next to
      the code. Incremental (local cursor); --force re-pulls everything.
  hivemind docs auto on|off [--cwd <dir>]
      Turn automatic per-commit sync on/off for THIS repo on THIS org.
      Enabling with no corpus asks for explicit confirmation (LLM cost).
  hivemind docs agent [claude|codex|pi|cursor]
      Show or set which host CLI authors the docs (persisted globally).
      No arg \u2192 show current + installed. Overridable per-run with
      HIVEMIND_DOCS_LLM_AGENT.
  hivemind docs show <doc-id>

Advanced / plumbing:
  hivemind docs wiki [--cwd] [--include] [--exclude] [--limit] [--concurrency] [--force] [--dry-run]
      Generate the narrative wiki pages (one per subsystem) explicitly.
  hivemind docs wiki-refresh [--cwd] [--force] [--local]
      One lease-guarded wiki refresh cycle (what sync/auto run for you).
  hivemind docs refresh [--cwd <dir>] [--dry-run]
      Per-file docs drift refresh (what sync runs for you).
  hivemind docs generate [--cwd] [--scope file|symbol] [--include] [--exclude]
                         [--limit] [--concurrency] [--batch] [--project P]
                         [--force] [--dry-run]
      Auto-author per-file docs from the AST graph. Batches 5 files/call.
  hivemind docs set <doc-id> ["<markdown>"] [--file <path>] [--project P] [--tier fast|slow] [--path <vfs-path>]
  hivemind docs index [<dir>]
  hivemind docs archive <doc-id>
  hivemind docs reindex
      Backfill semantic-search vectors for docs that lack them (no LLM).
`.trim();
function gitHeadOf(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function hookInstalledAt(cwd) {
  const p = postCommitHookPath(cwd);
  if (!p)
    return false;
  try {
    return existsSync5(p) && containsOurMarkers(readFileSync5(p, "utf8"));
  } catch {
    return false;
  }
}
function wikiFreshnessHint(state) {
  if (state.autoEnabled && state.hookInstalled)
    return null;
  if (state.autoEnabled) {
    return "Auto refresh is ON (updates on session start). For instant per-commit refresh: hivemind graph init";
  }
  const base = `${state.subject} will NOT stay fresh \u2014 nothing refreshes it yet. Enable per-session refresh: hivemind docs auto on`;
  return state.hookInstalled ? base : `${base} (and per-commit refresh: hivemind graph init)`;
}
async function offerAutoRefresh(cfg, project, cwd, subject) {
  if (isAutoEnabled(cfg.orgId, project))
    return;
  const io = defaultIo();
  if (io.interactive) {
    const a = await io.ask(`
Keep ${subject} fresh automatically on every commit? [y/N] `);
    if (/^y(es)?$/i.test(a.trim())) {
      setAuto({ orgId: cfg.orgId, orgName: cfg.orgName, project, path: cwd, auto: true });
      console.log("Auto refresh ON. For instant per-commit refresh also run: hivemind graph init");
      return;
    }
  }
  const sentenceSubject = subject.charAt(0).toUpperCase() + subject.slice(1);
  const hint = wikiFreshnessHint({ autoEnabled: false, hookInstalled: hookInstalledAt(cwd), subject: sentenceSubject });
  if (hint)
    console.log(`
${hint}`);
}
function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run `hivemind login` first.");
    process.exit(2);
    throw new Error("unreachable");
  }
  return cfg;
}
function makeApi(cfg) {
  return new DeeplakeApi(cfg.token, cfg.apiUrl, cfg.orgId, cfg.workspaceId, cfg.tableName);
}
function flagValue(args, name) {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1)
    return void 0;
  return args[idx].includes("=") ? args[idx].split("=", 2)[1] : args[idx + 1];
}
function flagValues(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      if (args[i + 1] !== void 0)
        out.push(args[i + 1]);
      i++;
    } else if (a.startsWith(`${name}=`)) {
      out.push(a.split("=", 2)[1]);
    }
  }
  return out;
}
function parseStatus(args) {
  const raw = flagValue(args, "--status");
  if (raw === void 0)
    return "active";
  if (raw === "active" || raw === "archived" || raw === "all")
    return raw;
  console.error(`Invalid --status value: ${raw}. Allowed: active | archived | all.`);
  process.exit(1);
  throw new Error("unreachable");
}
function parseTier(args) {
  const raw = flagValue(args, "--tier");
  if (raw === void 0)
    return "fast";
  if (raw === "fast" || raw === "slow")
    return raw;
  console.error(`Invalid --tier value: ${raw}. Allowed: fast | slow.`);
  process.exit(1);
  throw new Error("unreachable");
}
function parseOptionalLimit(args) {
  const raw = flagValue(args, "--limit");
  if (raw === void 0)
    return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`Invalid --limit value: ${raw}. Must be a positive integer.`);
    process.exit(1);
    throw new Error("unreachable");
  }
  return n;
}
function parseLimit(args) {
  return parseOptionalLimit(args) ?? 200;
}
var KNOWN_FLAGS = /* @__PURE__ */ new Set(["--file", "--project", "--tier", "--path", "--status", "--limit", "--cwd", "--dry-run", "--anchor", "--scope", "--include", "--exclude", "--concurrency", "--force", "--batch", "--local", "--repos", "--full", "--all"]);
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["--dry-run", "--force", "--local", "--repos", "--full", "--all"]);
function stripKnownFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (KNOWN_FLAGS.has(a)) {
      if (!BOOLEAN_FLAGS.has(a))
        i++;
      continue;
    }
    if (KNOWN_FLAGS.has(a.split("=", 2)[0]))
      continue;
    out.push(a);
  }
  return out;
}
function resolveContent(positionalContent, args) {
  const file = flagValue(args, "--file");
  if (file !== void 0)
    return readFileSync5(file, "utf-8");
  if (positionalContent === "-")
    return readFileSync5(0, "utf-8");
  return positionalContent ?? "";
}
function defaultVfsPath(project, docId) {
  const proj = project || "default";
  return `/docs/${proj}/${docId}.md`;
}
function formatListRow(r) {
  const tag = r.status === "archived" ? "[archived]" : "[active]";
  const anchors = r.anchors.length === 1 ? "1 anchor" : `${r.anchors.length} anchors`;
  return `${tag} ${r.doc_id}  v${r.version}  (${r.tier}, ${anchors})  ${r.path}`;
}
function resolveProjectArg(arg) {
  const entries = listEntries();
  const byPath = entries.find((e) => e.path === arg || e.path.split("/").pop() === arg || e.path.endsWith(`/${arg}`));
  if (byPath)
    return byPath.project;
  const byPrefix = entries.filter((e) => e.project.startsWith(arg));
  if (byPrefix.length === 1)
    return byPrefix[0].project;
  return arg;
}
var ALL_VIEW_PER_REPO_CAP = 20;
function printGroupedByRepo(rows) {
  const entries = listEntries();
  const nameOf = new Map(entries.map((e) => [e.project, e.path]));
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const k = r.project ?? "";
    if (!groups.has(k))
      groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [proj, group] of groups) {
    const label = proj === "" ? "(legacy rows \u2014 no project stamp)" : nameOf.get(proj) ?? `project ${proj}`;
    console.log(`
${label}${proj && nameOf.has(proj) ? `  (project: ${proj})` : ""}  \u2014  ${group.length} page(s)`);
    console.log("\u2500".repeat(60));
    for (const r of group.slice(0, ALL_VIEW_PER_REPO_CAP))
      console.log(formatListRow(r));
    if (group.length > ALL_VIEW_PER_REPO_CAP) {
      const more = group.length - ALL_VIEW_PER_REPO_CAP;
      const ref = proj ? nameOf.get(proj)?.split("/").pop() ?? proj.slice(0, 8) : "";
      console.log(`  (+${more} more \u2014 hivemind docs list --project ${ref})`);
    }
  }
}
async function runDocsCommand(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(USAGE);
    return;
  }
  if (sub === "agent") {
    const name = args[1];
    const installed = detectAvailableAgents();
    if (!name) {
      const cur = getDocsLlmAgent();
      console.log(`Docs LLM agent: ${cur ?? `auto (${installed[0] ?? "none installed"})`}`);
      console.log(`Installed on PATH: ${installed.join(", ") || "none"}`);
      console.log(`Set with: hivemind docs agent <${knownDocsAgents().join("|")}>  (or HIVEMIND_DOCS_LLM_BIN for any other CLI)`);
      return;
    }
    const lname = name.toLowerCase();
    if (!knownDocsAgents().includes(lname)) {
      console.error(`Unknown agent "${name}". Known: ${knownDocsAgents().join(", ")}. For any other CLI use HIVEMIND_DOCS_LLM_BIN.`);
      process.exit(1);
      throw new Error("unreachable");
    }
    if (!installed.includes(lname)) {
      console.error(`Warning: "${lname}" is not installed on PATH \u2014 doc generation will fail until it is.`);
    }
    setDocsLlmAgent(lname);
    console.log(`Docs LLM agent set to: ${lname}. Change with: hivemind docs agent <name>.`);
    return;
  }
  const cfg = requireConfig();
  const api = makeApi(cfg);
  const tableName = cfg.docsTableName;
  const query = api.query.bind(api);
  const pluginVersion = getVersion();
  const WRITE_SUBS = /* @__PURE__ */ new Set(["set", "archive"]);
  if (WRITE_SUBS.has(sub)) {
    await api.ensureDocsTable(tableName);
  }
  if (sub === "set") {
    const positional = stripKnownFlags(args.slice(1));
    const docId = positional[0];
    if (!docId) {
      console.error('Missing doc-id. Usage: hivemind docs set <doc-id> "<markdown>" [--file <path>]');
      process.exit(1);
      throw new Error("unreachable");
    }
    const project = flagValue(args, "--project") ?? "";
    const path = flagValue(args, "--path") ?? defaultVfsPath(project, docId);
    const tier = parseTier(args);
    const anchorIds = flagValues(args, "--anchor");
    let anchors;
    if (anchorIds.length > 0) {
      const snap = loadCurrentSnapshot(flagValue(args, "--cwd") ?? process.cwd());
      if (!snap) {
        console.error("--anchor needs a built graph. Run `hivemind graph build` first.");
        process.exit(1);
        throw new Error("unreachable");
      }
      const nodeById = new Map(snap.nodes.map((n) => [n.id, n]));
      anchors = [];
      for (const sid of anchorIds) {
        const node = nodeById.get(sid);
        if (!node) {
          console.error(`--anchor: symbol not in graph: ${sid}`);
          process.exit(1);
          throw new Error("unreachable");
        }
        const a = buildAnchor(node, flagValue(args, "--cwd") ?? process.cwd());
        if (!a) {
          console.error(`--anchor: could not read source for ${sid}`);
          process.exit(1);
          throw new Error("unreachable");
        }
        anchors.push(a);
      }
    }
    try {
      const content = resolveContent(positional[1], args);
      const out = await setDoc(query, tableName, {
        doc_id: docId,
        path,
        content,
        anchors,
        tier,
        project,
        agent: cfg.userName,
        plugin_version: pluginVersion
      }, { project: flagValue(args, "--project") });
      console.log(`Set doc ${out.doc_id} \u2192 v${out.version}.`);
    } catch (err) {
      console.error(`Set failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  if (sub === "index") {
    const atDir = (stripKnownFlags(args.slice(1))[0] ?? "").replace(/\/+$/, "");
    let meta = [];
    try {
      const rows = await listDocMeta(query, tableName, { dirPrefix: atDir });
      meta = rows.map((r) => ({
        doc_id: r.doc_id,
        version: r.version,
        updated_at: r.updated_at,
        status: r.status,
        tier: r.tier
      }));
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    const directFiles = meta.filter((m) => m.status === "active" && dirOf(m.doc_id) === atDir).map((m) => m.doc_id);
    const summaries = /* @__PURE__ */ new Map();
    if (directFiles.length > 0) {
      try {
        for (const d of await listDocsByIds(query, tableName, directFiles)) {
          summaries.set(d.doc_id, firstDocLine(d.content));
        }
      } catch (err) {
        if (!isMissingTableError(err.message))
          throw err;
      }
    }
    console.log(buildDocsIndex(meta, atDir, summaries));
    return;
  }
  if (sub === "show") {
    const docId = stripKnownFlags(args.slice(1))[0];
    if (!docId) {
      console.error("Usage: hivemind docs show <doc-id>");
      process.exit(1);
      throw new Error("unreachable");
    }
    let row = null;
    try {
      const showCwd = flagValue(args, "--cwd") ?? process.cwd();
      row = await getDocLatest(query, tableName, docId, { readerScope: currentScope(defaultGit(showCwd)) });
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    if (!row) {
      console.log(`(no doc for ${docId})`);
      return;
    }
    console.log(`# ${row.doc_id}`);
    console.log(`version: ${row.version}  tier: ${row.tier}  status: ${row.status}`);
    console.log(`project: ${row.project}  path: ${row.path}`);
    console.log(`created: ${row.created_at}  updated: ${row.updated_at}`);
    console.log(`anchors: ${row.anchors.length}`);
    console.log("---");
    console.log(row.content);
    return;
  }
  if (sub === "list") {
    if (args.includes("--repos")) {
      const entries = listEntries();
      if (entries.length === 0) {
        console.log("(no repos registered \u2014 enable one with `hivemind docs auto on` or via `hivemind graph init`)");
        return;
      }
      for (const e of entries) {
        console.log(`${e.auto ? "AUTO " : "  off"}  ${e.path}  (org: ${e.orgName ?? e.orgId}, project: ${e.project})`);
      }
      return;
    }
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const headerProject = deriveProjectKey(cwd).key;
    const root = tryGitTopLevel(cwd) ?? cwd;
    const entry = findEntry(cfg.orgId, headerProject);
    const headerSnap = loadCurrentSnapshot(cwd);
    const snapOk = headerSnap !== null;
    const status = parseStatus(args.slice(1));
    const limit = parseLimit(args.slice(1));
    const explicitProject = flagValue(args, "--project");
    const notARepo = !snapOk && entry === void 0 && explicitProject === void 0;
    const allView = args.includes("--all") || notARepo;
    if (notARepo) {
      console.log(`${root} is not a docs-enabled repo \u2014 showing every repo in org ${cfg.orgName ?? cfg.orgId}. Register one with \`hivemind graph init\` (or \`hivemind docs auto on\` inside a repo).`);
    } else {
      let freshness = "never synced";
      try {
        const meta = await readRefreshMeta(query, tableName, headerProject, "main");
        if (meta?.meta.last_refresh_sha) {
          const head = gitHeadOf(cwd);
          if (head === null)
            freshness = "no git";
          else if (head === meta.meta.last_refresh_sha)
            freshness = "in sync (HEAD)";
          else
            freshness = `behind HEAD (last: ${meta.meta.last_refresh_sha.slice(0, 8)})`;
        }
      } catch (err) {
        if (!isMissingTableError(err.message))
          throw err;
      }
      console.log(`repo: ${root}  org: ${cfg.orgName ?? cfg.orgId}  auto: ${entry?.auto ? "ON" : "off"}  sync: ${freshness}  graph: ${snapOk ? "ok" : "missing"}`);
      console.log("\u2500".repeat(60));
    }
    let rows = [];
    try {
      rows = allView ? await listDocs(query, tableName, { status, limit }) : await listDocs(query, tableName, { status, projectOrLegacy: explicitProject !== void 0 ? resolveProjectArg(explicitProject) : headerProject, limit, readerScope: explicitProject === void 0 ? currentScope(defaultGit(flagValue(args, "--cwd") ?? process.cwd())) : void 0 });
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    if (allView) {
      if (rows.length === 0)
        console.log(`(no docs with status=${status})`);
      else
        printGroupedByRepo(rows);
      return;
    }
    if (rows.length === 0)
      console.log(`(no docs with status=${status})`);
    else
      for (const r of rows)
        console.log(formatListRow(r));
    if (explicitProject === void 0 && headerSnap) {
      const planned = selectWikiGroups(headerSnap).filter((g) => wikiGroupEligible(g.files, root));
      if (planned.length > 0) {
        const have = new Set(rows.filter((r) => r.doc_id.startsWith(WIKI_DOC_PREFIX)).map((r) => r.doc_id));
        const pending = planned.filter((g) => !have.has(wikiDocId(g.key)));
        if (pending.length === 0) {
          console.log(`
wiki: ${planned.length}/${planned.length} pages generated`);
        } else {
          console.log(`
wiki: ${planned.length - pending.length}/${planned.length} pages generated \u2014 pending: ${pending.map((g) => wikiDocId(g.key)).join(", ")}`);
          console.log("  (a background generation may still be running; kick one explicitly with `hivemind docs wiki`)");
        }
      }
    }
    return;
  }
  if (sub === "archive") {
    const docId = stripKnownFlags(args.slice(1))[0];
    if (!docId) {
      console.error("Usage: hivemind docs archive <doc-id>");
      process.exit(1);
      throw new Error("unreachable");
    }
    try {
      const out = await archiveDoc(query, tableName, {
        doc_id: docId,
        agent: cfg.userName,
        plugin_version: pluginVersion
      }, { project: flagValue(args, "--project") });
      console.log(`Archived doc ${out.doc_id} \u2192 v${out.version}.`);
    } catch (err) {
      console.error(`Archive failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  if (sub === "refresh") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const dryRun = args.includes("--dry-run");
    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    const changed = args.includes("--full") ? null : changedFilesFromGit(cwd);
    let docs = [];
    try {
      if (changed !== null) {
        const candidates = expandToCandidateFiles(snap, changed);
        docs = await listDocsByIds(query, tableName, candidates, { projectOrLegacy: deriveProjectKey(cwd).key });
        docs = docs.filter((d) => d.status === "active");
        console.error(`[docs refresh] scoped to ${candidates.length} candidate file(s) from git diff (${changed.length} changed)`);
      } else {
        docs = await listDocs(query, tableName, { status: "active", limit: 1e5, projectOrLegacy: deriveProjectKey(cwd).key });
        console.error(`[docs refresh] no git signal \u2014 full scan of ${docs.length} doc(s)`);
      }
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    const impacted = computeImpactedDocs({ snap, docs, repoRoot: cwd });
    if (dryRun) {
      if (impacted.length === 0) {
        console.log("(no docs need refreshing \u2014 all anchors fresh)");
      } else {
        console.log(`${impacted.length} doc(s) would be refreshed:`);
        for (const i of impacted) {
          console.log(`  ${i.doc_id}  [${i.reasons.map((r) => r.kind).join(", ")}]`);
        }
      }
      return;
    }
    await api.ensureDocsTable(tableName);
    if (impacted.length === 0) {
      console.log("(no docs need refreshing \u2014 all anchors fresh)");
    } else {
      const docsById = new Map(docs.map((d) => [d.doc_id, d]));
      const report = await refreshDocs({
        query,
        tableName,
        snap,
        repoRoot: cwd,
        impacted,
        docsById,
        generate: makeHostGenerate(),
        embed: makeDocEmbedder(),
        agent: cfg.userName,
        pluginVersion
      });
      console.log(`Refreshed ${report.refreshed}, archived ${report.archived}, rejected ${report.rejected}, skipped ${report.skipped}.`);
      for (const o of report.outcomes) {
        if (o.status === "refreshed")
          console.log(`  refreshed ${o.doc_id} \u2192 v${o.version}`);
        else if (o.status === "archived")
          console.log(`  archived ${o.doc_id} \u2192 v${o.version} (${(o.reasons ?? []).join("; ")})`);
        else
          console.log(`  ${o.status} ${o.doc_id}: ${(o.reasons ?? []).join("; ")}`);
      }
    }
    if (changed !== null && changed.length > 0) {
      const existing = new Set(docs.map((d) => d.doc_id));
      const genReport = await generateDocs({
        query,
        tableName,
        snap,
        repoRoot: cwd,
        project: deriveProjectKey(cwd).key,
        include: changed,
        existing,
        generate: makeHostGenerateDoc(),
        embed: makeDocEmbedder(),
        agent: cfg.userName,
        pluginVersion
      });
      if (genReport.created > 0) {
        console.log(`Generated ${genReport.created} new doc(s) for added files:`);
        for (const o of genReport.outcomes) {
          if (o.status === "created")
            console.log(`  created ${o.doc_id}`);
        }
      }
    }
    return;
  }
  if (sub === "wiki-refresh") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const force = args.includes("--force");
    const local = args.includes("--local");
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;
    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    const git = (gitArgs) => {
      try {
        return execFileSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };
    if (local) {
      const report2 = await runLocalWikiRefresh({ snap, repoRoot: cwd, run: makeHostRunPrompt(), git });
      if (report2.outcomes.length === 0) {
        console.log("Local wiki preview: nothing touched by the working tree.");
      } else {
        console.log(`Local wiki preview: ${report2.outcomes.length} page(s) considered.`);
        for (const o of report2.outcomes) {
          console.log(`  ${o.action} ${o.file}${o.reasons ? ` (${o.reasons.join("; ")})` : ""}`);
        }
      }
      return;
    }
    await api.ensureDocsTable(tableName);
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS)
      process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    const report = await runWikiRefreshCycle({
      query,
      tableName,
      snap,
      repoRoot: cwd,
      project,
      // Branch identity: on the trunk this is `main` (canonical corpus); on a
      // feature branch it is `b:<branch>`, so the refresh reads/writes/leases
      // its own overlay and never touches main.
      scope: currentScope(git),
      run: makeHostRunPrompt(),
      runPage: makeHostPageRunPrompt(),
      git,
      owner: `${userInfo().username}@${hostname()}:${process.pid}`,
      force,
      // Tuning knob (NOT a consent switch — that is the registry): shortens
      // the 6h quiet period for e2e tests and impatient operators.
      minPeriodMs: Number(process.env.HIVEMIND_DOCS_MIN_PERIOD_MS ?? "") || void 0,
      // Snapshots live under the repo-derived key even when --project overrides
      // the table stamp.
      loadSnapshotAt: (sha) => loadSnapshotByCommit(repoDir(deriveProjectKey(cwd).key), sha),
      embed: makeDocEmbedder(),
      agent: cfg.userName,
      pluginVersion,
      log: (m) => console.error(`[wiki-refresh] ${m}`)
    });
    console.log(`Wiki refresh: ${report.status}${report.head ? ` @ ${report.head.slice(0, 8)}` : ""}.`);
    for (const o of report.outcomes) {
      console.log(`  ${o.action} ${o.doc_id}${o.reasons ? ` (${o.reasons.join("; ")})` : ""}`);
    }
    return;
  }
  if (sub === "sync") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const force = args.includes("--force");
    const local = args.includes("--local");
    const project = deriveProjectKey(cwd).key;
    const io = defaultIo();
    if (!io.interactive && !isAutoEnabled(cfg.orgId, project)) {
      console.log("docs sync: auto not enabled for this repo on this org \u2014 nothing to do (enable with `hivemind docs auto on`).");
      return;
    }
    if (!loadCurrentSnapshot(cwd)) {
      console.log("Building code graph first (no LLM)...");
      const { runBuildCommand } = await import("./graph-JCAYBZ4M.js");
      await runBuildCommand(["--cwd", cwd, "--trigger", "manual"]);
    }
    if (io.interactive) {
      let pages = 0;
      try {
        const rows = await listDocs(query, tableName, { project, status: "active", limit: 1e5 });
        pages = rows.filter((r) => r.doc_id.startsWith(WIKI_DOC_PREFIX)).length;
      } catch (err) {
        if (!isMissingTableError(err.message))
          throw err;
      }
      if (pages === 0) {
        const result = await runDocsOnboarding({
          root: tryGitTopLevel(cwd) ?? cwd,
          isGitRepo: tryGitTopLevel(cwd) !== null,
          orgId: cfg.orgId,
          orgName: cfg.orgName,
          project,
          snap: loadCurrentSnapshot(cwd),
          io
        });
        if (!result.generate)
          return;
      }
    }
    if (local) {
      await runDocsCommand(["wiki-refresh", "--cwd", cwd, "--local"]);
      return;
    }
    await runDocsCommand(["wiki-refresh", "--cwd", cwd, ...force ? ["--force"] : []]);
    await runDocsCommand(["refresh", "--cwd", cwd, "--full"]);
    return;
  }
  if (sub === "auto") {
    const mode = args[1];
    if (mode !== "on" && mode !== "off") {
      console.error("Usage: hivemind docs auto on|off [--cwd <dir>]");
      process.exit(1);
      throw new Error("unreachable");
    }
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const project = deriveProjectKey(cwd).key;
    if (mode === "off") {
      setAuto({ orgId: cfg.orgId, orgName: cfg.orgName, project, path: cwd, auto: false });
      console.log(`Auto sync OFF for this repo on org ${cfg.orgName ?? cfg.orgId}.`);
      return;
    }
    const snap = loadCurrentSnapshot(cwd);
    let pages = 0;
    try {
      const rows = await listDocs(query, tableName, { project, status: "active", limit: 1e5 });
      pages = rows.filter((r) => r.doc_id.startsWith(WIKI_DOC_PREFIX)).length;
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    if (pages === 0) {
      const est = snap ? `~${selectWikiGroups(snap).length} pages` : "the full corpus";
      const io = defaultIo();
      if (!io.interactive) {
        console.error(`No wiki corpus yet for this repo \u2014 enabling auto would generate ${est} on the first cycle. Run interactively (or generate first with \`hivemind docs wiki\`).`);
        process.exit(1);
        throw new Error("unreachable");
      }
      const a = await io.ask(`No wiki corpus yet: ${est} will be generated on the first cycle (LLM cost). Proceed? [y/N] `);
      if (!/^y(es)?$/i.test(a.trim())) {
        console.log("Left OFF. Generate first with: hivemind docs wiki");
        return;
      }
    }
    setAuto({ orgId: cfg.orgId, orgName: cfg.orgName, project, path: cwd, auto: true });
    console.log(`Auto sync ON for this repo on org ${cfg.orgName ?? cfg.orgId}. Docs stay fresh on every commit (consumes LLM tokens). Turn off with: hivemind docs auto off`);
    return;
  }
  if (sub === "pull") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const force = args.includes("--force");
    const scope = flagValue(args, "--scope") ?? "main";
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;
    try {
      const report = await pullDocs({ query, tableName, repoRoot: cwd, project, scope, force });
      if (report.written.length === 0 && report.removed.length === 0) {
        console.log(`Docs up to date (${report.unchanged} unchanged).`);
      } else {
        console.log(`Pulled ${report.written.length} doc(s), removed ${report.removed.length} (${report.unchanged} unchanged).`);
        for (const p of report.written)
          console.log(`  wrote ${p}`);
        for (const p of report.removed)
          console.log(`  removed ${p}`);
      }
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
      console.log("(no docs table yet \u2014 nothing to pull)");
    }
    return;
  }
  if (sub === "wiki") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    const include = flagValues(args, "--include");
    const exclude = flagValues(args, "--exclude");
    const limit = parseOptionalLimit(args);
    const concurrency = Number(flagValue(args, "--concurrency") ?? "2");
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;
    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    let existingDocs = [];
    try {
      existingDocs = await listDocs(query, tableName, { status: "all", projectOrLegacy: project, limit: 1e6 });
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    const existing = new Set(existingDocs.filter((d) => d.doc_id.startsWith(WIKI_DOC_PREFIX)).map((d) => d.doc_id));
    if (dryRun) {
      const groups = selectWikiGroups(snap, { include, exclude });
      const todo = force ? groups : groups.filter((g) => !existing.has(wikiDocId(g.key)));
      const effective = limit !== void 0 ? todo.slice(0, limit) : todo;
      console.log(`${effective.length} wiki page(s) would be generated (${groups.length - effective.length} already exist or skipped).`);
      for (const g of effective.slice(0, 60)) {
        console.log(`  wiki/${g.key}  (${g.files.length} files)`);
      }
      return;
    }
    await api.ensureDocsTable(tableName);
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS)
      process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    const report = await generateWikiPages({
      query,
      tableName,
      snap,
      repoRoot: cwd,
      project,
      // Branch identity for the written rows: `main` on the trunk, `b:<branch>`
      // on a feature branch (a branch-scoped overlay, invisible on main).
      scope: currentScope(defaultGit(cwd)),
      include,
      exclude,
      existing,
      force,
      limit,
      concurrency,
      run: makeHostRunPrompt(),
      runPage: makeHostPageRunPrompt(),
      embed: makeDocEmbedder(),
      agent: cfg.userName,
      pluginVersion
    });
    console.log(`Wiki: created ${report.created}, skipped ${report.skipped}, failed ${report.failed} (of ${report.groups} groups).`);
    for (const o of report.outcomes) {
      if (o.status === "created")
        console.log(`  created ${o.doc_id} (${o.files} files, ${o.chunks} chunk${o.chunks === 1 ? "" : "s"})`);
      else
        console.log(`  ${o.status} ${o.doc_id}: ${o.reason ?? ""}`);
    }
    await offerAutoRefresh(cfg, project, cwd, "this wiki");
    return;
  }
  if (sub === "reindex") {
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS)
      process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    try {
      await api.ensureDocsTable(tableName);
      const report = await backfillDocEmbeddings(query, tableName, makeDocEmbedder());
      console.log(`Reindexed: ${report.embedded} embedded (of ${report.scanned} active docs; ${report.skipped} already had a vector or skipped).`);
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
      console.log("(no docs table yet \u2014 nothing to reindex)");
    }
    return;
  }
  if (sub === "generate") {
    const cwd = flagValue(args, "--cwd") ?? process.cwd();
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    const scopeRaw = flagValue(args, "--scope") ?? "file";
    if (scopeRaw !== "file" && scopeRaw !== "symbol") {
      console.error("Invalid --scope. Allowed: file | symbol.");
      process.exit(1);
      throw new Error("unreachable");
    }
    const scope = scopeRaw;
    const include = flagValues(args, "--include");
    const exclude = flagValues(args, "--exclude");
    const limit = parseOptionalLimit(args);
    const concurrency = Number(flagValue(args, "--concurrency") ?? "4");
    const project = flagValue(args, "--project") ?? deriveProjectKey(cwd).key;
    const snap = loadCurrentSnapshot(cwd);
    if (!snap) {
      console.error("No local graph for this directory. Run `hivemind graph build` first.");
      process.exit(1);
      throw new Error("unreachable");
    }
    let existingDocs = [];
    try {
      existingDocs = await listDocs(query, tableName, { status: "all", projectOrLegacy: project, limit: 1e6 });
    } catch (err) {
      if (!isMissingTableError(err.message))
        throw err;
    }
    const existing = new Set(existingDocs.map((d) => d.doc_id));
    const allTargets = selectTargets(snap, { scope, include, exclude });
    const todo = force ? allTargets : allTargets.filter((t) => !existing.has(t.doc_id));
    if (dryRun) {
      const effective = limit !== void 0 ? todo.slice(0, limit) : todo;
      console.log(`${effective.length} target(s) would be documented (scope=${scope}); ${allTargets.length - effective.length} already documented or skipped.`);
      for (const t of effective.slice(0, 60)) {
        console.log(`  ${t.doc_id}  (${t.symbols.length} symbols)`);
      }
      return;
    }
    await api.ensureDocsTable(tableName);
    if (!process.env.HIVEMIND_QUERY_TIMEOUT_MS)
      process.env.HIVEMIND_QUERY_TIMEOUT_MS = "30000";
    const batchSize = scope === "symbol" ? 1 : Number(flagValue(args, "--batch") ?? "5");
    const report = await generateDocs({
      query,
      tableName,
      snap,
      repoRoot: cwd,
      project,
      scope,
      include,
      exclude,
      existing,
      force,
      limit,
      concurrency,
      generate: makeHostGenerateDoc(),
      batchSize,
      batchGenerate: batchSize > 1 ? makeHostBatchGenerateDoc() : void 0,
      embed: makeDocEmbedder(),
      agent: cfg.userName,
      pluginVersion
    });
    console.log(`Generated ${report.created}, skipped ${report.skipped}, failed ${report.failed} (of ${report.targets} targets).`);
    for (const o of report.outcomes) {
      if (o.status !== "created")
        console.log(`  ${o.status} ${o.doc_id}: ${o.reason ?? ""}`);
    }
    await offerAutoRefresh(cfg, project, cwd, "these docs");
    return;
  }
  console.error(`Unknown subcommand: ${sub}`);
  console.error(USAGE);
  process.exit(1);
}

export {
  socketPathFor,
  pidPathFor,
  EmbedClient,
  embeddingsDisabled,
  wikiFreshnessHint,
  runDocsCommand
};
