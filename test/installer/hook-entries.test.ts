import { describe, it, expect } from 'vitest';
import {
  buildHookEntries,
  HOOK_EVENTS,
  CLAUDE_SOP_HOOK_ID,
  type HookEvent,
} from '../../src/installer/hook-entries.js';

describe('buildHookEntries', () => {
  const shimPath = '/usr/local/lib/node_modules/auto-sop/dist/shim.cjs';
  const entries = buildHookEntries(shimPath);

  it('returns an entry for all 5 hook events', () => {
    const keys = Object.keys(entries) as HookEvent[];
    expect(keys).toHaveLength(5);
    for (const ev of HOOK_EVENTS) {
      expect(entries[ev]).toBeDefined();
    }
  });

  it('each entry has correct command, timeout, id, and type', () => {
    for (const ev of HOOK_EVENTS) {
      const hook = entries[ev]!.hooks[0]!;
      expect(hook.command).toBe(shimPath);
      expect(hook.timeout).toBe(10);
      expect(hook.id).toBe(CLAUDE_SOP_HOOK_ID);
      expect(hook.type).toBe('command');
    }
  });

  it('entries are independent (structuredClone) — mutating one does not affect another', () => {
    const fresh = buildHookEntries(shimPath);
    fresh.Stop.hooks[0]!.command = '/mutated';
    expect(fresh.UserPromptSubmit.hooks[0]!.command).toBe(shimPath);
  });

  it('each entry has exactly one hook', () => {
    for (const ev of HOOK_EVENTS) {
      expect(entries[ev]!.hooks).toHaveLength(1);
    }
  });
});
