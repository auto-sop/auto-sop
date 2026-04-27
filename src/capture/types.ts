export const TURN_META_SCHEMA_VERSION = 1;

export interface TurnMeta {
  schema_version: 1;
  project_id: string;
  project_slug: string;
  session_id: string;
  turn_id: string;
  parent_turn_id: string | null;
  children_turn_ids: string[];
  agent: 'main' | string;
  subagent_type: string | null;
  started_at: string;
  finalized_at: string | null;
  finalization_reason: 'stop' | 'subagent_stop' | 'timeout' | null;
  hook_shim_version: string;
  files_changed_count: number;
  tool_call_count: number;
  scrubber_hit_count: number;
  /** V46: directive IDs self-reported by Claude via [sop:applied:ID] markers. */
  self_reported_fires?: string[];
}

export interface ToolCallLinePre {
  event: 'pre';
  tool_use_id: string;
  tool: string;
  input: unknown;
  t: string;
}

export interface ToolCallLinePost {
  event: 'post';
  tool_use_id: string;
  output: unknown;
  duration_ms?: number;
  success: boolean;
  t: string;
}

export type ToolCallLine = ToolCallLinePre | ToolCallLinePost;
