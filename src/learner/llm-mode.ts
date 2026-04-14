/**
 * LLM Mode — feature-flagged optional LLM analysis of recent turns.
 * Only called when CLAUDE_SOP_LEARNER_MODE === 'llm'.
 * Uses the existing scrubber to sanitize data before sending to claude -p.
 * 60s timeout. Raw output capped at 8KB, overflow to transcript file.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createScrubber } from '../scrubber/index.js';
import { readRegistry, validateProjectRoot, type ProjectRegistry } from './project-registry.js';
import { scanNewTurns } from './turn-scanner.js';
import { appendRecap } from './recap-log.js';

// ── Constants ──────────────────────────────────────────────

const LLM_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024; // 8KB
const MAX_INPUT_TURNS = 20;

// ── Error classes ──────────────────────────────────────────

export class ClaudeNotInstalled extends Error {
  constructor() {
    super('claude CLI not found in PATH');
    this.name = 'ClaudeNotInstalled';
  }
}

// ── Main ───────────────────────────────────────────────────

export async function runLlmBatch(
  home: string,
  tickId: string,
  registry: ProjectRegistry,
  totalTurnsNew: number,
): Promise<void> {
  // Check claude CLI exists
  try {
    execSync('which claude', { stdio: 'ignore', timeout: 5000 });
  } catch {
    throw new ClaudeNotInstalled();
  }

  // Collect recent turns across all projects (last 20)
  const scrubber = await createScrubber();
  const turnData: Array<{ project: string; turn_id: string; finalized_at: string; tool_calls: number }> = [];

  for (const project of registry.projects) {
    try {
      // Validate project root (SEC-001: prevent path traversal)
      const validRoot = validateProjectRoot(project.project_root);
      const capturesDir = join(validRoot, '.claude-sop', 'captures');
      const scan = scanNewTurns(capturesDir, '', MAX_INPUT_TURNS);
      for (const turn of scan.turns.slice(-MAX_INPUT_TURNS)) {
        turnData.push({
          project: project.slug,
          turn_id: turn.turn_id,
          finalized_at: turn.finalized_at,
          tool_calls: turn.tool_call_count,
        });
      }
    } catch {
      // skip this project
    }
  }

  // Take last MAX_INPUT_TURNS across all projects
  const recentTurns = turnData.slice(-MAX_INPUT_TURNS);

  // Scrub the input
  const inputText = JSON.stringify({
    tick_id: tickId,
    total_turns_new: totalTurnsNew,
    recent_turns: recentTurns,
  });
  const scrubbed = scrubber.scrub({ payload: inputText });

  const prompt = `You are analyzing Claude Code usage patterns. Here is recent activity data:\n\n${scrubbed.scrubbed}\n\nProvide a brief summary of usage patterns, anomalies, and suggestions.`;

  // Spawn claude -p
  const startMs = Date.now();
  let rawOutput: string;
  let model = 'unknown';
  let costUsd = 0;

  try {
    const result = execSync(
      `claude -p --output-format json`,
      {
        input: prompt,
        timeout: LLM_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024, // 1MB
      },
    );
    rawOutput = result;

    // Try to parse JSON response
    try {
      const parsed = JSON.parse(rawOutput);
      model = parsed.model ?? 'unknown';
      costUsd = parsed.total_cost_usd ?? 0;
      rawOutput = parsed.result ?? rawOutput;
    } catch {
      // raw text output — keep as-is
    }
  } catch (err) {
    rawOutput = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const durationMs = Date.now() - startMs;

  // Truncate output to 8KB, overflow to transcript file
  let llmOutput = rawOutput;
  if (Buffer.byteLength(rawOutput, 'utf8') > MAX_OUTPUT_BYTES) {
    llmOutput = rawOutput.slice(0, MAX_OUTPUT_BYTES) + '...[truncated]';
    const transcriptDir = join(home, '.claude-sop', 'logs', 'llm-transcripts');
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, `${tickId}.txt`), rawOutput, { mode: 0o600 });
  }

  // Append LLM recap line
  appendRecap({
    v: 1,
    t: new Date().toISOString(),
    tick_id: tickId,
    summary: true,
    projects_processed: registry.projects.length,
    projects_skipped: 0,
    projects_locked: 0,
    projects_missing: 0,
    total_turns_new: totalTurnsNew,
    total_duration_ms: durationMs,
    errors: [],
    // LLM-specific fields (extra, will be serialized)
    ...(({
      llm: true,
      llm_model: model,
      llm_cost_usd: costUsd,
      llm_duration_ms: durationMs,
      llm_output: llmOutput,
      llm_input_turns: recentTurns.length,
    }) as Record<string, unknown>),
  } as any, home);
}
