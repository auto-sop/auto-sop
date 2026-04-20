/**
 * Directive history store — tracks every directive the learner has ever
 * proposed for a project, independent of whether it currently appears in
 * CLAUDE.md.
 *
 * Problem this solves:
 *   Without history the managed section would grow unboundedly as the
 *   learner keeps rediscovering patterns. Users also want "old" directives
 *   to age out so CLAUDE.md stays focused on current behaviour.
 *
 * Policy:
 *   - TTL: a directive expires if not reinforced within N days (default 30).
 *   - Cap: at most M directives active at once (default 25); overflow is
 *     dropped lowest-severity first and preserved in history as `pruned`.
 *   - Reinforcement: each time a directive is re-proposed by the learner,
 *     `last_reinforced` and `occurrence_count` advance; if it was pruned,
 *     the pruned flag is cleared so it can return to the active set.
 *
 * Storage:
 *   <projectRoot>/.auto-sop/state/directive-history.json
 *   File mode 0600 — never world-readable.
 *   Atomic rename on write (tmp → fsync → rename) so a crash mid-write
 *   leaves either the previous state or nothing — never a torn file.
 *
 * Determinism:
 *   applyTTLAndCap uses only its inputs — no wall-clock, no randomness —
 *   so a caller that pins `now` gets byte-reproducible output.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getPlatform } from '../platform/index.js';

// ─── Constants ───────────────────────────────────────────

/** Default time-to-live for directives, in days. */
export const DEFAULT_TTL_DAYS = 30;

/** Default maximum number of active directives. */
export const DEFAULT_MAX_DIRECTIVES = 25;

/** Env var name overriding the TTL (new name; legacy CLAUDE_SOP_* also supported). */
export const ENV_TTL_DAYS = 'AUTO_SOP_DIRECTIVE_TTL_DAYS';
export const LEGACY_ENV_TTL_DAYS = 'CLAUDE_SOP_DIRECTIVE_TTL_DAYS';

/** Env var name overriding the max count (new name; legacy CLAUDE_SOP_* also supported). */
export const ENV_MAX_DIRECTIVES = 'AUTO_SOP_DIRECTIVE_MAX';
export const LEGACY_ENV_MAX_DIRECTIVES = 'CLAUDE_SOP_DIRECTIVE_MAX';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * SEC-005: hard upper bounds on env-var overrides. A misconfigured
 * CLAUDE_SOP_DIRECTIVE_TTL_DAYS=9999999 or CLAUDE_SOP_DIRECTIVE_MAX=1e9
 * would never meaningfully age out entries or keep the active set
 * bounded — defending against both hostile env and innocent typos.
 */
const MAX_TTL_DAYS = 3650; // ~10 years
const MAX_DIRECTIVES_CAP = 1000;

/** SEC-L01: cap string lengths when reading untrusted JSON. */
const MAX_ID_LENGTH = 256;
const MAX_RULE_TEXT_LENGTH = 2048;

/** SEC-L02: prototype-pollution-safe key set. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ─── Types ───────────────────────────────────────────────

export type DirectiveSeverity = 'error' | 'warning' | 'info';

export interface DirectiveHistoryEntry {
  id: string;
  rule_text: string;
  severity: DirectiveSeverity;
  /** ISO — first time we ever saw this directive. */
  first_seen: string;
  /** ISO — most recent tick in which the learner re-proposed it. */
  last_reinforced: string;
  /** How many ticks have proposed this directive, ever. */
  occurrence_count: number;
  /** True when pruned from the active set; still retained in history. */
  pruned: boolean;
  /** ISO — when the entry was last pruned. Absent if never pruned. */
  pruned_at?: string;
}

export interface DirectiveHistory {
  entries: Record<string, DirectiveHistoryEntry>;
  updated_at: string;
}

/**
 * Minimal subset of a directive proposal needed to update history. Works
 * with the full {@link DirectiveProposalType} thanks to structural typing.
 */
export interface DirectiveProposalLike {
  id: string;
  rule_text: string;
  severity: DirectiveSeverity;
  evidence: { first_seen?: string };
  created_at?: string;
}

export interface ApplyTTLAndCapResult {
  /**
   * Directives that should be rendered into CLAUDE.md, sorted by
   * (severity DESC, last_reinforced DESC, id ASC). Length ≤ maxDirectives.
   */
  active: DirectiveHistoryEntry[];
  /**
   * Updated history — mutated entries (pruned flags, occurrence counts) are
   * written back. Callers should persist this via {@link saveHistory}.
   */
  history: DirectiveHistory;
}

export interface DirectiveConfig {
  ttlDays: number;
  maxDirectives: number;
}

// ─── Path guard ──────────────────────────────────────────

function assertNoTraversal(projectRoot: string): void {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute, got: ${projectRoot}`);
  }
  if (projectRoot.includes('..')) {
    throw new Error(`projectRoot must not contain '..': ${projectRoot}`);
  }
}

function historyPath(projectRoot: string): string {
  return join(projectRoot, '.auto-sop', 'state', 'directive-history.json');
}

// ─── Config ──────────────────────────────────────────────

/**
 * Read TTL + max-cap from env (with sensible defaults). Non-integer or
 * non-positive overrides are ignored — we never let a misconfigured env
 * var break the learner.
 */
export function getDirectiveConfig(env: NodeJS.ProcessEnv = process.env): DirectiveConfig {
  const ttlDays = parsePositiveInt(
    env[ENV_TTL_DAYS] ?? env[LEGACY_ENV_TTL_DAYS],
    DEFAULT_TTL_DAYS,
    MAX_TTL_DAYS,
  );
  const maxDirectives = parsePositiveInt(
    env[ENV_MAX_DIRECTIVES] ?? env[LEGACY_ENV_MAX_DIRECTIVES],
    DEFAULT_MAX_DIRECTIVES,
    MAX_DIRECTIVES_CAP,
  );
  return { ttlDays, maxDirectives };
}

/**
 * Parse an env-sourced positive integer. Values that are missing,
 * non-integer, non-positive, or above `cap` fall back to the default —
 * a runaway override must never disable the bounded-growth guarantees
 * of TTL + cap.
 */
function parsePositiveInt(raw: unknown, fallback: number, cap: number): number {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  if (n > cap) return fallback;
  return n;
}

// ─── Empty / default ─────────────────────────────────────

export function emptyHistory(now: string = new Date().toISOString()): DirectiveHistory {
  return { entries: {}, updated_at: now };
}

// ─── Load ────────────────────────────────────────────────

/**
 * Read the directive history for a project. Returns an empty history when
 * the file does not exist or is corrupt — drift / persistence bugs must
 * never wedge the learner, so we fail open and let a fresh file overwrite
 * the bad one on the next save.
 */
export function loadHistory(projectRoot: string): DirectiveHistory {
  assertNoTraversal(projectRoot);
  const path = historyPath(projectRoot);
  if (!existsSync(path)) return emptyHistory();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return emptyHistory();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyHistory();
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !isRecord((parsed as { entries?: unknown }).entries)
  ) {
    return emptyHistory();
  }

  const entriesIn = (parsed as { entries: Record<string, unknown> }).entries;
  // SEC-003: null-prototype map so a malicious key like "__proto__" or
  // "constructor" in the on-disk history file cannot pollute
  // Object.prototype via later `entriesOut[key] = …` writes. Any
  // downstream consumer that iterates via `Object.entries`/
  // `Object.keys` still behaves identically.
  const entriesOut = Object.create(null) as Record<string, DirectiveHistoryEntry>;
  for (const [k, v] of Object.entries(entriesIn)) {
    const entry = coerceEntry(k, v);
    if (entry !== null) entriesOut[k] = entry;
  }
  const updated = (parsed as { updated_at?: unknown }).updated_at;
  const updated_at =
    typeof updated === 'string' && updated.length > 0 ? updated : new Date().toISOString();
  return { entries: entriesOut, updated_at };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceEntry(idKey: string, v: unknown): DirectiveHistoryEntry | null {
  if (!isRecord(v)) return null;
  const rec = v as Record<string, unknown>;
  const id =
    typeof rec.id === 'string' ? rec.id.slice(0, MAX_ID_LENGTH) : idKey.slice(0, MAX_ID_LENGTH);
  if (id.length === 0) return null;
  const rule_text =
    typeof rec.rule_text === 'string' ? rec.rule_text.slice(0, MAX_RULE_TEXT_LENGTH) : '';
  if (rule_text.length === 0) return null;
  const sev = rec.severity;
  if (sev !== 'error' && sev !== 'warning' && sev !== 'info') return null;
  const first_seen = typeof rec.first_seen === 'string' ? rec.first_seen : '';
  const last_reinforced =
    typeof rec.last_reinforced === 'string' ? rec.last_reinforced : first_seen;
  if (first_seen.length === 0 || last_reinforced.length === 0) return null;
  const occurrence_count =
    typeof rec.occurrence_count === 'number' &&
    Number.isFinite(rec.occurrence_count) &&
    rec.occurrence_count >= 1
      ? Math.floor(rec.occurrence_count)
      : 1;
  const pruned = rec.pruned === true;
  const entry: DirectiveHistoryEntry = {
    id,
    rule_text,
    severity: sev,
    first_seen,
    last_reinforced,
    occurrence_count,
    pruned,
  };
  if (typeof rec.pruned_at === 'string' && rec.pruned_at.length > 0) {
    entry.pruned_at = rec.pruned_at;
  }
  return entry;
}

// ─── Save ────────────────────────────────────────────────

/**
 * Atomically persist the history. Writes tmp → fsync → rename so a crash
 * mid-write leaves the prior (or empty) file intact. File mode is 0600.
 */
export function saveHistory(projectRoot: string, history: DirectiveHistory): void {
  assertNoTraversal(projectRoot);
  const path = historyPath(projectRoot);
  const dir = join(projectRoot, '.auto-sop', 'state');
  // SEC-006: create the state directory user-only (0o700) so neither
  // the history file nor its siblings (hash store, managed-history
  // backups) are ever world-readable, even if umask is permissive.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const payload = JSON.stringify(history);
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  try {
    getPlatform().chmodSync(path, 0o600);
  } catch {
    // best-effort; umask may soften it on some filesystems
  }
}

// ─── Update from proposals ───────────────────────────────

/**
 * Apply a tick's proposals to the history. For each proposal:
 *   - If the id is already tracked: bump `last_reinforced` to now, increment
 *     `occurrence_count`, clear `pruned` (if set), and refresh
 *     `rule_text` / `severity` to the newest values.
 *   - If the id is new: create a fresh entry.
 *
 * Returns a NEW DirectiveHistory object (the input is not mutated), so
 * callers can diff state across ticks if they want to.
 */
export function updateFromProposals(
  history: DirectiveHistory,
  proposals: DirectiveProposalLike[],
  now: string = new Date().toISOString(),
): DirectiveHistory {
  const entries: Record<string, DirectiveHistoryEntry> = { ...history.entries };
  for (const p of proposals) {
    const existing = entries[p.id];
    if (existing !== undefined) {
      const next: DirectiveHistoryEntry = {
        ...existing,
        // Refresh content in case the learner produced a richer rule_text.
        rule_text: p.rule_text,
        severity: p.severity,
        last_reinforced: now,
        occurrence_count: existing.occurrence_count + 1,
        pruned: false,
      };
      // pruned_at is meaningful only while pruned; clear on reactivation.
      delete (next as { pruned_at?: string }).pruned_at;
      entries[p.id] = next;
    } else {
      entries[p.id] = {
        id: p.id,
        rule_text: p.rule_text,
        severity: p.severity,
        first_seen:
          typeof p.evidence.first_seen === 'string' && p.evidence.first_seen.length > 0
            ? p.evidence.first_seen
            : now,
        last_reinforced: now,
        occurrence_count: 1,
        pruned: false,
      };
    }
  }
  return { entries, updated_at: now };
}

// ─── Apply TTL & cap ─────────────────────────────────────

const SEVERITY_RANK: Record<DirectiveSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Compute the active set given a point in time, TTL, and cap. Any entries
 * that aged out or overflowed the cap are marked `pruned` in the returned
 * history (so the caller can persist them); active entries retain
 * `pruned: false`.
 *
 * Active selection:
 *   1. Filter entries where `now - last_reinforced <= ttlDays`. Entries
 *      already flagged `pruned` pass too when they've been refreshed — see
 *      the semantics in {@link updateFromProposals}.
 *   2. If more than `maxDirectives` entries remain, keep the ones with
 *      highest severity first, then most-recent reinforcement (i.e. drop
 *      oldest-low-severity first).
 *   3. Sort the final active set by (severity DESC, last_reinforced DESC,
 *      id ASC) for deterministic rendering.
 */
export function applyTTLAndCap(
  history: DirectiveHistory,
  now: Date,
  ttlDays: number,
  maxDirectives: number,
): ApplyTTLAndCapResult {
  const nowMs = now.getTime();
  const ttlMs = ttlDays * MS_PER_DAY;
  const nowIso = now.toISOString();

  // Work on a copy so we never mutate input.
  // SEC-L02: Object.create(null) avoids prototype-pollution; skip reserved keys.
  const nextEntries = Object.create(null) as Record<string, DirectiveHistoryEntry>;
  for (const [k, v] of Object.entries(history.entries)) {
    if (RESERVED_KEYS.has(k)) continue;
    nextEntries[k] = { ...v };
  }

  // SEC-002: evict entries whose `pruned_at` is older than 2×TTL so
  // the history file cannot grow without bound over time. Pruned
  // entries still reachable within 2×TTL window are preserved for
  // audit + re-activation when the learner re-proposes them.
  const maxPrunedAgeMs = 2 * ttlMs;
  for (const [k, entry] of Object.entries(nextEntries)) {
    if (entry.pruned && typeof entry.pruned_at === 'string') {
      const prunedMs = Date.parse(entry.pruned_at);
      if (Number.isFinite(prunedMs) && nowMs - prunedMs > maxPrunedAgeMs) {
        delete nextEntries[k];
      }
    }
  }

  // 1. TTL pass.
  const stillFresh: DirectiveHistoryEntry[] = [];
  for (const entry of Object.values(nextEntries)) {
    const last = Date.parse(entry.last_reinforced);
    const isStale = !Number.isFinite(last) || nowMs - last > ttlMs;
    if (isStale) {
      if (!entry.pruned) {
        entry.pruned = true;
        entry.pruned_at = nowIso;
      }
      continue;
    }
    if (entry.pruned) {
      // Still within TTL but carries a stale pruned flag — e.g. a previous
      // cap pass marked it. Let the cap pass below decide whether it
      // re-enters the active set.
      entry.pruned = false;
      delete (entry as { pruned_at?: string }).pruned_at;
    }
    stillFresh.push(entry);
  }

  // 2. Cap pass. Sort by (severity ASC, last_reinforced ASC) ascending so
  //    we can drop from the FRONT (lowest severity, oldest reinforcement).
  //    Then the remainder is reversed for rendering order.
  const byKeepPriority = [...stillFresh].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff; // higher severity sorts LATER (stays)
    const aMs = Date.parse(a.last_reinforced);
    const bMs = Date.parse(b.last_reinforced);
    const tsDiff = aMs - bMs; // older first
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });

  let keep: DirectiveHistoryEntry[];
  if (byKeepPriority.length > maxDirectives) {
    const overflow = byKeepPriority.length - maxDirectives;
    const toDrop = byKeepPriority.slice(0, overflow);
    keep = byKeepPriority.slice(overflow);
    for (const entry of toDrop) {
      if (!entry.pruned) {
        entry.pruned = true;
        entry.pruned_at = nowIso;
      }
    }
  } else {
    keep = byKeepPriority;
  }

  // 3. Final sort: severity DESC, then last_reinforced DESC, then id ASC.
  const active = [...keep].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const aMs = Date.parse(a.last_reinforced);
    const bMs = Date.parse(b.last_reinforced);
    const tsDiff = bMs - aMs; // newer first
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });

  return {
    active,
    history: { entries: nextEntries, updated_at: nowIso },
  };
}

// ─── High-level helper ──────────────────────────────────

/**
 * One-shot helper that loads history, applies the tick's proposals, caps
 * to the configured maximum, saves the updated history, and returns the
 * active set ready for rendering.
 *
 * Intended entry point for the learner: keeps the business logic out of
 * main.ts and ensures the load/update/save cycle is atomic from the
 * caller's perspective.
 */
export function applyDirectiveHistory(
  projectRoot: string,
  proposals: DirectiveProposalLike[],
  options?: {
    now?: Date;
    config?: DirectiveConfig;
  },
): ApplyTTLAndCapResult {
  const now = options?.now ?? new Date();
  const config = options?.config ?? getDirectiveConfig();

  const history = loadHistory(projectRoot);
  const afterUpdate = updateFromProposals(history, proposals, now.toISOString());
  const result = applyTTLAndCap(afterUpdate, now, config.ttlDays, config.maxDirectives);
  try {
    saveHistory(projectRoot, result.history);
  } catch {
    // Persistence failure is non-fatal — the active set for THIS tick is
    // still correct, and the next tick will rebuild state from the
    // empty/partial file via loadHistory.
  }
  return result;
}

// ─── I9: Directive preservation helpers ─────────────────

/**
 * Path to the just_restored flag file. When present, the next learner
 * tick skips LLM analysis (directives were restored from history, not
 * re-discovered) and clears the flag so subsequent ticks resume normally.
 */
function justRestoredPath(projectRoot: string): string {
  return join(projectRoot, '.auto-sop', 'state', 'just-restored.flag');
}

/**
 * Set the just_restored flag. Called by the install orchestrator after
 * restoring directives from history.
 */
export function setJustRestored(projectRoot: string): void {
  assertNoTraversal(projectRoot);
  const dir = join(projectRoot, '.auto-sop', 'state');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const flagPath = justRestoredPath(projectRoot);
  writeFileSync(flagPath, new Date().toISOString(), { mode: 0o600 });
}

/**
 * Check whether the just_restored flag is set AND clear it atomically.
 * Returns true exactly once after a restore; subsequent calls return false.
 * Fail-open: any error → false (never wedge the learner).
 */
export function consumeJustRestored(projectRoot: string): boolean {
  assertNoTraversal(projectRoot);
  const flagPath = justRestoredPath(projectRoot);
  if (!existsSync(flagPath)) return false;
  try {
    unlinkSync(flagPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse directive bullets from a managed section body. Used for defensive
 * backup: when CLAUDE.md has directives but directive-history.json is
 * missing, we extract structured entries from the rendered Markdown.
 *
 * Format: `- **[severity]** rule_text`
 *
 * Returns minimal DirectiveHistoryEntry objects with synthetic ids and
 * timestamps. Entries that don't match the expected format are skipped.
 */
export function extractDirectivesFromBody(body: string, now: string): DirectiveHistoryEntry[] {
  const entries: DirectiveHistoryEntry[] = [];
  const lines = body.split('\n');
  for (const line of lines) {
    const match = line.match(/^- \*\*\[(error|warning|info)\]\*\* (.+)$/);
    if (!match) continue;
    const severity = match[1] as DirectiveSeverity;
    const ruleText = match[2]!;
    // Synthetic id from rule text hash (deterministic)
    const id = `restored-${simpleHash(ruleText)}`;
    entries.push({
      id,
      rule_text: ruleText,
      severity,
      first_seen: now,
      last_reinforced: now,
      occurrence_count: 1,
      pruned: false,
    });
  }
  return entries;
}

/**
 * Simple deterministic hash for generating synthetic ids.
 * Not cryptographic — just needs to be stable and collision-resistant
 * enough for ~25 directives.
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * Load only active (non-pruned) directives from history. Used by the
 * install orchestrator to restore directives after reinstall.
 *
 * Returns entries sorted by (severity DESC, last_reinforced DESC, id ASC)
 * for deterministic rendering. Returns an empty array when history is
 * missing, corrupt, or has no active directives.
 */
export function loadActiveDirectives(projectRoot: string): DirectiveHistoryEntry[] {
  assertNoTraversal(projectRoot);
  const history = loadHistory(projectRoot);
  const entries = Object.values(history.entries).filter((e) => !e.pruned);
  if (entries.length === 0) return [];
  // Sort: severity DESC (error=0 < warning=1 < info=2), last_reinforced DESC, id ASC
  entries.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const aMs = Date.parse(a.last_reinforced);
    const bMs = Date.parse(b.last_reinforced);
    const tsDiff = bMs - aMs;
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });
  return entries;
}
