import { z } from 'zod';

const BaseHook = z
  .object({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    permission_mode: z.string().optional(),
    hook_event_name: z.string(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
  })
  .passthrough();

export const UserPromptSubmit = BaseHook.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string(),
});

export const PreToolUse = BaseHook.extend({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string(),
});

export const PostToolUse = BaseHook.extend({
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_response: z.unknown(),
  tool_use_id: z.string(),
});

export const Stop = BaseHook.extend({
  hook_event_name: z.literal('Stop'),
});

export const SubagentStop = BaseHook.extend({
  hook_event_name: z.literal('SubagentStop'),
  agent_id: z.string(),
  agent_type: z.string(),
  agent_transcript_path: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

export const HookPayload = z.discriminatedUnion('hook_event_name', [
  UserPromptSubmit,
  PreToolUse,
  PostToolUse,
  Stop,
  SubagentStop,
]);

export type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmit>;
export type PreToolUsePayload = z.infer<typeof PreToolUse>;
export type PostToolUsePayload = z.infer<typeof PostToolUse>;
export type StopPayload = z.infer<typeof Stop>;
export type SubagentStopPayload = z.infer<typeof SubagentStop>;
export type HookPayloadType = z.infer<typeof HookPayload>;
