export const CLAUDE_SOP_HOOK_ID = 'auto-sop';
/** Legacy hook ID for backward-compat detection during uninstall. */
export const LEGACY_HOOK_ID = 'claude-sop';

export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookEntry {
  hooks: Array<{
    type: 'command';
    command: string;
    timeout: number;
    id: string;
  }>;
}

/**
 * Build hook entry objects for all 5 Claude Code hook events.
 * Each entry invokes the shim at `shimAbsPath` with a 10s timeout.
 * Caller is responsible for ensuring shimAbsPath is absolute.
 */
export function buildHookEntries(shimAbsPath: string): Record<HookEvent, HookEntry> {
  const base: HookEntry = {
    hooks: [
      {
        type: 'command',
        command: shimAbsPath,
        timeout: 10,
        id: CLAUDE_SOP_HOOK_ID,
      },
    ],
  };
  const out = {} as Record<HookEvent, HookEntry>;
  for (const ev of HOOK_EVENTS) out[ev] = structuredClone(base);
  return out;
}
