/**
 * Directive Builder — formats validated DirectiveProposals into the
 * markdown body that lives inside the managed section of CLAUDE.md.
 *
 * Determinism invariant:
 *   Given the same (project, scan, proposals, newestTurnFinalizedAt,
 *   candidateCount) inputs, this builder produces BYTE-IDENTICAL
 *   output. This is what lets the ManagedSectionEditor return
 *   verdict='unchanged' on repeat ticks where nothing has really
 *   changed (idempotency).
 *
 *   To ensure that:
 *   - Timestamp source is the newest captured-turn finalized_at
 *     (data-anchored), NOT wall-clock `Date.now()`. Two ticks with no
 *     new turns therefore produce identical bodies — B4 fix.
 *   - Agent roster is sorted.
 *   - Proposals are sorted (severity desc, then created_at asc, then id asc).
 *   - No random / nondeterministic fields leak into the body.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedSectionContent } from '../managed-section/editor.js';
import type { ProjectRegistryEntry } from './project-registry.js';
import type { DirectiveProposalType } from './directive-schema.js';

// ── Agent roster collection ─────────────────────────────────

/**
 * Reads all meta.json files under capturesDir and returns a
 * deduplicated, sorted list of agent names.
 */
export function collectAgentRoster(capturesDir: string): string[] {
  const agents = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(capturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith('.pending'))
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const dirName of entries) {
    const metaPath = join(capturesDir, dirName, 'meta.json');
    try {
      const raw = readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      if (typeof meta.agent === 'string' && meta.agent.length > 0) {
        agents.add(meta.agent);
      }
    } catch {
      // skip poison/unreadable
    }
  }

  return Array.from(agents).sort();
}

// ── Timestamp rounding ──────────────────────────────────────

/**
 * Round an ISO timestamp to the nearest minute.
 * e.g. "2026-04-14T22:23:47.123Z" → "2026-04-14T22:24:00Z"
 */
export function roundToMinute(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const seconds = date.getUTCSeconds();
  if (seconds >= 30) {
    date.setUTCMinutes(date.getUTCMinutes() + 1);
  }
  date.setUTCSeconds(0, 0);
  return date.toISOString().replace('.000Z', 'Z');
}

// ── Types ───────────────────────────────────────────────────

export interface DirectiveInput {
  turnsTotalSeen: number;
  agentRoster: string[];
  /**
   * Wall-clock ISO timestamp — retained for API compatibility with the
   * legacy `buildSampleDirectiveFromInput` entry point but NOT rendered
   * into the body. The displayed timestamp comes from
   * `newestTurnFinalizedAt` so consecutive no-new-data ticks produce
   * byte-identical output (B4 fix).
   */
  nowIso: string;
  /**
   * Max `finalized_at` across captured turns. Rendered as the stats-line
   * "Data as of: …" value. Null when no turns exist (fresh install) —
   * the builder emits a static "no turns yet" placeholder in that case,
   * which is still deterministic.
   */
  newestTurnFinalizedAt?: string | null | undefined;
  /** Validated directive proposals that passed schema. */
  proposals: DirectiveProposalType[];
  /** Number of below-threshold candidate patterns (for "monitoring" text). */
  candidateCount: number;
  /**
   * Optional free-form summary emitted by the LLM analyzer. When present,
   * renders as a single `_AI analysis: …_` line directly below the stats
   * header. Kept optional for backwards compatibility and to allow clean
   * fallback when LLM mode is disabled / errored.
   *
   * The builder deliberately strips any embedded newlines and caps the
   * length so a runaway model cannot bloat the managed section.
   */
  llmSummary?: string | undefined;
}

/** Max characters we will render from an llmSummary. Guards against
 *  accidental prompt-injection / runaway output bloating CLAUDE.md. */
const MAX_LLM_SUMMARY_CHARS = 500;

/**
 * HTML-comment prefixes that would break the managed-section boundary
 * if an attacker-controlled LLM summary smuggled them in. Stripping
 * these substrings defangs the marker without otherwise changing the
 * text — the remaining characters are still rendered so the user can
 * see that an injection attempt was made (minus its payload).
 */
const MARKER_PATTERNS = [
  '<!-- auto-sop:managed-section:begin',
  '<!-- auto-sop:managed-section:end',
  '<!-- GENERATED',
];

/**
 * Normalize an LLM summary for safe inclusion in the managed section.
 * - Collapses whitespace (incl. newlines) to single spaces.
 * - Trims.
 * - Strips any managed-section markers (SEC-001 injection resistance).
 * - Truncates to MAX_LLM_SUMMARY_CHARS (appending an ellipsis) if longer.
 * - Returns `null` when the cleaned string is empty (so callers can skip
 *   emitting the line entirely).
 */
function normalizeLlmSummary(summary: string | undefined): string | null {
  if (typeof summary !== 'string') return null;
  const collapsed = summary.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  // Strip any HTML comment markers to prevent managed-section corruption.
  let sanitized = collapsed;
  for (const pattern of MARKER_PATTERNS) {
    sanitized = sanitized.split(pattern).join('');
  }
  sanitized = sanitized.trim();
  if (sanitized.length === 0) return null;
  if (sanitized.length <= MAX_LLM_SUMMARY_CHARS) return sanitized;
  return sanitized.slice(0, MAX_LLM_SUMMARY_CHARS - 1) + '\u2026';
}

// ── Build managed-section body ──────────────────────────────

const SEVERITY_RANK: Record<DirectiveProposalType['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Stable sort proposals for deterministic output.
 * Order: severity (error > warning > info), then created_at asc,
 * then id asc (tiebreaker).
 */
function sortProposals(proposals: DirectiveProposalType[]): DirectiveProposalType[] {
  return [...proposals].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const tsDiff = a.created_at.localeCompare(b.created_at);
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Build a relative path from the project root to a captured turn
 * directory. `turnId` is the nanoid stored in meta.json's `turn_id`
 * field (see src/capture/writer/turn-dir.ts). The actual on-disk
 * directory name is `<ts>-<agent>-<filehash>-<turnId>`, but we emit
 * the bare turn_id here so the link is deterministic without a
 * filesystem lookup — users can `ls .auto-sop/captures/*<id>*` to
 * find the exact directory. This keeps the builder pure (no I/O) and
 * the rendered body byte-stable under E7 golden-file tests.
 */
function turnPathForLink(turnId: string): string {
  return `.auto-sop/captures/${turnId}`;
}

/**
 * Defense-in-depth (SEC-001): strip any character outside the nanoid
 * alphabet from a turn_id before we render it into a markdown link.
 * The schema (directive-schema.ts) also enforces this, but a detector
 * that bypasses the schema or a future refactor that loosens it must
 * never produce a link target capable of breaking out of the
 * `[label](target)` syntax — hence this final-stage whitelist.
 * Returns an empty string if nothing survives sanitization, signalling
 * the caller to fall back to a linkless evidence line.
 */
function sanitizeTurnId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

/**
 * Format a single proposal as a markdown bullet.
 * - First line: severity tag + rule_text
 * - Second line (indented): evidence summary with `[view turns]` pointer
 *
 * E6 (PLAN-v16 Wave 3): the evidence line includes a markdown link to
 * the first captured turn that triggered the directive, plus `[+K more]`
 * when additional turns were aggregated. When `turn_ids` is missing or
 * empty (defensive — schema requires min(1) but defense-in-depth matters
 * since the managed section is user-facing), we fall back to session
 * count only so a malformed proposal never crashes rendering.
 */
function formatProposalBullet(p: DirectiveProposalType): string {
  const sessionCount = p.evidence.session_ids.length;
  const sessionsLabel = sessionCount === 1 ? 'session' : 'sessions';
  const turnIds = Array.isArray(p.evidence.turn_ids) ? p.evidence.turn_ids : [];

  // SEC-001: sanitize the link target. If the first turn_id contains
  // anything outside the nanoid alphabet, sanitizeTurnId returns a
  // stripped-down version; if nothing survives, we drop the link
  // entirely and render only the session-count summary (same fallback
  // we already use for empty turn_ids).
  const safeFirstTurn = turnIds.length === 0 ? '' : sanitizeTurnId(turnIds[0]!);

  let evidenceLine: string;
  if (safeFirstTurn.length === 0) {
    evidenceLine = `_(evidence: ${sessionCount} ${sessionsLabel})_`;
  } else {
    const firstTurnPath = turnPathForLink(safeFirstTurn);
    const remaining = turnIds.length - 1;
    const moreSuffix = remaining > 0 ? ` [+${remaining} more]` : '';
    evidenceLine =
      `_(evidence: ${sessionCount} ${sessionsLabel} \u00b7 ` +
      `[view turns](${firstTurnPath})${moreSuffix})_`;
  }

  return `- **[${p.severity}]** ${p.rule_text}\n  ${evidenceLine}`;
}

/**
 * Build the directive body from (already-collected) inputs.
 *
 * Pure function — no filesystem. Useful for unit testing and for the
 * main entry point that collects filesystem data once.
 */
export function buildDirectiveBodyFromInput(input: DirectiveInput): ManagedSectionContent {
  const {
    turnsTotalSeen,
    agentRoster,
    newestTurnFinalizedAt,
    proposals,
    candidateCount,
    llmSummary,
  } = input;

  // B4: render a DATA-anchored timestamp instead of wall-clock. When no
  // turns have been captured yet we emit a static placeholder so the
  // body is still deterministic across fresh-install ticks.
  const dataAsOf =
    typeof newestTurnFinalizedAt === 'string' && newestTurnFinalizedAt.length > 0
      ? roundToMinute(newestTurnFinalizedAt)
      : 'no turns yet';
  const agentList = agentRoster.length > 0 ? agentRoster.join(', ') : 'none detected';
  const turnsLabel = turnsTotalSeen === 1 ? 'turn' : 'turns';
  const agentCountLabel = agentRoster.length === 1 ? 'agent' : 'agents';

  const statsLine =
    `_Data as of: ${dataAsOf} \u00b7 ${turnsTotalSeen} ${turnsLabel} analyzed ` +
    `\u00b7 ${agentRoster.length} ${agentCountLabel}: ${agentList}_`;

  const cleanedSummary = normalizeLlmSummary(llmSummary);
  const aiLine = cleanedSummary !== null ? `\n_AI analysis: ${cleanedSummary}_` : '';

  const sorted = sortProposals(proposals);

  let learningsSection: string;
  if (sorted.length > 0) {
    const header =
      '**Learnings** (' +
      sorted.length +
      ' active directive' +
      (sorted.length === 1 ? '' : 's') +
      ')';
    const bullets = sorted.map(formatProposalBullet).join('\n\n');
    learningsSection = header + '\n\n' + bullets;
  } else if (candidateCount > 0) {
    const patternsLabel = candidateCount === 1 ? 'pattern' : 'patterns';
    learningsSection =
      '**Learnings**\n\n' +
      '_Monitoring \u2014 need 3+ sessions with the same pattern to generate a directive. ' +
      'Currently tracking ' +
      candidateCount +
      ' candidate ' +
      patternsLabel +
      '._';
  } else {
    learningsSection = '**Learnings**\n\n' + '_No recurring patterns detected yet._';
  }

  const body = statsLine + aiLine + '\n\n' + learningsSection;
  return { body };
}

/**
 * Convenience wrapper: collect agent roster from filesystem, then
 * delegate to buildDirectiveBodyFromInput.
 *
 * Backwards-compatible replacement for the old `buildSampleDirective`
 * entry point used by main.ts. Now accepts proposals + candidate
 * count so real directives can be rendered.
 */
export function buildDirectiveBody(
  project: ProjectRegistryEntry,
  nowIso: string,
  turnsTotalSeen: number,
  proposals: DirectiveProposalType[],
  candidateCount: number,
  llmSummary?: string,
  newestTurnFinalizedAt?: string | null,
): ManagedSectionContent {
  const capturesDir = join(project.project_root, '.auto-sop', 'captures');
  const agentRoster = collectAgentRoster(capturesDir);
  return buildDirectiveBodyFromInput({
    turnsTotalSeen,
    agentRoster,
    nowIso,
    newestTurnFinalizedAt,
    proposals,
    candidateCount,
    llmSummary,
  });
}

// ── Back-compat shim ────────────────────────────────────────
// Older call sites (and any existing tests) used `buildSampleDirective`
// and `buildSampleDirectiveFromInput`. Keep those names as thin shims
// that call the new builders with empty proposals/candidates so
// nothing breaks while the learner is being rewired.

export function buildSampleDirective(
  project: ProjectRegistryEntry,
  nowIso: string,
  turnsTotalSeen: number,
  newestTurnFinalizedAt?: string | null,
): ManagedSectionContent {
  return buildDirectiveBody(
    project,
    nowIso,
    turnsTotalSeen,
    [],
    0,
    undefined,
    newestTurnFinalizedAt,
  );
}

export interface LegacyDirectiveInput {
  turnsTotalSeen: number;
  agentRoster: string[];
  nowIso: string;
  newestTurnFinalizedAt?: string | null;
}

export function buildSampleDirectiveFromInput(input: LegacyDirectiveInput): ManagedSectionContent {
  return buildDirectiveBodyFromInput({
    ...input,
    proposals: [],
    candidateCount: 0,
  });
}
