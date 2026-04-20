/**
 * show verb — display full turn or session details.
 *
 * Usage:
 *   auto-sop show <turn-id>           — full turn content
 *   auto-sop show <session-id>        — all turns in session (compact)
 *   auto-sop show <turn-id> --raw     — no formatting, raw file dump
 *   auto-sop show <turn-id> --files   — just list files changed
 *   auto-sop show <turn-id> --tools   — just tool-calls summary
 *   auto-sop show <turn-id> --json    — machine-readable
 *   auto-sop show <id> --project /p   — specify project directory
 *
 * Auto-detection:
 *   turn_id:    nanoid-like, /^[A-Za-z0-9_-]{1,128}$/
 *   session_id: UUID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
 *
 * Roadmap: CLI-03.
 */
import type { Command } from 'commander';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import pc from 'picocolors';
import { renderTable, error as cliError } from '../output/human.js';
import { emit } from '../output/json.js';
import type {
  TurnMeta,
  ToolCallLine,
  ToolCallLinePre,
  ToolCallLinePost,
} from '../../capture/types.js';

// ── Input validation ──────────────────────────────────────

/** Safe turn_id: nanoid-like, 1–128 chars of [A-Za-z0-9_-]. */
const TURN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** UUID v4 format for session_id. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Characters that must never appear in user input (path traversal). */
const UNSAFE_CHARS_RE = /[.\\/\0]/;

export type IdKind = 'turn' | 'session';

/**
 * Classify the input as turn_id, session_id, or invalid.
 * Rejects inputs containing `..`, `/`, `\`, null bytes.
 */
export function classifyId(input: string): IdKind | null {
  // Reject unsafe chars first (covers .., /, \, null)
  if (UNSAFE_CHARS_RE.test(input)) return null;
  if (SESSION_ID_RE.test(input)) return 'session';
  if (TURN_ID_RE.test(input)) return 'turn';
  return null;
}

// ── Turn directory resolution ─────────────────────────────

/**
 * Find the turn directory matching a turn_id within capturesDir.
 * Turn directories are named `{TIMESTAMP}-{AGENT}-{HASH}-{TURN_ID}`.
 * We match the suffix after the last `-` segment(s).
 */
function findTurnDir(capturesDir: string, turnId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(capturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith('.pending'))
      .map((d) => d.name);
  } catch {
    return null;
  }

  for (const dirName of entries) {
    const turnDir = path.join(capturesDir, dirName);
    const metaPath = path.join(turnDir, 'meta.json');
    try {
      const raw = readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw) as TurnMeta;
      if (meta.turn_id === turnId) return turnDir;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Find ALL turn directories matching a session_id.
 * Returns sorted ascending by finalized_at.
 */
function findSessionTurnDirs(
  capturesDir: string,
  sessionId: string,
): Array<{ turnDir: string; meta: TurnMeta }> {
  let entries: string[];
  try {
    entries = readdirSync(capturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith('.pending'))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const results: Array<{ turnDir: string; meta: TurnMeta }> = [];

  for (const dirName of entries) {
    const turnDir = path.join(capturesDir, dirName);
    const metaPath = path.join(turnDir, 'meta.json');
    try {
      const raw = readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw) as TurnMeta;
      if (meta.session_id === sessionId && meta.finalized_at) {
        results.push({ turnDir, meta });
      }
    } catch {
      continue;
    }
  }

  results.sort((a, b) => (a.meta.finalized_at ?? '').localeCompare(b.meta.finalized_at ?? ''));
  return results;
}

// ── File readers ──────────────────────────────────────────

function readFileOpt(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

interface PairedToolCall {
  name: string;
  durationMs: number | null;
  success: boolean | null;
  inputSnippet: string | null;
  outputSnippet: string | null;
}

function readToolCalls(turnDir: string): PairedToolCall[] {
  const raw = readFileOpt(path.join(turnDir, 'tool-calls.jsonl'));
  if (!raw) return [];

  const preMap = new Map<string, ToolCallLinePre>();
  const pairs: PairedToolCall[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: ToolCallLine;
    try {
      parsed = JSON.parse(line) as ToolCallLine;
    } catch {
      continue;
    }

    if (parsed.event === 'pre') {
      preMap.set(parsed.tool_use_id, parsed as ToolCallLinePre);
    } else if (parsed.event === 'post') {
      const post = parsed as ToolCallLinePost;
      const pre = preMap.get(post.tool_use_id);
      pairs.push({
        name: pre?.tool ?? 'unknown',
        durationMs: post.duration_ms ?? null,
        success: post.success ?? null,
        inputSnippet: pre?.input ? truncate(JSON.stringify(pre.input), 120) : null,
        outputSnippet: post.output ? truncate(JSON.stringify(post.output), 120) : null,
      });
    }
  }

  return pairs;
}

function readFilesChanged(turnDir: string): string[] {
  const raw = readFileOpt(path.join(turnDir, 'files-changed.txt'));
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ── Path safety ───────────────────────────────────────────

function assertWithinDir(base: string, candidate: string): void {
  const resolved = path.resolve(candidate);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error(`path traversal rejected: ${candidate}`);
  }
}

// ── Display helpers ───────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function printTurnFull(
  meta: TurnMeta,
  turnDir: string,
  opts: { raw: boolean; files: boolean; tools: boolean },
): void {
  const prompt = readFileOpt(path.join(turnDir, 'prompt.md'));
  const response = readFileOpt(path.join(turnDir, 'response.md'));
  const toolCalls = readToolCalls(turnDir);
  const filesChanged = readFilesChanged(turnDir);

  // Duration
  const durationMs =
    meta.started_at && meta.finalized_at
      ? new Date(meta.finalized_at).getTime() - new Date(meta.started_at).getTime()
      : null;

  if (opts.raw) {
    // Raw mode: dump each file with a filename header
    for (const [label, content] of [
      ['meta.json', JSON.stringify(meta, null, 2)],
      ['prompt.md', prompt],
      ['response.md', response],
      ['tool-calls.jsonl', readFileOpt(path.join(turnDir, 'tool-calls.jsonl'))],
      ['files-changed.txt', readFileOpt(path.join(turnDir, 'files-changed.txt'))],
    ] as Array<[string, string | null]>) {
      if (content) {
        process.stdout.write(`=== ${label} ===\n`);
        process.stdout.write(content);
        if (!content.endsWith('\n')) process.stdout.write('\n');
      }
    }
    return;
  }

  if (opts.files) {
    // Files-only mode
    if (filesChanged.length === 0) {
      process.stdout.write(pc.dim('(no files changed)\n'));
    } else {
      process.stdout.write('Files changed:\n');
      for (const f of filesChanged) {
        process.stdout.write(`  ${f}\n`);
      }
    }
    return;
  }

  if (opts.tools) {
    // Tools-only mode
    if (toolCalls.length === 0) {
      process.stdout.write(pc.dim('(no tool calls)\n'));
      return;
    }

    // Count by tool name
    const counts = new Map<string, { count: number; totalMs: number; successes: number }>();
    for (const tc of toolCalls) {
      const entry = counts.get(tc.name) ?? { count: 0, totalMs: 0, successes: 0 };
      entry.count++;
      if (tc.durationMs !== null) entry.totalMs += tc.durationMs;
      if (tc.success === true) entry.successes++;
      counts.set(tc.name, entry);
    }

    process.stdout.write(`Tool calls: ${toolCalls.length}\n\n`);
    const rows: Array<[string, string]> = [];
    for (const [name, info] of [...counts.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const avgMs = info.count > 0 ? Math.round(info.totalMs / info.count) : 0;
      rows.push([
        name,
        `${info.count}x, avg ${formatDuration(avgMs)}, ${info.successes}/${info.count} ok`,
      ]);
    }
    process.stdout.write(renderTable(rows) + '\n');
    return;
  }

  // Full mode: header + prompt + response + tool calls
  const headerRows: Array<[string, string]> = [
    ['Turn:', meta.turn_id],
    ['Session:', meta.session_id],
    ['Agent:', meta.agent + (meta.subagent_type ? ` (${meta.subagent_type})` : '')],
    ['Started:', meta.started_at],
    [
      'Finalized:',
      meta.finalized_at
        ? `${meta.finalized_at}${durationMs !== null ? ` (${formatDuration(durationMs)})` : ''}`
        : '(pending)',
    ],
    ['Files changed:', String(filesChanged.length)],
    ['Tool calls:', String(toolCalls.length)],
  ];

  process.stdout.write(renderTable(headerRows) + '\n');

  if (prompt) {
    process.stdout.write(`\n${pc.bold(pc.dim('━━━ PROMPT ━━━'))}\n`);
    process.stdout.write(prompt);
    if (!prompt.endsWith('\n')) process.stdout.write('\n');
  }

  if (response) {
    process.stdout.write(`\n${pc.bold(pc.dim('━━━ RESPONSE ━━━'))}\n`);
    process.stdout.write(response);
    if (!response.endsWith('\n')) process.stdout.write('\n');
  }

  if (toolCalls.length > 0) {
    process.stdout.write(`\n${pc.bold(pc.dim('━━━ TOOL CALLS ━━━'))}\n`);
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const dur = tc.durationMs !== null ? formatDuration(tc.durationMs) : '?';
      const status = tc.success === true ? 'success' : tc.success === false ? 'failed' : '?';
      process.stdout.write(`${i + 1}. ${pc.bold(tc.name)} (${dur}, ${status})\n`);
      if (tc.inputSnippet) {
        process.stdout.write(`   ${pc.dim(tc.inputSnippet)}\n`);
      }
      if (tc.outputSnippet) {
        process.stdout.write(`   ${pc.dim('-> ' + tc.outputSnippet)}\n`);
      }
    }
  }
}

function printSessionCompact(
  sessionId: string,
  turns: Array<{ turnDir: string; meta: TurnMeta }>,
): void {
  process.stdout.write(pc.bold(`Session: ${sessionId}\n`) + pc.dim(`${turns.length} turn(s)\n\n`));

  // Table header
  const headers = ['turn_id', 'agent', 'finalized_at', 'tools', 'files'];
  const rows = turns.map(({ meta }) => [
    meta.turn_id,
    meta.agent + (meta.subagent_type ? `(${meta.subagent_type})` : ''),
    meta.finalized_at ? new Date(meta.finalized_at).toLocaleTimeString() : '-',
    String(meta.tool_call_count),
    String(meta.files_changed_count),
  ]);

  const maxLens = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      maxLens[i] = Math.max(maxLens[i]!, row[i]!.length);
    }
  }

  const headerLine = headers.map((h, i) => pc.dim(h.padEnd(maxLens[i]!))).join('  ');
  process.stdout.write(headerLine + '\n');
  process.stdout.write(pc.dim('─'.repeat(headerLine.length)) + '\n');

  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(maxLens[i]!)).join('  ');
    process.stdout.write(line + '\n');
  }
}

// ── JSON builders ─────────────────────────────────────────

function buildTurnJson(meta: TurnMeta, turnDir: string): Record<string, unknown> {
  const prompt = readFileOpt(path.join(turnDir, 'prompt.md'));
  const response = readFileOpt(path.join(turnDir, 'response.md'));
  const toolCalls = readToolCalls(turnDir);
  const filesChanged = readFilesChanged(turnDir);

  const durationMs =
    meta.started_at && meta.finalized_at
      ? new Date(meta.finalized_at).getTime() - new Date(meta.started_at).getTime()
      : null;

  return {
    turn_id: meta.turn_id,
    session_id: meta.session_id,
    agent: meta.agent,
    subagent_type: meta.subagent_type,
    started_at: meta.started_at,
    finalized_at: meta.finalized_at,
    duration_ms: durationMs,
    prompt: prompt ?? null,
    response: response ?? null,
    tool_calls: toolCalls.map((tc) => ({
      name: tc.name,
      duration_ms: tc.durationMs,
      status: tc.success === true ? 'success' : tc.success === false ? 'failed' : 'unknown',
      input_snippet: tc.inputSnippet,
      output_snippet: tc.outputSnippet,
    })),
    files: filesChanged.map((f) => ({
      path: f,
      // We don't reliably know A/M/D from files-changed.txt alone
      action: 'M',
    })),
  };
}

// ── Verb registration ─────────────────────────────────────

export function registerShowVerb(program: Command): void {
  program
    .command('show <id>')
    .description('show full turn or session details')
    .option('--raw', 'no formatting, raw file dump')
    .option('--files', 'just list files changed')
    .option('--tools', 'just tool-calls summary')
    .option('--project <path>', 'project directory (default: cwd)')
    .action(async (id: string, opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;

      // Defense-in-depth: early bail-out for obviously unsafe characters.
      // classifyId() below also rejects these via regex, but this check
      // gives a cleaner "unsafe characters" error before regex testing.
      if (id.includes('\0') || id.includes('..') || id.includes('/') || id.includes('\\')) {
        if (jsonMode) {
          emit({ ok: false, code: 2, message: 'invalid id: contains unsafe characters' });
        } else {
          cliError('invalid id: contains unsafe characters');
        }
        process.exitCode = 2;
        return;
      }

      // Classify input
      const kind = classifyId(id);
      if (!kind) {
        if (jsonMode) {
          emit({
            ok: false,
            code: 2,
            message: `invalid id format: "${id}". Expected turn_id (alphanumeric, 1-128 chars) or session_id (UUID).`,
          });
        } else {
          cliError(
            `invalid id format: "${id}"\n` +
              '  turn_id:    alphanumeric + _ and -, 1-128 chars\n' +
              '  session_id: UUID (e.g. a7914106-8d5d-4a95-bfcb-6dc9f3d83821)',
          );
        }
        process.exitCode = 2;
        return;
      }

      // Resolve project path
      const projectInput = opts.project ?? process.cwd();
      const projectPath = path.resolve(projectInput);
      if (!existsSync(projectPath)) {
        if (jsonMode) {
          emit({ ok: false, code: 2, message: `project directory not found: ${projectInput}` });
        } else {
          cliError(`project directory not found: ${projectInput}`);
        }
        process.exitCode = 2;
        return;
      }

      const capturesDir = path.join(projectPath, '.auto-sop', 'captures');
      if (!existsSync(capturesDir)) {
        if (jsonMode) {
          emit({
            ok: false,
            code: 1,
            message: 'no captures directory — has auto-sop been installed for this project?',
          });
        } else {
          process.stdout.write(
            pc.dim('(no captures directory — has auto-sop been installed for this project?)\n'),
          );
        }
        return;
      }

      if (kind === 'session') {
        // Session mode: list all turns in this session
        const turns = findSessionTurnDirs(capturesDir, id);

        // Defense-in-depth: validate each turn dir is within capturesDir,
        // even though findSessionTurnDirs only returns direct children from readdirSync.
        for (const { turnDir } of turns) {
          assertWithinDir(capturesDir, turnDir);
        }

        if (turns.length === 0) {
          if (jsonMode) {
            emit({ ok: false, code: 1, message: `no turns found for session: ${id}` });
          } else {
            cliError(`no turns found for session: ${id}`);
          }
          process.exitCode = 1;
          return;
        }

        if (jsonMode) {
          emit({
            ok: true,
            verb: 'show',
            mode: 'session',
            session_id: id,
            turns: turns.map(({ meta, turnDir }) => buildTurnJson(meta, turnDir)),
          });
        } else {
          printSessionCompact(id, turns);
        }
        return;
      }

      // Turn mode: find the specific turn
      const turnDir = findTurnDir(capturesDir, id);
      if (!turnDir) {
        if (jsonMode) {
          emit({ ok: false, code: 1, message: `turn not found: ${id}` });
        } else {
          cliError(`turn not found: ${id}`);
        }
        process.exitCode = 1;
        return;
      }

      // Safety: ensure turnDir is within capturesDir
      assertWithinDir(capturesDir, turnDir);

      // Read meta
      let meta: TurnMeta;
      try {
        const raw = readFileSync(path.join(turnDir, 'meta.json'), 'utf8');
        meta = JSON.parse(raw) as TurnMeta;
      } catch {
        if (jsonMode) {
          emit({ ok: false, code: 1, message: `failed to read meta.json for turn: ${id}` });
        } else {
          cliError(`failed to read meta.json for turn: ${id}`);
        }
        process.exitCode = 1;
        return;
      }

      if (jsonMode) {
        emit({
          ok: true,
          verb: 'show',
          mode: 'turn',
          ...buildTurnJson(meta, turnDir),
        });
      } else {
        printTurnFull(meta, turnDir, {
          raw: opts.raw ?? false,
          files: opts.files ?? false,
          tools: opts.tools ?? false,
        });
      }
    });
}
