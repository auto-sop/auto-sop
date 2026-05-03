/**
 * Route handlers for subagent lifecycle events.
 *
 * Owns: SubagentStop dispatch, subagent-scoped UserPromptSubmit/PreToolUse/PostToolUse,
 *       and the orphan-sweep pre-start hook.
 *
 * main.ts is NEVER edited — wiring via routes/index.ts (one-line add) and hook registries.
 */
import type {
  SubagentStopPayload,
  UserPromptSubmitPayload,
  PreToolUsePayload,
  PostToolUsePayload,
} from '../../events.js';
import type { Handler, HandlerContext } from './types.js';
import { createPendingTurnDir, finalizeTurnDir, compactIso, generateTurnId } from '../turn-dir.js';
import { resolveCurrentTurn } from '../session-state.js';
import { startMeta, writeMeta, readMeta, updateMeta } from '../meta.js';
import { writePromptMd, writeResponseMd } from '../prompt-response.js';
import { writeFilesChanged } from '../files-changed.js';
import { processPreToolEvent, processPostToolEvent } from '../tool-call-helpers.js';
import {
  resolveSubagentTurn,
  setSubagentCurrentTurn,
  clearSubagentCurrentTurn,
  linkChildToParent,
} from '../subagent.js';
import { finalizeHooks } from './finalize-hooks.js';
import { registerPreStartHook } from './pre-start-hooks.js';
import { sweepOrphanedTurns, sweepOrphanTmpPayloads } from '../orphan-sweep.js';
import { getErrorWriter } from '../errors.js';

// ── Orphan sweep pre-start hook (runs on UserPromptSubmit only) ──────
registerPreStartHook((event, ctx) => {
  if (event.hook_event_name !== 'UserPromptSubmit') return { abort: false };
  try {
    sweepOrphanedTurns(ctx.paths.projectCaptureDir, ctx.paths.projectPendingCapture);
    sweepOrphanTmpPayloads(ctx.paths.tmpPayloadDir);
  } catch (err) {
    getErrorWriter()?.('orphan_sweep_failed', null, err);
  }
  return { abort: false };
});

// ── Helper: create a subagent turn dir ────────────────────────────────
function openSubagentTurn(
  event: { session_id: string; agent_type?: string | undefined },
  agentId: string,
  ctx: HandlerContext,
  parentTurnId: string | null,
  promptText: string,
): { turnDir: string; turnId: string } {
  const turnId = generateTurnId();
  const ts = compactIso();
  const agent = event.agent_type ?? 'subagent';

  const pendingDir = createPendingTurnDir({
    capturesDir: ctx.paths.projectCaptureDir,
    ts,
    agent,
    filehash: 'pending',
    turnId,
  });

  const meta = startMeta(event as Parameters<typeof startMeta>[0], {
    projectId: ctx.projectId,
    projectSlug: ctx.projectSlug,
    turnId,
    agent,
    subagentType: event.agent_type ?? 'subagent',
    hookShimVersion: ctx.hookShimVersion,
  });
  // Set parent_turn_id for bidirectional linking
  writeMeta(pendingDir, { ...meta, parent_turn_id: parentTurnId });

  writePromptMd(pendingDir, promptText, ctx.scrubber);

  setSubagentCurrentTurn(ctx.paths.projectStateDir, event.session_id, agentId, {
    turnDir: pendingDir,
    turnId,
  });

  return { turnDir: pendingDir, turnId };
}

// ── UserPromptSubmit with agent_id → open subagent child turn ─────────
/**
 * Called from the main handleUserPromptSubmit when event has agent_id.
 * The main-thread route should NOT dispatch to this directly — it short-circuits
 * on agent_id and the main dispatch table routes SubagentStop here.
 * Subagent UserPromptSubmit events are forwarded from the main handler.
 */
export function handleSubagentUserPromptSubmit(
  event: UserPromptSubmitPayload,
  ctx: HandlerContext,
): void {
  if (!event.agent_id) return;

  const parentCurrent = resolveCurrentTurn(ctx.paths.projectStateDir, event.session_id);
  const parentTurnId = parentCurrent?.turnId ?? null;

  openSubagentTurn(event, event.agent_id, ctx, parentTurnId, event.prompt);
}

// ── PreToolUse with agent_id → route to subagent turn dir ─────────────
export const handleSubagentPreToolUse: Handler<PreToolUsePayload> = async (
  event,
  ctx,
): Promise<void> => {
  if (!event.agent_id) return;

  let current = resolveSubagentTurn(ctx.paths.projectStateDir, event.session_id, event.agent_id);

  // Lazy create (Pitfall 9): first event for this agent_id without a prior UserPromptSubmit
  if (!current) {
    const parentCurrent = resolveCurrentTurn(ctx.paths.projectStateDir, event.session_id);
    const parentTurnId = parentCurrent?.turnId ?? null;
    const created = openSubagentTurn(
      event,
      event.agent_id,
      ctx,
      parentTurnId,
      '[no UserPromptSubmit observed for this subagent]',
    );
    current = { turnDir: created.turnDir, turnId: created.turnId };
  }

  await processPreToolEvent(current.turnDir, event, ctx.scrubber);
};

// ── PostToolUse with agent_id → route to subagent turn dir ────────────
export const handleSubagentPostToolUse: Handler<PostToolUsePayload> = async (
  event,
  ctx,
): Promise<void> => {
  if (!event.agent_id) return;

  const current = resolveSubagentTurn(ctx.paths.projectStateDir, event.session_id, event.agent_id);
  if (!current) return; // no open subagent turn — drop silently

  await processPostToolEvent(current.turnDir, event, ctx.scrubber);
};

// ── SubagentStop → finalize child, link to parent, global index ───────
export const handleSubagentStop: Handler<SubagentStopPayload> = (event, ctx): void => {
  if (!event.agent_id) return;

  const child = resolveSubagentTurn(ctx.paths.projectStateDir, event.session_id, event.agent_id);

  if (!child) {
    // SubagentStop without a corresponding open turn
    getErrorWriter()?.('subagent_stop_without_open_turn', null, `agent_id=${event.agent_id}`);
    return;
  }

  const { turnDir: childTurnDir } = child;

  // Write response.md from last_assistant_message (if available)
  const responseText = event.last_assistant_message ?? '';
  const responseResult = writeResponseMd(childTurnDir, responseText, ctx.scrubber);

  // Write files-changed.txt
  const filesResult = writeFilesChanged(childTurnDir, ctx.projectRoot);

  // Single updateMeta call: finalize + counters in one read-write cycle (Fix 7)
  const currentMeta = readMeta(childTurnDir);
  const finalMeta = updateMeta(childTurnDir, {
    finalized_at: new Date().toISOString(),
    finalization_reason: 'subagent_stop',
    files_changed_count: filesResult.count,
    scrubber_hit_count: (currentMeta?.scrubber_hit_count ?? 0) + responseResult.hitCount,
  });

  // Atomically rename: drop .pending
  const finalizedDir = finalizeTurnDir(childTurnDir);

  // Bidirectional linking: append child's turn_id to parent's children_turn_ids
  const parentCurrent = resolveCurrentTurn(ctx.paths.projectStateDir, event.session_id);
  linkChildToParent(finalMeta, parentCurrent?.turnDir ?? null);

  // Run post-finalization hooks (global mirror index, etc.)
  finalizeHooks(finalizedDir, finalMeta, ctx);

  // Clear subagent state marker
  clearSubagentCurrentTurn(ctx.paths.projectStateDir, event.session_id, event.agent_id);
};
