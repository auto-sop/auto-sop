/**
 * Directive Builder — formats validated DirectiveProposals into the
 * markdown body that lives inside the managed section of CLAUDE.md.
 *
 * Determinism invariant:
 *   Given the same (project, scan, proposals, nowIso, candidateCount)
 *   inputs, this builder produces BYTE-IDENTICAL output. This is what
 *   lets the ManagedSectionEditor return verdict='unchanged' on
 *   repeat ticks where nothing has really changed (idempotency).
 *
 *   To ensure that:
 *   - Timestamp is rounded to the nearest minute (roundToMinute).
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
  nowIso: string;
  /** Validated directive proposals that passed schema. */
  proposals: DirectiveProposalType[];
  /** Number of below-threshold candidate patterns (for "monitoring" text). */
  candidateCount: number;
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
 * Format a single proposal as a markdown bullet.
 * - First line: severity tag + rule_text
 * - Second line (indented): evidence summary
 */
function formatProposalBullet(p: DirectiveProposalType): string {
  const sessionCount = p.evidence.session_ids.length;
  const firstSeenDate = p.evidence.first_seen.slice(0, 10); // YYYY-MM-DD
  const sessionsLabel = sessionCount === 1 ? 'session' : 'sessions';
  return (
    '- **[' +
    p.severity +
    ']** ' +
    p.rule_text +
    '\n  _(evidence: ' +
    sessionCount +
    ' ' +
    sessionsLabel +
    ', first seen ' +
    firstSeenDate +
    ')_'
  );
}

/**
 * Build the directive body from (already-collected) inputs.
 *
 * Pure function — no filesystem. Useful for unit testing and for the
 * main entry point that collects filesystem data once.
 */
export function buildDirectiveBodyFromInput(
  input: DirectiveInput,
): ManagedSectionContent {
  const { turnsTotalSeen, agentRoster, nowIso, proposals, candidateCount } = input;

  const roundedTs = roundToMinute(nowIso);
  const agentList =
    agentRoster.length > 0 ? agentRoster.join(', ') : 'none detected';
  const turnsLabel = turnsTotalSeen === 1 ? 'turn' : 'turns';
  const agentCountLabel = agentRoster.length === 1 ? 'agent' : 'agents';

  const statsLine =
    `_Last updated: ${roundedTs} \u00b7 ${turnsTotalSeen} ${turnsLabel} analyzed ` +
    `\u00b7 ${agentRoster.length} ${agentCountLabel}: ${agentList}_`;

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
    learningsSection =
      '**Learnings**\n\n' + '_No recurring patterns detected yet._';
  }

  const body = statsLine + '\n\n' + learningsSection;
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
): ManagedSectionContent {
  const capturesDir = join(project.project_root, '.claude-sop', 'captures');
  const agentRoster = collectAgentRoster(capturesDir);
  return buildDirectiveBodyFromInput({
    turnsTotalSeen,
    agentRoster,
    nowIso,
    proposals,
    candidateCount,
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
): ManagedSectionContent {
  return buildDirectiveBody(project, nowIso, turnsTotalSeen, [], 0);
}

export interface LegacyDirectiveInput {
  turnsTotalSeen: number;
  agentRoster: string[];
  nowIso: string;
}

export function buildSampleDirectiveFromInput(
  input: LegacyDirectiveInput,
): ManagedSectionContent {
  return buildDirectiveBodyFromInput({
    ...input,
    proposals: [],
    candidateCount: 0,
  });
}
