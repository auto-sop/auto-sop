/**
 * Pre-start hook registry. Runs before the main route dispatch.
 * Plan 01-05 registers its disk-budget-and-pause hook here.
 */
import type { HookPayloadType } from '../../events.js';
import type { HandlerContext } from './types.js';
import { enforceDiskBudget, isPaused } from '../disk-budget.js';
import { getErrorWriter } from '../errors.js';

export type PreStartHook = (event: HookPayloadType, ctx: HandlerContext) => { abort: boolean };

const hooks: PreStartHook[] = [];

export function registerPreStartHook(h: PreStartHook): void {
  hooks.push(h);
}

export function runPreStartHooks(event: HookPayloadType, ctx: HandlerContext): { abort: boolean } {
  for (const h of hooks) {
    try {
      if (h(event, ctx).abort) return { abort: true };
    } catch {
      /* swallow */
    }
  }
  return { abort: false };
}

// ── Disk budget & pause hook ──────────────────────────────────
// Checks isPaused on every event (silent abort, no log spam).
// On UserPromptSubmit, runs enforceDiskBudget which may create paused.flag.
// Logs 'paused_skipped' exactly once per writer invocation.
let loggedPauseThisInvocation = false;

registerPreStartHook((event, ctx) => {
  // For non-UserPromptSubmit events: just check if already paused
  if (event.hook_event_name !== 'UserPromptSubmit') {
    if (isPaused(ctx.paths.projectPausedFlag)) {
      return { abort: true };
    }
    return { abort: false };
  }

  // UserPromptSubmit: run full budget enforcement
  const res = enforceDiskBudget(ctx.paths.projectCaptureDir, ctx.paths.projectPausedFlag);
  if (res.paused) {
    if (!loggedPauseThisInvocation) {
      loggedPauseThisInvocation = true;
      getErrorWriter()?.('paused_skipped', null, `used=${res.used}`);
    }
    return { abort: true };
  }
  return { abort: false };
});
