/**
 * Capture mode for concurrent sessions.
 *
 * Every hook event starts a fresh node shim, which spawns a detached node
 * writer, which shells out to git to resolve the project. One Claude session
 * in a project is cheap. Many sessions in the same project (a multi-agent
 * army) multiply that process volume, and the two per-tool-call events
 * (PreToolUse, PostToolUse) are by far the most frequent. Enough of them at
 * once has been seen to take down the whole terminal multiplexer.
 *
 * This module is the single owner of one decision: should this process
 * capture in `full` mode or in `lightweight` mode, and which hook events does
 * each mode record. It deliberately says nothing about suppression — whether
 * capture runs at all is still decided only by `isCaptureDisabled` in
 * kill-switch.ts, which is always checked first.
 *
 * Detection is environment-only: an army sets its own variables in every
 * pane, so reading them costs nothing and needs no process scans, lock files
 * or polling on the hot path.
 */
import type { HookEventName } from './writer/routes/types.js';

export type CaptureMode = 'full' | 'lightweight';

/**
 * Environment variables whose presence means this session is one of several
 * agents driving the same project. Only their presence is used — their values
 * are never read, so they cannot redirect where or whether capture happens.
 */
export const MULTI_SESSION_ENV_VARS = ['DEV_ARMY_PROJECT_NAME', 'DEV_ARMY_HOME'] as const;

/**
 * Hook events that lightweight mode still records. These fire once per turn
 * rather than once per tool call, and they carry most of the learning signal:
 * the prompt, the final response, the files changed and each subagent's
 * result. PreToolUse and PostToolUse are left out.
 */
const LIGHTWEIGHT_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
]);

/**
 * Decide the capture mode for this process.
 *
 * Any multi-session variable being present — even empty, even with an odd
 * value — selects `lightweight`. If the environment cannot be read at all,
 * `lightweight` is selected too: wrongly assuming a single session is the
 * expensive mistake, wrongly assuming many only reduces detail.
 */
export function resolveCaptureMode(env: NodeJS.ProcessEnv = process.env): CaptureMode {
  try {
    for (const name of MULTI_SESSION_ENV_VARS) {
      if (env[name] !== undefined) return 'lightweight';
    }
    return 'full';
  } catch {
    return 'lightweight';
  }
}

/** Whether `mode` records `event` at all. Full mode records every event. */
export function isEventCapturedInMode(event: HookEventName, mode: CaptureMode): boolean {
  return mode === 'full' || LIGHTWEIGHT_EVENTS.has(event);
}
