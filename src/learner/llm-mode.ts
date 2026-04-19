/**
 * LLM Mode — full pipeline that asks `claude -p` to analyze recent
 * Phase-2 captures and propose CLAUDE.md directives. This module
 * replaces the v9 stub and implements PLAN-v14 Wave 2.
 *
 * Public surface:
 *   - runLlmAnalysis(turns, project, sessionCount, options?)
 *     Builds an injection-resistant prompt, spawns `claude -p`, parses
 *     the two-layer JSON response, and returns an `LlmAnalysisResult`.
 *     The function NEVER throws — every failure path produces a
 *     well-formed result with a stable `error` code so the caller can
 *     fall through to the rule-based detectors without try/catch.
 *
 * Security posture:
 *   - The prompt body wraps every captured tool input/output in
 *     `<capture untrusted="true">…</capture>` (see llm-serializer.ts).
 *   - The Zod schema in directive-schema.ts caps `rule_text` at 500
 *     chars and enforces the `≥3 distinct sessions` rule, so a model
 *     that ignores the prompt's "never copy raw text" instruction
 *     still cannot smuggle large attacker-controlled strings into
 *     CLAUDE.md.
 *   - The spawned `claude -p` child receives `CLAUDE_SOP_CAPTURE_SUPPRESS=1`
 *     in its environment as a recursion guard — the Stop hook checks
 *     this var (plus the legacy `CLAUDE_SOP_LEARNER`) and skips Phase-2
 *     capture inside the learner subprocess so analyses do not feed
 *     back into themselves.
 */
import { spawnSync } from 'node:child_process';
import { execa } from 'execa';
import {
  DirectiveProposal,
  type DirectiveProposalType,
} from './directive-schema.js';
import { serializeTurnsForLlm } from './llm-serializer.js';
import { buildAnalysisPrompt } from './llm-prompt.js';
import type { TurnData } from './turn-loader.js';

// ── Constants ──────────────────────────────────────────────

/** Default hard-stop for the `claude -p` child process. */
const DEFAULT_TIMEOUT_MS = 120_000;

// ── Public types ───────────────────────────────────────────

export interface LlmAnalysisResult {
  /** Schema-validated directive proposals. Empty array on any failure. */
  proposals: DirectiveProposalType[];
  /** Free-form summary string the model returned (may be empty). */
  summary: string;
  /** Number of turns the model claims it analyzed (echo of input count). */
  turnsAnalyzed: number;
  /** Patterns the model saw but dropped because they appeared in <3 sessions. */
  patternsBelowThreshold: number;
  /** Wall-clock time spent in this call. 0 only when `offline:true`. */
  durationMs: number;
  /**
   * `null` on success, otherwise a stable error code:
   *   - `claude_not_found`   — `claude` binary missing on PATH
   *   - `timeout`            — child exceeded the timeout budget
   *   - `claude_exit_<n>`    — child exited with non-zero status `<n>`
   *   - `json_parse_failed`  — wrapper or inner payload was not valid JSON
   *   - `spawn_failed`       — execa itself rejected (rare with reject:false)
   */
  error: string | null;
}

// ── Public entry ───────────────────────────────────────────

/**
 * Run the LLM analysis pipeline for one project / one tick.
 *
 * The function never throws. On any failure the returned
 * `LlmAnalysisResult` has `proposals: []` and a populated `error`
 * field. Callers should treat that as "no LLM proposals this tick"
 * and merge with rule-based detector output.
 */
export async function runLlmAnalysis(
  turns: TurnData[],
  projectName: string,
  sessionCount: number,
  options?: { timeout?: number; offline?: boolean },
): Promise<LlmAnalysisResult> {
  // 1. Offline shortcut — caller explicitly disabled LLM analysis.
  //    No spawn, no PATH check, no elapsed time.
  if (options?.offline === true) {
    return makeEmptyResult(null, 0);
  }

  const start = Date.now();

  // 2. Refuse to spawn if `claude` is not on PATH. A synchronous
  //    `which` lookup keeps us from paying for an execa launch
  //    just to discover the binary is missing.
  if (!isClaudeOnPath()) {
    return makeEmptyResult('claude_not_found', Date.now() - start);
  }

  // 3-4. Build the prompt. Both helpers are pure string functions
  //      when `turn_dir` is not attached to a turn (the in-memory
  //      case for tests); otherwise they read prompt.md / response.md
  //      / files-changed.txt off disk.
  const serialized = serializeTurnsForLlm(turns, projectName);
  const prompt = buildAnalysisPrompt(
    serialized,
    projectName,
    sessionCount,
    turns.length,
  );

  // 5. Spawn `claude -p`. `reject: false` suppresses execa's own throw —
  //    we always inspect the result object directly instead. The variable
  //    type is left inferred so TS picks the call-site-narrowed Result.
  let result;
  try {
    result = await execa(
      'claude',
      ['-p', '--output-format', 'json', '--max-turns', '1'],
      {
        input: prompt,
        timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
        env: {
          ...process.env,
          // Recursion guard: tells our own Phase-2 capture (if it
          // somehow runs inside this child) that the parent is the
          // learner and to skip recording its own turns.
          AUTO_SOP_CAPTURE_SUPPRESS: '1',
          CLAUDE_SOP_CAPTURE_SUPPRESS: '1',
        },
        reject: false,
      },
    );
  } catch {
    return makeEmptyResult('spawn_failed', Date.now() - start);
  }

  const durationMs = Date.now() - start;

  // 6a. Timeout — execa killed the child before it could finish.
  if (result.timedOut === true) {
    return makeEmptyResult('timeout', durationMs);
  }

  // 6b. Non-zero exit (also catches signal kills, where exitCode is
  //     undefined and `failed` is true).
  if (result.failed === true || (result.exitCode ?? 0) !== 0) {
    const code = result.exitCode ?? -1;
    return makeEmptyResult(`claude_exit_${code}`, durationMs);
  }

  // 6c-7. Parse the two-layer JSON response. Outer = the claude CLI
  //       wrapper (`{"result": "...", "model": "...", ...}`); inner =
  //       the LLM's directive payload (the assistant's reply text).
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const innerText = extractInnerText(stdout);
  if (innerText === null) {
    return makeEmptyResult('json_parse_failed', durationMs);
  }

  let inner: unknown;
  try {
    inner = JSON.parse(stripMarkdownFences(innerText.trim()));
  } catch {
    return makeEmptyResult('json_parse_failed', durationMs);
  }

  if (inner === null || typeof inner !== 'object') {
    return makeEmptyResult('json_parse_failed', durationMs);
  }

  // 8. Validate every candidate directive. Schema rejections are
  //    silently dropped — the caller still receives a valid result
  //    containing only the proposals that survived the schema gate.
  //
  //    Before validation, inject default values for `detector` and
  //    `created_at` when the LLM omits them. The schema requires both
  //    fields, but many real `claude -p` responses (and smaller models)
  //    do not include them — without defaults, every LLM proposal would
  //    silently fail safeParse() and the feature would be non-functional
  //    in production. Candidate values take precedence over defaults.
  const innerObj = inner as Record<string, unknown>;
  const candidates: unknown[] = Array.isArray(innerObj.directives)
    ? innerObj.directives
    : [];
  const nowIso = new Date().toISOString();
  const proposals: DirectiveProposalType[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    const withDefaults = {
      ...raw,
      detector: raw.detector ?? 'llm',
      created_at: raw.created_at ?? nowIso,
    };
    const parsed = DirectiveProposal.safeParse(withDefaults);
    if (parsed.success) proposals.push(parsed.data);
  }

  return {
    proposals,
    summary:
      typeof innerObj.summary === 'string' ? innerObj.summary : '',
    turnsAnalyzed:
      typeof innerObj.turns_analyzed === 'number'
        ? innerObj.turns_analyzed
        : turns.length,
    patternsBelowThreshold:
      typeof innerObj.patterns_below_threshold === 'number'
        ? innerObj.patterns_below_threshold
        : 0,
    durationMs,
    error: null,
  };
}

// ── Internals ──────────────────────────────────────────────

function makeEmptyResult(
  error: string | null,
  durationMs: number,
): LlmAnalysisResult {
  return {
    proposals: [],
    summary: '',
    turnsAnalyzed: 0,
    patternsBelowThreshold: 0,
    durationMs,
    error,
  };
}

/**
 * Synchronous `which claude` check. Returns false on any failure
 * (binary missing, exit non-zero, spawn error). We swallow errors
 * here because the only thing we care about is "is it usable" — the
 * answer is `false` in every error case.
 */
function isClaudeOnPath(): boolean {
  try {
    const r = spawnSync('which', ['claude'], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    return typeof r.stdout === 'string' && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Pull the LLM's response text out of the claude CLI JSON wrapper.
 * Returns `null` only when the wrapper itself doesn't parse as JSON.
 *
 * The wrapper shape we expect is:
 *   { "result": "<assistant text>", "model": "...", "total_cost_usd": ... }
 *
 * Some claude versions historically returned the assistant text as a
 * top-level string, or returned the inner JSON directly with no
 * wrapper. We accept all three shapes for resilience.
 */
function extractInnerText(stdout: string): string | null {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    outer !== null &&
    typeof outer === 'object' &&
    'result' in outer &&
    typeof (outer as { result?: unknown }).result === 'string'
  ) {
    return (outer as { result: string }).result;
  }
  if (typeof outer === 'string') return outer;
  // Unexpected shape — return the raw stdout so the caller's second
  // JSON.parse pass treats it as the inner directive payload.
  return stdout;
}

/**
 * Strip a single ```json … ``` (or ``` … ```) fence if the LLM
 * ignored the "no fences" instruction. Idempotent for clean input.
 */
function stripMarkdownFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m && m[1] !== undefined ? m[1].trim() : s;
}

// ── Legacy compatibility shim ──────────────────────────────
//
// The v9 entry point `runLlmBatch` is retained as a no-op so the
// existing CLAUDE_SOP_LEARNER_MODE=llm code path in src/learner/main.ts
// still compiles during the Wave 2 → Wave 3 transition. Wave 3 deletes
// these exports and rewires main.ts to call `runLlmAnalysis` directly.

/** @deprecated Removed in Wave 3. Use `runLlmAnalysis`. */
export class ClaudeNotInstalled extends Error {
  constructor() {
    super('claude CLI not found in PATH');
    this.name = 'ClaudeNotInstalled';
  }
}

/** @deprecated Removed in Wave 3. Use `runLlmAnalysis`. */
export async function runLlmBatch(
  _home: string,
  _tickId: string,
  _registry: unknown,
  _totalTurnsNew: number,
): Promise<void> {
  // No-op shim. Wave 3 removes both this function and its caller.
}
