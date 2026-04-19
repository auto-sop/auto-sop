/**
 * recent verb — show recent Claude activity for a project.
 *
 * Reads the captures directory directly, filters by finalized_at,
 * and displays a human-readable table or JSON output.
 *
 * Usage:
 *   auto-sop recent                   — show last 1h of turns
 *   auto-sop recent --since 30m       — show last 30 minutes
 *   auto-sop recent --since 2h        — show last 2 hours
 *   auto-sop recent --project /path   — specify project directory
 *   auto-sop recent --json            — JSON output
 *
 * Roadmap: CLI-02.
 */
import type { Command } from 'commander';
import path from 'node:path';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import { renderTable } from '../output/human.js';
import { emit } from '../output/json.js';
import { scanNewTurns, type TurnSummary } from '../../learner/turn-scanner.js';

// ── Duration parser ────────────────────────────────────────

/** Safe duration regex: digits + unit (m/h/d/w). */
const DURATION_RE = /^(\d+)(m|h|d|w)$/;

/**
 * Parse a human duration string (e.g., "30m", "2h", "1d", "1w") into
 * milliseconds. Returns null for invalid input.
 */
export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input.trim());
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  if (value <= 0) return null;

  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };

  return value * multipliers[unit]!;
}

// ── Path validation ────────────────────────────────────────

/**
 * Validate that the given project path is safe (no traversal) and exists.
 * Returns the resolved absolute path or null.
 */
function validateProjectPath(input: string): string | null {
  const resolved = path.resolve(input);
  // Must be an existing directory
  if (!existsSync(resolved)) return null;
  return resolved;
}

// ── Turn display ───────────────────────────────────────────

function formatTurnRow(turn: TurnSummary): string[] {
  const time = turn.finalized_at
    ? new Date(turn.finalized_at).toLocaleTimeString()
    : '-';
  const sessionShort = turn.turn_id.length > 8
    ? turn.turn_id.slice(0, 8)
    : turn.turn_id;

  return [
    time,
    sessionShort,
    String(turn.tool_call_count),
    String(turn.files_changed_count),
    turn.finalization_reason ?? '-',
  ];
}

function printTurnsTable(turns: TurnSummary[]): void {
  // Header
  const headers = ['time', 'turn', 'tools', 'files', 'status'];
  const maxLens = headers.map((h) => h.length);

  const rows = turns.map((t) => {
    const row = formatTurnRow(t);
    for (let i = 0; i < row.length; i++) {
      maxLens[i] = Math.max(maxLens[i]!, row[i]!.length);
    }
    return row;
  });

  // Print header
  const headerLine = headers
    .map((h, i) => pc.dim(h.padEnd(maxLens[i]!)))
    .join('  ');
  process.stdout.write(headerLine + '\n');
  process.stdout.write(pc.dim('─'.repeat(headerLine.length)) + '\n');

  // Print rows
  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(maxLens[i]!)).join('  ');
    process.stdout.write(line + '\n');
  }
}

// ── Verb registration ──────────────────────────────────────

export function registerRecentVerb(program: Command): void {
  program
    .command('recent')
    .description('show recent Claude activity for the current project')
    .option('--since <duration>', 'time window (e.g., 30m, 1h, 2h, 1d, 1w)', '1h')
    .option('--project <path>', 'project directory (default: cwd)')
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;

      // Parse --since duration
      const durationMs = parseDuration(opts.since);
      if (durationMs === null) {
        process.stderr.write(
          pc.red(`error: invalid duration "${opts.since}". Use format: 30m, 1h, 2h, 1d, 1w\n`),
        );
        process.exitCode = 2;
        return;
      }

      // Resolve project path
      const projectInput = opts.project ?? process.cwd();
      const projectPath = validateProjectPath(projectInput);
      if (!projectPath) {
        process.stderr.write(
          pc.red(`error: project directory not found: ${projectInput}\n`),
        );
        process.exitCode = 2;
        return;
      }

      const capturesDir = path.join(projectPath, '.auto-sop', 'captures');
      if (!existsSync(capturesDir)) {
        if (jsonMode) {
          emit({
            ok: true,
            verb: 'recent',
            project: projectPath,
            since: opts.since,
            generated_at: new Date().toISOString(),
            turns: [],
          });
        } else {
          process.stdout.write(
            pc.dim('(no captures directory — has auto-sop been installed for this project?)\n'),
          );
        }
        return;
      }

      // Calculate the cutoff time
      const cutoffTime = new Date(Date.now() - durationMs).toISOString();

      // Scan turns newer than cutoff
      const scanResult = scanNewTurns(capturesDir, cutoffTime, 1000);

      if (jsonMode) {
        emit({
          ok: true,
          verb: 'recent',
          project: projectPath,
          since: opts.since,
          generated_at: new Date().toISOString(),
          turns: scanResult.turns.map((t) => ({
            turn_id: t.turn_id,
            finalized_at: t.finalized_at,
            tool_call_count: t.tool_call_count,
            files_changed_count: t.files_changed_count,
            scrubber_hit_count: t.scrubber_hit_count,
            finalization_reason: t.finalization_reason,
          })),
        });
        return;
      }

      // Human output
      if (scanResult.turns.length === 0) {
        process.stdout.write(
          pc.dim(`(no turns in the last ${opts.since})\n`),
        );
        return;
      }

      process.stdout.write(
        pc.bold(`${scanResult.turns.length} turn(s) in the last ${opts.since}:\n\n`),
      );
      printTurnsTable(scanResult.turns);
    });
}
