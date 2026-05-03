import type { HookPayloadType } from '../../events.js';
import type { CapturePaths } from '../../paths.js';
import type { Scrubber } from '../../../scrubber/index.js';

export interface HandlerContext {
  projectRoot: string;
  projectId: string;
  projectSlug: string;
  paths: CapturePaths;
  scrubber: Scrubber;
  hookShimVersion: string;
}

export type HookEventName = HookPayloadType['hook_event_name'];
export type Handler<E extends HookPayloadType = HookPayloadType> = (
  event: E,
  ctx: HandlerContext,
) => Promise<void> | void;
export type ErrorWriter = (kind: string, turnId: string | null, err: unknown) => void;
