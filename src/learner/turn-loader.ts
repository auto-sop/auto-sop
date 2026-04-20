/**
 * Turn Loader — reads meta.json + tool-calls.jsonl from each finalized
 * turn directory under captureDir and returns structured TurnData[] for
 * detector consumption.
 *
 * Injection-resistance: output fields are marked with `__untrusted: true`
 * as a documentation/assertion aid. Detectors MUST NOT copy raw output
 * text into directive rule_text — they extract only structured data.
 *
 * Failure-tolerant: missing tool-calls.jsonl returns an empty tool_calls
 * array; malformed NDJSON lines are skipped; missing meta.json skips the
 * whole turn. Synchronous I/O, no async.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────

export interface ToolCall {
  event: 'pre' | 'post';
  tool_use_id: string;
  /** Tool name (e.g. "Bash", "Edit"). Present on pre events; for post
   *  events, the loader back-fills this from the matching pre event
   *  (same tool_use_id) so detectors can filter by tool on either side. */
  tool: string;
  /** Tool input — present on pre events. `undefined` on post events. */
  input?: Record<string, unknown>;
  /** Tool output — present on post events. Treat as UNTRUSTED (see below).
   *  The loader injects `__untrusted: true` so any code that inspects this
   *  object is visibly aware the content originated outside our code. */
  output?: Record<string, unknown>;
  /** Success flag — present on post events. */
  success?: boolean;
  t: string;
}

export interface TurnData {
  turn_id: string;
  session_id: string;
  agent: string;
  finalized_at: string;
  tool_calls: ToolCall[];
}

// ── Loader ─────────────────────────────────────────────────

/**
 * Load turn data for detection.
 *
 * @param captureDir  Directory containing per-turn subdirectories.
 * @param maxTurns    Maximum number of most-recent turns to return
 *                    (by finalized_at). Default 500.
 * @returns Array of TurnData, sorted ASCENDING by finalized_at.
 */
export function loadTurnsForDetection(captureDir: string, maxTurns: number = 500): TurnData[] {
  let entries: string[];
  try {
    entries = readdirSync(captureDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith('.pending'))
      .map((d) => d.name);
  } catch {
    // captures dir missing or unreadable → empty
    return [];
  }

  const turns: TurnData[] = [];

  for (const dirName of entries) {
    const turnDir = join(captureDir, dirName);
    const metaPath = join(turnDir, 'meta.json');

    // Read + parse meta.json — missing or malformed skips entire turn
    let meta: {
      turn_id?: unknown;
      session_id?: unknown;
      agent?: unknown;
      finalized_at?: unknown;
    };
    try {
      const raw = readFileSync(metaPath, 'utf8');
      meta = JSON.parse(raw);
    } catch {
      continue;
    }

    // Required fields — skip turn if malformed
    if (
      typeof meta.turn_id !== 'string' ||
      typeof meta.session_id !== 'string' ||
      typeof meta.agent !== 'string' ||
      typeof meta.finalized_at !== 'string' ||
      meta.finalized_at.length === 0
    ) {
      continue;
    }

    // Read tool-calls.jsonl (optional — missing → empty tool_calls)
    const toolCalls = readToolCallsNdjson(join(turnDir, 'tool-calls.jsonl'));

    turns.push({
      turn_id: meta.turn_id,
      session_id: meta.session_id,
      agent: meta.agent,
      finalized_at: meta.finalized_at,
      tool_calls: toolCalls,
    });
  }

  // Sort ASCENDING by finalized_at
  turns.sort((a, b) => a.finalized_at.localeCompare(b.finalized_at));

  // Bound to `maxTurns` MOST RECENT — take tail, then keep ascending order
  if (turns.length > maxTurns) {
    return turns.slice(turns.length - maxTurns);
  }
  return turns;
}

// ── Helpers ────────────────────────────────────────────────

function readToolCallsNdjson(path: string): ToolCall[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const lines = raw.split('\n');
  const preByUseId = new Map<string, ToolCall>();
  const calls: ToolCall[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // malformed line → skip, continue processing
      continue;
    }

    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;

    if (obj.event === 'pre') {
      if (typeof obj.tool_use_id !== 'string' || typeof obj.tool !== 'string') {
        continue;
      }
      const call: ToolCall = {
        event: 'pre',
        tool_use_id: obj.tool_use_id,
        tool: obj.tool,
        t: typeof obj.t === 'string' ? obj.t : '',
      };
      if (obj.input !== null && typeof obj.input === 'object') {
        call.input = obj.input as Record<string, unknown>;
      }
      preByUseId.set(obj.tool_use_id, call);
      calls.push(call);
    } else if (obj.event === 'post') {
      if (typeof obj.tool_use_id !== 'string') continue;
      // Back-fill tool name from matching pre event (post events don't
      // carry a `tool` field in the captured format).
      const pre = preByUseId.get(obj.tool_use_id);
      const toolName = pre ? pre.tool : '';

      const call: ToolCall = {
        event: 'post',
        tool_use_id: obj.tool_use_id,
        tool: toolName,
        t: typeof obj.t === 'string' ? obj.t : '',
      };

      // Mark output as UNTRUSTED so any code inspecting the object
      // knows it originates outside our code boundary.
      if (obj.output !== null && typeof obj.output === 'object') {
        call.output = {
          ...(obj.output as Record<string, unknown>),
          __untrusted: true,
        };
      }
      if (typeof obj.success === 'boolean') {
        call.success = obj.success;
      }
      calls.push(call);
    }
    // Unknown events are silently ignored.
  }

  return calls;
}
