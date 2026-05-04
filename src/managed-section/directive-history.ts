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
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getPlatform } from '../platform/index.js';
import { isSemanticallyDuplicate } from '../learner/pattern-store.js';
import { fsyncFile } from '../atomic/safe-fsync.js';

// ─── Constants ───────────────────────────────────────────

/** Default time-to-live for directives, in days (potential tier). */
export const DEFAULT_TTL_DAYS = 30;

/** Default maximum number of active directives (potential tier cap). */
export const DEFAULT_MAX_DIRECTIVES = 25;

// ─── V71: Two-tier constants ────────────────────────────

/** Minimum confirmed fire count to graduate to proven tier. */
export const PROVEN_FIRE_THRESHOLD = 1;

/** TTL for proven-tier directives (days since last fire). */
export const PROVEN_TTL_DAYS = 90;

/** Safety cap for proven tier — prevents unbounded growth. */
export const PROVEN_HARD_CAP = 50;

/** Grace period: new potential directives are protected from cap eviction for this many days. */
export const POTENTIAL_GRACE_DAYS = 7;

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
  /** V71: ISO timestamp of the most recent confirmed fire. Used by the
   *  proven-tier TTL check. Absent when no fires have been recorded. */
  last_fire_at?: string;
  /** V31: command fingerprint for error-prevention tracking. Optional — only set
   *  for bash-failure directives. */
  source_fingerprint?: string;
  /** V31: session IDs from the original evidence that created this directive.
   *  Used by error-prevention tracker to exclude false positives from the
   *  original failure sessions. */
  evidence_sessions?: string[];
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
  evidence: {
    first_seen?: string;
    source_fingerprint?: string | undefined;
    session_ids?: string[];
  };
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
  // V71: load last_fire_at from persisted history
  if (typeof rec.last_fire_at === 'string' && rec.last_fire_at.length > 0) {
    entry.last_fire_at = rec.last_fire_at;
  }
  // V31: load source_fingerprint from persisted history
  if (typeof rec.source_fingerprint === 'string' && rec.source_fingerprint.length > 0) {
    entry.source_fingerprint = rec.source_fingerprint;
  }
  // V31: load evidence_sessions from persisted history
  if (Array.isArray(rec.evidence_sessions)) {
    const filtered = (rec.evidence_sessions as unknown[]).filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    if (filtered.length > 0) {
      entry.evidence_sessions = filtered;
    }
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
    fsyncFile(tmp);
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
      // V31: union evidence_sessions on reinforcement
      if (Array.isArray(p.evidence.session_ids) && p.evidence.session_ids.length > 0) {
        const sessionSet = new Set(existing.evidence_sessions ?? []);
        for (const sid of p.evidence.session_ids) sessionSet.add(sid);
        next.evidence_sessions = [...sessionSet];
      }
      entries[p.id] = next;
    } else {
      const newEntry: DirectiveHistoryEntry = {
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
      // V31: propagate source_fingerprint on first insert (bash-failure directives)
      if (
        typeof p.evidence.source_fingerprint === 'string' &&
        p.evidence.source_fingerprint.length > 0
      ) {
        newEntry.source_fingerprint = p.evidence.source_fingerprint;
      }
      // V31: store evidence_sessions on first insert for error-prevention tracking
      if (Array.isArray(p.evidence.session_ids) && p.evidence.session_ids.length > 0) {
        newEntry.evidence_sessions = [...p.evidence.session_ids];
      }
      entries[p.id] = newEntry;
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
 * Compute the active set given a point in time, TTL, and cap.
 *
 * V71 two-tier system:
 *   - **Proven tier** (≥1 confirmed fire): no cap, 90-day TTL since last fire.
 *     Safety valve: PROVEN_HARD_CAP (50). If exceeded, lowest fire_count pruned.
 *   - **Potential tier** (0 fires or fireCounts undefined): cap at maxDirectives
 *     (default 25), 30-day TTL since last reinforced. 7-day grace: new entries
 *     younger than POTENTIAL_GRACE_DAYS are protected from cap eviction.
 *
 * When fireCounts is undefined, ALL entries go to potential tier (backward compat).
 *
 * Any entries that aged out or overflowed their tier's cap are marked `pruned`
 * in the returned history; active entries retain `pruned: false`.
 *
 * @param fireCounts     Optional map of directive_id → confirmed fire count.
 * @param lastFireDates  Optional map of directive_id → ISO date of most recent fire.
 */
export function applyTTLAndCap(
  history: DirectiveHistory,
  now: Date,
  ttlDays: number,
  maxDirectives: number,
  fireCounts?: Record<string, number>,
  lastFireDates?: Record<string, string>,
): ApplyTTLAndCapResult {
  const nowMs = now.getTime();
  const potentialTtlMs = ttlDays * MS_PER_DAY;
  const provenTtlMs = PROVEN_TTL_DAYS * MS_PER_DAY;
  const graceMs = POTENTIAL_GRACE_DAYS * MS_PER_DAY;
  const nowIso = now.toISOString();

  // Work on a copy so we never mutate input.
  // SEC-L02: Object.create(null) avoids prototype-pollution; skip reserved keys.
  const nextEntries = Object.create(null) as Record<string, DirectiveHistoryEntry>;
  for (const [k, v] of Object.entries(history.entries)) {
    if (RESERVED_KEYS.has(k)) continue;
    nextEntries[k] = { ...v };
  }

  // Enrich entries with last_fire_at from lastFireDates if provided.
  if (lastFireDates !== undefined) {
    for (const [k, entry] of Object.entries(nextEntries)) {
      const lastFire = lastFireDates[k];
      if (typeof lastFire === 'string' && lastFire.length > 0) {
        entry.last_fire_at = lastFire;
      }
    }
  }

  // SEC-002: evict entries whose `pruned_at` is older than 2×TTL so
  // the history file cannot grow without bound over time. Use potential
  // TTL for backward compat (same eviction window as pre-v71).
  const maxPrunedAgeMs = 2 * potentialTtlMs;
  for (const [k, entry] of Object.entries(nextEntries)) {
    if (entry.pruned && typeof entry.pruned_at === 'string') {
      const prunedMs = Date.parse(entry.pruned_at);
      if (Number.isFinite(prunedMs) && nowMs - prunedMs > maxPrunedAgeMs) {
        delete nextEntries[k];
      }
    }
  }

  // Helper: get the fire count for a directive.
  const getFireCount = (id: string): number => {
    if (fireCounts === undefined) return 0;
    return fireCounts[id] ?? 0;
  };

  // Helper: determine if a directive is proven (has fires and fireCounts is provided).
  const isProven = (entry: DirectiveHistoryEntry): boolean => {
    if (fireCounts === undefined) return false; // backward compat: all potential
    return getFireCount(entry.id) >= PROVEN_FIRE_THRESHOLD;
  };

  // 1. TTL pass — tier-aware. Proven uses last_fire_at (or last_reinforced fallback)
  //    with PROVEN_TTL_DAYS. Potential uses last_reinforced with ttlDays.
  const proven: DirectiveHistoryEntry[] = [];
  const potential: DirectiveHistoryEntry[] = [];

  for (const entry of Object.values(nextEntries)) {
    if (isProven(entry)) {
      // Proven tier: TTL based on last_fire_at (fallback to last_reinforced).
      const lastFireStr = entry.last_fire_at ?? entry.last_reinforced;
      const lastMs = Date.parse(lastFireStr);
      const isStale = !Number.isFinite(lastMs) || nowMs - lastMs > provenTtlMs;
      if (isStale) {
        if (!entry.pruned) {
          entry.pruned = true;
          entry.pruned_at = nowIso;
        }
        continue;
      }
      if (entry.pruned) {
        entry.pruned = false;
        delete (entry as { pruned_at?: string }).pruned_at;
      }
      proven.push(entry);
    } else {
      // Potential tier: TTL based on last_reinforced with potentialTtlMs.
      const last = Date.parse(entry.last_reinforced);
      const isStale = !Number.isFinite(last) || nowMs - last > potentialTtlMs;
      if (isStale) {
        if (!entry.pruned) {
          entry.pruned = true;
          entry.pruned_at = nowIso;
        }
        continue;
      }
      if (entry.pruned) {
        entry.pruned = false;
        delete (entry as { pruned_at?: string }).pruned_at;
      }
      potential.push(entry);
    }
  }

  // 2a. Proven cap pass — safety valve at PROVEN_HARD_CAP.
  //     If exceeded, drop entries with lowest fire count.
  let provenKeep: DirectiveHistoryEntry[];
  if (proven.length > PROVEN_HARD_CAP) {
    const sorted = [...proven].sort((a, b) => {
      // Sort ascending by fire count — lowest first for dropping.
      const fa = getFireCount(a.id);
      const fb = getFireCount(b.id);
      if (fa !== fb) return fa - fb;
      // Tie-break: older last_reinforced first.
      const aMs = Date.parse(a.last_reinforced);
      const bMs = Date.parse(b.last_reinforced);
      if (aMs !== bMs) return aMs - bMs;
      return a.id.localeCompare(b.id);
    });
    const overflow = sorted.length - PROVEN_HARD_CAP;
    const toDrop = sorted.slice(0, overflow);
    provenKeep = sorted.slice(overflow);
    for (const entry of toDrop) {
      if (!entry.pruned) {
        entry.pruned = true;
        entry.pruned_at = nowIso;
      }
    }
  } else {
    provenKeep = proven;
  }

  // 2b. Potential cap pass — cap at maxDirectives.
  //     Grace: entries < POTENTIAL_GRACE_DAYS old are protected from eviction.
  let potentialKeep: DirectiveHistoryEntry[];
  if (potential.length > maxDirectives) {
    // Partition into grace-protected and evictable.
    const graceProtected: DirectiveHistoryEntry[] = [];
    const evictable: DirectiveHistoryEntry[] = [];
    for (const entry of potential) {
      const firstSeenMs = Date.parse(entry.first_seen);
      const inGrace = Number.isFinite(firstSeenMs) && nowMs - firstSeenMs < graceMs;
      if (inGrace) {
        graceProtected.push(entry);
      } else {
        evictable.push(entry);
      }
    }

    // Sort evictable by keep priority: lowest severity + oldest first (drop from front).
    evictable.sort((a, b) => {
      const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDiff !== 0) return sevDiff;
      const aMs = Date.parse(a.last_reinforced);
      const bMs = Date.parse(b.last_reinforced);
      const tsDiff = aMs - bMs;
      if (tsDiff !== 0) return tsDiff;
      return a.id.localeCompare(b.id);
    });

    // How many evictable entries we need to drop.
    const slotsForEvictable = Math.max(0, maxDirectives - graceProtected.length);
    let keptEvictable: DirectiveHistoryEntry[];
    if (evictable.length > slotsForEvictable) {
      const overflow = evictable.length - slotsForEvictable;
      const toDrop = evictable.slice(0, overflow);
      keptEvictable = evictable.slice(overflow);
      for (const entry of toDrop) {
        if (!entry.pruned) {
          entry.pruned = true;
          entry.pruned_at = nowIso;
        }
      }
    } else {
      keptEvictable = evictable;
    }

    potentialKeep = [...graceProtected, ...keptEvictable];
  } else {
    potentialKeep = potential;
  }

  // 3. Merge and final sort: severity DESC, last_reinforced DESC, id ASC.
  const allKeep = [...provenKeep, ...potentialKeep];
  const active = allKeep.sort((a, b) => {
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
    /** V71: directive_id → confirmed fire count. Undefined = backward compat (all potential). */
    fireCounts?: Record<string, number> | undefined;
    /** V71: directive_id → ISO date of most recent fire. */
    lastFireDates?: Record<string, string> | undefined;
  },
): ApplyTTLAndCapResult {
  const now = options?.now ?? new Date();
  const config = options?.config ?? getDirectiveConfig();

  const history = loadHistory(projectRoot);

  // BUG-D1: Filter semantically duplicate proposals against existing active directives.
  // If a new proposal is semantically similar to an existing active entry, skip it
  // (keep the existing one to prevent near-duplicate directives).
  // Known limitation: same-batch proposals are not deduped against each other,
  // only against existing history entries. Two near-duplicate proposals arriving
  // in the same tick will both pass this filter. In practice this is rare because
  // the LLM prompt discourages duplicates, and the cap/TTL system limits growth.
  const activeEntries = Object.values(history.entries).filter((e) => !e.pruned);
  const dedupedProposals = proposals.filter((p) => {
    // If this proposal already exists by ID in history, always let it through
    // (it's a reinforcement, not a new directive)
    if (history.entries[p.id] !== undefined) return true;

    // Check against existing active directives
    for (const entry of activeEntries) {
      if (isSemanticallyDuplicate(p.rule_text, entry.rule_text)) {
        return false; // Skip — keep existing directive
      }
    }
    return true;
  });

  const afterUpdate = updateFromProposals(history, dedupedProposals, now.toISOString());
  const result = applyTTLAndCap(
    afterUpdate,
    now,
    config.ttlDays,
    config.maxDirectives,
    options?.fireCounts,
    options?.lastFireDates,
  );
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
