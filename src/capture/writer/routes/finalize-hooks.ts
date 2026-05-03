/**
 * Post-finalization hook registry.
 * Plan 01-06 registers its global-mirror index appender here.
 * Plan 01-07 also calls finalizeHooks after subagent finalization.
 */
import type { TurnMeta } from '../../types.js';
import type { HandlerContext } from './types.js';

type FinalizeHook = (finalizedDir: string, meta: TurnMeta, ctx: HandlerContext) => void;

const hooks: FinalizeHook[] = [];

export function registerFinalizeHook(h: FinalizeHook): void {
  hooks.push(h);
}

export function finalizeHooks(finalizedDir: string, meta: TurnMeta, ctx: HandlerContext): void {
  for (const h of hooks) {
    try {
      h(finalizedDir, meta, ctx);
    } catch {
      /* swallow */
    }
  }
}
