/**
 * Main-thread route handlers: UserPromptSubmit and Stop.
 * This is the happy-path turn lifecycle for main-thread turns only.
 */
import type { UserPromptSubmitPayload, StopPayload } from '../../events.js';
import type { Handler } from './types.js';
import { createPendingTurnDir, finalizeTurnDir, compactIso, generateTurnId } from '../turn-dir.js';
import { resolveCurrentTurn, setCurrentTurn, clearCurrentTurn } from '../session-state.js';
import { startMeta, writeMeta, readMeta, updateMeta } from '../meta.js';
import { writePromptMd, writeResponseMd, extractLastAssistantMessage } from '../prompt-response.js';
import { writeFilesChanged } from '../files-changed.js';
import { finalizeHooks } from './finalize-hooks.js';
import { handleSubagentUserPromptSubmit } from './subagent-route.js';
import { loadHistory } from '../../../managed-section/directive-history.js';
import { detectDirectiveFires, appendFires, detectSelfReportedFires } from '../directive-fire.js';
import type { DirectiveInput } from '../directive-fire.js';

export const handleUserPromptSubmit: Handler<UserPromptSubmitPayload> = (event, ctx): void => {
  // Delegate to subagent handler if agent_id is present
  if (event.agent_id) {
    handleSubagentUserPromptSubmit(event, ctx);
    return;
  }

  const turnId = generateTurnId();
  const ts = compactIso();
  const agent = event.agent_type ?? 'main';
  const filehash = 'pending';

  const pendingDir = createPendingTurnDir({
    capturesDir: ctx.paths.projectCaptureDir,
    ts,
    agent,
    filehash,
    turnId,
  });

  const meta = startMeta(event, {
    projectId: ctx.projectId,
    projectSlug: ctx.projectSlug,
    turnId,
    agent,
    subagentType:
      event.agent_type !== undefined && event.agent_type !== 'main' ? event.agent_type : null,
    hookShimVersion: ctx.hookShimVersion,
  });
  writeMeta(pendingDir, meta);

  const { hitCount } = writePromptMd(pendingDir, event.prompt, ctx.scrubber);
  if (hitCount > 0) {
    updateMeta(pendingDir, { scrubber_hit_count: hitCount });
  }

  // ─── Directive-fire detection ───────────────────────────
  // Records when a user prompt matches an active CLAUDE.md directive.
  // Best-effort — MUST NEVER crash the writer or slow it noticeably.
  if (process.env.AUTO_SOP_DISABLE_FIRE_DETECTION !== '1') {
    try {
      const history = loadHistory(ctx.projectRoot);
      const directives: DirectiveInput[] = [];
      for (const entry of Object.values(history.entries)) {
        if (!entry.pruned && entry.rule_text.length > 0) {
          directives.push({ id: entry.id, rule_text: entry.rule_text, severity: entry.severity });
        }
      }
      if (directives.length > 0) {
        const fires = detectDirectiveFires(
          event.prompt,
          directives,
          event.session_id,
          ctx.projectId,
        );
        if (fires.length > 0) {
          appendFires(ctx.paths.projectStateDir, fires);
        }
      }
    } catch {
      // Silently continue — fire detection is best-effort
    }
  }

  setCurrentTurn(ctx.paths.projectStateDir, event.session_id, {
    turnDir: pendingDir,
    turnId,
  });
};

export const handleStop: Handler<StopPayload> = (event, ctx): void => {
  const current = resolveCurrentTurn(ctx.paths.projectStateDir, event.session_id);
  if (!current) {
    // Orphan stop — no pending turn to finalize. Plan 01-05 ErrorWriter handles this.
    return;
  }

  const { turnDir } = current;

  // Extract and write scrubbed response
  const responseText = extractLastAssistantMessage(event.transcript_path);
  const responseResult = writeResponseMd(turnDir, responseText, ctx.scrubber);

  // V46: Detect self-reported directive fires from Claude's response.
  // Parse [sop:applied:ID] markers. Best-effort — never crashes the writer.
  let selfReportedFires: string[] = [];
  try {
    selfReportedFires = detectSelfReportedFires(responseText);
  } catch {
    // Best-effort — self-report parsing failure is non-fatal
  }

  // Write files-changed.txt
  const filesResult = writeFilesChanged(turnDir, ctx.projectRoot);

  // Single updateMeta call: finalize + counters in one read-write cycle (Fix 7)
  const currentMeta = readMeta(turnDir);
  const finalMeta = updateMeta(turnDir, {
    finalized_at: new Date().toISOString(),
    finalization_reason: 'stop',
    files_changed_count: filesResult.count,
    scrubber_hit_count: (currentMeta?.scrubber_hit_count ?? 0) + responseResult.hitCount,
    self_reported_fires: selfReportedFires,
  });

  // Atomically rename: drop .pending
  const finalizedDir = finalizeTurnDir(turnDir);

  // Run post-finalization hooks (01-06 global mirror, etc.)
  finalizeHooks(finalizedDir, finalMeta, ctx);

  // Clear session marker
  clearCurrentTurn(ctx.paths.projectStateDir, event.session_id);
};
