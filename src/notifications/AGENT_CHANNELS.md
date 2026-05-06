# Per-agent SessionStart delivery channels

Source of truth for what each per-agent adapter in `src/notifications/delivery/` does (or doesn't) emit. Records the post-deep-read findings from each agent's harness source — config-shape inspection alone was misleading and is no longer trusted.

## TL;DR

| Agent | Multi-hook → distinct context blocks? | Stderr → user? | v1 delivery |
|---|---|---|---|
| **Claude Code** | ✅ YES — additionalContext from each hook is delivered (collected into an array) | ❌ stderr captured but NOT rendered as of CC 2.1.131 — use `systemMessage` instead | **REAL**: dual-channel JSON — top-level `systemMessage` (user-visible: renders as `SessionStart:startup says: <text>`) + nested `hookSpecificOutput.additionalContext` (model-visible). |
| **Codex** | ❌ NO — flattened `Vec<String>`, joined with `\n\n` downstream | ❌ NO — discarded | **STUB**: no-op + TODO (defer inline-append) |
| **Hermes** | ❌ NO — `on_session_start` return value DISCARDED entirely | ❌ NO — captured to `logger.debug` only | **STUB**: no-op + TODO (defer to `pre_llm_call` + dedup) |
| **Cursor** | ⚠️ Unknown (closed-source GUI; docs imply concat) | ⚠️ Unknown | **STUB**: no-op + TODO |

## Findings (source-level)

### Claude Code — verified empirically against 2.1.131 with multi-channel probe

A standalone shell-script probe was wired in as a 2nd SessionStart hook command alongside the existing memory hook. The probe emitted distinct markers via every plausible channel; the user opened a fresh `claude` and reported what surfaced. The session JSONL was inspected to see exactly how the harness recorded each.

Findings:
- ✅ **Top-level `systemMessage` → user-visible verbatim.** Renders in the terminal at session start as `SessionStart:startup says: <text>`. MUST be at the top level of the JSON; nesting it inside `hookSpecificOutput` causes the harness to silently drop it.
- ✅ **Nested `hookSpecificOutput.additionalContext` → model-visible.** Multiple hooks' additionalContext arrive as an array on a single `hook_additional_context` attachment — both the existing memory hook's content AND our notification hook's content are present.
- ❌ **`process.stderr.write` → captured but not rendered.** As of Claude Code 2.1.0 ("ultrathink update"), SessionStart hook stderr is recorded into the session JSONL's `attachment.stderr` field but no longer printed to the user's terminal. Don't rely on it.
- ❌ **Top-level `additionalContext` (not nested) → ignored.** The docs and our test confirm only the nested form is honored.

Empirical evidence preserved in the session JSONL captured by the probe — see also CC docs ([Hooks reference](https://code.claude.com/docs/en/hooks)) and bug reports [#9591](https://github.com/anthropics/claude-code/issues/9591) (post-2.1.0 silenced stderr) and [#15344](https://github.com/anthropics/claude-code/issues/15344) (systemMessage behavior in CLI vs VS Code).

**Channel (v1):** single SessionStart hook command emits one JSON object with `systemMessage` at top level + `hookSpecificOutput.additionalContext` nested. Same text in both. User reads, model reasons.

**Caveat:** the VS Code extension does not render `systemMessage` (issue #15344). Terminal CLI users get the full UX; IDE users get model-only delivery.

### Codex — verified upstream source (`openai/codex@main`)

- `codex-rs/hooks/src/events/session_start.rs` parses each command's stdout (JSON first, plain text fallback into `additional_context`).
- `codex-rs/hooks/src/events/common.rs::flatten_additional_contexts` collects all hooks' contexts as a `Vec<String>` of separate items.
- Downstream those entries are joined with `"\n\n"` for the model — **concatenation, not separate blocks**.
- `parse_completed()` only reads stdout; `result.stderr` field exists but is never inspected — **stderr discarded**.
- **v1 implication:** registering a second hook command does NOT produce a distinct context block — the user's "but not DEEPLAKE MEMORY, HIVEMIND" requirement cannot be honored at the harness level.

### Hermes — verified upstream source (`~/.hermes/hermes-agent/`)

- `run_agent.py:9777-9786`: `_invoke_hook("on_session_start", ...)` is called but its return value is **discarded** — no assignment, no use of the returned `List[Any]`.
- The current shipping `src/hooks/hermes/session-start.ts:109` line `console.log(JSON.stringify({ context: additional }))` is a **latent no-op** — bytes travel through stdin/stdout/parse and get dropped at the caller. Worth filing upstream.
- `agent/shell_hooks.py:391-398` runs hooks with `subprocess.run(..., capture_output=True, ...)`, then `:444-448` routes stderr to `logger.debug(...)` only — stderr is captured and only emitted at DEBUG log level (default INFO/WARNING; user must explicitly opt in via `--dev` or `HERMES_LOG_LEVEL=DEBUG`).
- The actual model-visible context-injection point in Hermes is `pre_llm_call` (`run_agent.py:9890-9897`), where multiple callbacks' `{context: "..."}` returns are joined with `"\n\n"`.
- **v1 implication:** Hermes cannot deliver a notification at session start through the existing `on_session_start` hook channel. Future option: register a `pre_llm_call` hook with framework-side `session_id`-keyed dedup (fire only on first turn of each session). Out of scope for v1.

### Cursor — closed source

- `~/.cursor/hooks.json` accepts an array of commands per `sessionStart` — config shape supports multiple hooks.
- Cursor 1.7+ docs describe `additional_context` as a single string field. Docs are silent on multi-hook merging behavior and stderr handling. No source available to verify.
- **v1 implication:** behavior unknown; ship a stub. Verify via the runnable probe in `probe/probe-cursor.js` when prioritized.

## v1 delivery summary

The only agent that can deliver a notification as a *separate* context block (per the user's "but not DEEPLAKE MEMORY, HIVEMIND" requirement) is **Claude Code**. v1 ships:

- Real Claude Code adapter — second hook command. Dual-channel emit:
  - **stderr** — rendered text printed verbatim (user-visible above the system-reminder, same path as the existing autoupdate banner). Required because notifications are user-facing announcements; the model is not allowed to silently swallow them.
  - **stdout JSON** — same text in `additionalContext`. The model receives it so it can reason on follow-up turns (e.g. "you have a balance reminder, avoid expensive ops?").
- No-op stubs for Codex, Cursor, Hermes — framework is wired, but `emit()` does nothing for those agents. Each stub file documents the constraint that blocks real delivery and the deferred design (inline-append for Codex/Cursor; `pre_llm_call`+dedup for Hermes).

## Probes

`probe/` contains runnable verification scripts for each agent. They no-op unless `HIVEMIND_NOTIFICATION_PROBE=1` is set. See `probe/README.md` for wiring instructions. Phase 0 closed without running them in live Codex/Cursor/Hermes sessions because the source-level read already established that multi-hook block separation is not a viable strategy for those agents.
