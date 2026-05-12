/**
 * Route dispatcher barrel.
 * Downstream plans (01-04/05/06/07) add their re-exports here as ONE-LINE additions.
 * This file is the ONLY shared merge surface; main.ts itself is never edited after 01-03.
 */
import type { Handler, HookEventName } from './types.js';
import { handleUserPromptSubmit, handleStop } from './main-thread-route.js';
import { handlePreToolUse, handlePostToolUse } from './tool-calls-route.js';
import { handleSubagentStop } from './subagent-route.js'; // 01-07: subagent lifecycle + orphan sweep hooks
import './global-mirror-hook.js'; // side-effect import — registers finalize + pre-start hooks
import './realtime-learner-hook.js'; // side-effect import — registers finalize hook for real-time learner trigger

export const routes: Partial<Record<HookEventName, Handler>> = {
  UserPromptSubmit: handleUserPromptSubmit as Handler,
  Stop: handleStop as Handler,
  PreToolUse: handlePreToolUse as Handler,
  PostToolUse: handlePostToolUse as Handler,
  SubagentStop: handleSubagentStop as Handler,
};
