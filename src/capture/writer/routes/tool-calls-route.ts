/**
 * Route handlers for PreToolUse and PostToolUse hook events.
 * Dispatched from routes/index.ts — main.ts is NEVER touched (B1/B2).
 */
import type { PreToolUsePayload, PostToolUsePayload } from '../../events.js';
import type { Handler } from './types.js';
import { resolveCurrentTurn } from '../session-state.js';
import { processPreToolEvent, processPostToolEvent } from '../tool-call-helpers.js';
import { handleSubagentPreToolUse, handleSubagentPostToolUse } from './subagent-route.js';

export const handlePreToolUse: Handler<PreToolUsePayload> = async (event, ctx): Promise<void> => {
  const current = resolveCurrentTurn(ctx.paths.projectStateDir, event.session_id);
  if (!current) {
    // Orphan tool use — no pending turn. 01-05 ErrorWriter will log it.
    return;
  }

  // Subagent tool uses are handled by 01-07's subagent-route.ts
  if (event.agent_id) {
    return handleSubagentPreToolUse(event, ctx);
  }

  await processPreToolEvent(current.turnDir, event, ctx.scrubber);
};

export const handlePostToolUse: Handler<PostToolUsePayload> = async (event, ctx): Promise<void> => {
  const current = resolveCurrentTurn(ctx.paths.projectStateDir, event.session_id);
  if (!current) {
    return;
  }

  // Subagent tool uses handled by 01-07
  if (event.agent_id) {
    return handleSubagentPostToolUse(event, ctx);
  }

  await processPostToolEvent(current.turnDir, event, ctx.scrubber);
};
