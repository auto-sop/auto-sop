/**
 * Real-time learner trigger hook — wired via side-effect import in routes/index.ts.
 *
 * On each Stop event, increments a turn counter. When the counter reaches
 * REALTIME_TRIGGER_THRESHOLD and the cooldown period has elapsed, spawns
 * the learner in the background. All operations are wrapped in try/catch
 * to NEVER crash the capture writer.
 *
 * State is persisted to <projectStateDir>/realtime-trigger.json so the
 * counter survives process restarts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { registerFinalizeHook } from './finalize-hooks.js';
import { getErrorWriter } from '../errors.js';

// ── Constants ──────────────────────────────────────────────

/** Number of finalized turns before triggering the learner. */
export const REALTIME_TRIGGER_THRESHOLD = 10;

/** Minimum milliseconds between consecutive learner triggers. */
export const REALTIME_COOLDOWN_MS = 600_000; // 10 minutes

const STATE_FILE = 'realtime-trigger.json';

// ── Types ──────────────────────────────────────────────────

export interface RealtimeTriggerState {
  turnsSinceLastTrigger: number;
  lastTriggeredAt: number;
}

// ── Helpers (exported for testing) ─────────────────────────

export function readTriggerState(stateDir: string): RealtimeTriggerState {
  const filePath = join(stateDir, STATE_FILE);
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RealtimeTriggerState>;
    if (
      typeof parsed.turnsSinceLastTrigger === 'number' &&
      typeof parsed.lastTriggeredAt === 'number'
    ) {
      return {
        turnsSinceLastTrigger: parsed.turnsSinceLastTrigger,
        lastTriggeredAt: parsed.lastTriggeredAt,
      };
    }
  } catch {
    // Missing or corrupted — return default
  }
  return { turnsSinceLastTrigger: 0, lastTriggeredAt: 0 };
}

export function writeTriggerState(stateDir: string, state: RealtimeTriggerState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, STATE_FILE), JSON.stringify(state), 'utf8');
}

export function resolveLearnerPath(): string | null {
  // Production path: ~/.auto-sop/marketplace/auto-sop/learner.cjs
  const prodPath = join(homedir(), '.auto-sop', 'marketplace', 'auto-sop', 'learner.cjs');
  if (existsSync(prodPath)) return prodPath;

  // Dev fallback: dist/plugin/learner.cjs relative to project root
  const devPath = join(process.cwd(), 'dist', 'plugin', 'learner.cjs');
  if (existsSync(devPath)) return devPath;

  return null;
}

export function spawnLearner(learnerPath: string): void {
  const child = spawn('node', [learnerPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      HOME: homedir(),
      PATH: process.env.PATH ?? '',
      AUTO_SOP_CAPTURE_SUPPRESS: '1',
      CLAUDE_SOP_CAPTURE_SUPPRESS: '1',
    },
  });
  child.unref();
}

// ── Finalize hook: count turns, trigger learner when thresholds met ──

registerFinalizeHook((_finalizedDir, _meta, ctx) => {
  try {
    const stateDir = ctx.paths.projectStateDir;
    const state = readTriggerState(stateDir);

    state.turnsSinceLastTrigger++;

    const now = Date.now();
    const thresholdMet = state.turnsSinceLastTrigger >= REALTIME_TRIGGER_THRESHOLD;
    const cooldownElapsed = now - state.lastTriggeredAt >= REALTIME_COOLDOWN_MS;

    if (thresholdMet && cooldownElapsed) {
      const learnerPath = resolveLearnerPath();
      if (learnerPath !== null) {
        spawnLearner(learnerPath);
        state.turnsSinceLastTrigger = 0;
        state.lastTriggeredAt = now;
      }
    }

    writeTriggerState(stateDir, state);
  } catch (err) {
    getErrorWriter()?.('realtime_learner_hook_failed', _meta.turn_id, err);
  }
});
