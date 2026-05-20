/**
 * Pre-start hook registry. Runs before the main route dispatch.
 * Plan 01-05 registers its disk-budget-and-pause hook here.
 */
import type { HookPayloadType } from '../../events.js';
import type { HandlerContext } from './types.js';
import { enforceDiskBudget, isPaused } from '../disk-budget.js';
import { getErrorWriter } from '../errors.js';
import {
  cleanStaleMarkers,
  cleanNestedStateDir,
  compactSyncQueueIfNeeded,
} from '../state-hygiene.js';

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

// ── State hygiene hook ───────────────────────────────────
// Cleans stale turn markers, nested state dirs, and oversized sync queues.
// Runs on every event — each operation is <5ms and swallows all errors.
let hygieneRanThisInvocation = false;

registerPreStartHook((_event, ctx) => {
  if (hygieneRanThisInvocation) return { abort: false };
  hygieneRanThisInvocation = true;

  const stateDir = ctx.paths.projectStateDir;

  const markers = cleanStaleMarkers(stateDir);
  const nested = cleanNestedStateDir(stateDir);
  const compacted = compactSyncQueueIfNeeded(stateDir);

  const ew = getErrorWriter();
  if (ew && (markers.removed > 0 || nested || compacted !== null)) {
    ew(
      'state_hygiene',
      null,
      `markers=${markers.removed} nested=${nested} compacted=${compacted ? `${compacted.removed}/${compacted.kept}` : 'skip'}`,
    );
  }

  return { abort: false };
});
