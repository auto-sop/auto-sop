/**
 * Directive Builder — produces a hardcoded sample directive block for
 * the ManagedSectionEditor. No pattern detection, no LLM calls.
 *
 * The body is deterministic given the same inputs:
 * - Timestamp is rounded to the nearest MINUTE for idempotency
 *   (two ticks within the same minute produce identical body).
 * - Turn count comes from turns_total_seen.
 * - Agent roster is deduplicated from captures meta.json files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedSectionContent } from '../managed-section/editor.js';
import type { ProjectRegistryEntry } from './project-registry.js';
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
  const ms = date.getUTCMilliseconds();

  // Round: if seconds >= 30, round up, else round down
  if (seconds >= 30) {
    date.setUTCMinutes(date.getUTCMinutes() + 1);
  }
  date.setUTCSeconds(0, 0);

  return date.toISOString().replace('.000Z', 'Z');
}

// ── Build directive ─────────────────────────────────────────

export interface DirectiveInput {
  turnsTotalSeen: number;
  agentRoster: string[];
  nowIso: string;
}

/**
 * Build the sample directive content for the ManagedSectionEditor.
 *
 * Uses the project registry entry + scan result to collect:
 * - turns_total_seen from the caller (already computed in the tick loop)
 * - agent roster from captures meta.json
 * - timestamp rounded to nearest minute
 *
 * The body is byte-identical for the same inputs, enabling
 * the editor's 'unchanged' verdict on repeat ticks.
 */
export function buildSampleDirective(
  project: ProjectRegistryEntry,
  nowIso: string,
  turnsTotalSeen: number,
): ManagedSectionContent {
  const capturesDir = join(project.project_root, '.claude-sop', 'captures');
  const agentRoster = collectAgentRoster(capturesDir);

  return buildSampleDirectiveFromInput({
    turnsTotalSeen,
    agentRoster,
    nowIso,
  });
}

/**
 * Pure function: build directive body from pre-collected inputs.
 * Useful for unit testing without filesystem dependencies.
 */
export function buildSampleDirectiveFromInput(
  input: DirectiveInput,
): ManagedSectionContent {
  const { turnsTotalSeen, agentRoster, nowIso } = input;

  const roundedTs = roundToMinute(nowIso);
  const agentList =
    agentRoster.length > 0
      ? agentRoster.join(', ')
      : 'none detected';

  const turnsLabel = turnsTotalSeen === 1 ? 'turn' : 'turns';
  const agentCountLabel = agentRoster.length === 1 ? 'agent' : 'agents';

  const body = [
    `_Last updated: ${roundedTs} \u00b7 ${turnsTotalSeen} ${turnsLabel} analyzed \u00b7 ${agentRoster.length} ${agentCountLabel}: ${agentList}_`,
    '',
    '**Learnings**',
    '',
    '_No directives generated yet \u2014 pattern detection ships in the next version._',
  ].join('\n');

  return { body };
}
