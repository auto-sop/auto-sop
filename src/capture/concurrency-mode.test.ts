import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  MULTI_SESSION_ENV_VARS,
  isEventCapturedInMode,
  resolveCaptureMode,
  type CaptureMode,
} from './concurrency-mode.js';
import { isCaptureDisabled } from './kill-switch.js';
import type { HookEventName } from './writer/routes/types.js';

const [ARMY_PROJECT_VAR, ARMY_HOME_VAR] = MULTI_SESSION_ENV_VARS;
const SUPPRESS_VAR = 'AUTO_SOP_CAPTURE_SUPPRESS';
const TURN_LEVEL_EVENTS: HookEventName[] = ['UserPromptSubmit', 'Stop', 'SubagentStop'];
const TOOL_CALL_EVENTS: HookEventName[] = ['PreToolUse', 'PostToolUse'];
const ALL_EVENTS: HookEventName[] = [...TURN_LEVEL_EVENTS, ...TOOL_CALL_EVENTS];

/** The writer is spawned synchronously; this bounds a hung writer, not a slow one. */
const WRITER_TIMEOUT_MS = 30_000;
const BUILT_WRITER = join(process.cwd(), 'dist', 'capture', 'writer.cjs');

/**
 * The developer's own shell may be an army pane, so every environment a test
 * relies on is built from scratch with the mode and kill-switch variables
 * removed, then given exactly what the case needs.
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DEV_ARMY_') || k.startsWith('AUTO_SOP_') || k.startsWith('CLAUDE_SOP_')) {
      continue;
    }
    env[k] = v;
  }
  return { ...env, ...extra };
}

describe('resolveCaptureMode', () => {
  it('selects full in a clean environment', () => {
    expect(resolveCaptureMode(cleanEnv())).toBe('full');
  });

  it.each(MULTI_SESSION_ENV_VARS)('selects lightweight when %s is set', (name) => {
    expect(resolveCaptureMode(cleanEnv({ [name]: 'my-project' }))).toBe('lightweight');
  });

  it('selects lightweight when both army variables are set', () => {
    const env = cleanEnv({ [ARMY_PROJECT_VAR]: 'my-project', [ARMY_HOME_VAR]: '/opt/army' });
    expect(resolveCaptureMode(env)).toBe('lightweight');
  });

  it.each(['', ' ', '0', 'false', 'null'])(
    'treats an ambiguous value %j as present and selects lightweight',
    (value) => {
      expect(resolveCaptureMode(cleanEnv({ [ARMY_PROJECT_VAR]: value }))).toBe('lightweight');
    },
  );

  it('selects lightweight when the environment cannot be read', () => {
    const unreadable = new Proxy({} as NodeJS.ProcessEnv, {
      get() {
        throw new Error('environment unavailable');
      },
    });
    expect(resolveCaptureMode(unreadable)).toBe('lightweight');
  });

  it('ignores unrelated variables that merely look similar', () => {
    expect(resolveCaptureMode(cleanEnv({ DEV_ARMY: '1', ARMY_HOME: '/x' }))).toBe('full');
  });

  it('reads process.env by default', () => {
    vi.stubEnv(ARMY_PROJECT_VAR, 'stubbed');
    try {
      expect(resolveCaptureMode()).toBe('lightweight');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('isEventCapturedInMode', () => {
  it.each(ALL_EVENTS)('full mode records %s', (event) => {
    expect(isEventCapturedInMode(event, 'full')).toBe(true);
  });

  it.each(TURN_LEVEL_EVENTS)('lightweight mode keeps turn-level event %s', (event) => {
    expect(isEventCapturedInMode(event, 'lightweight')).toBe(true);
  });

  it.each(TOOL_CALL_EVENTS)('lightweight mode drops per-tool-call event %s', (event) => {
    expect(isEventCapturedInMode(event, 'lightweight')).toBe(false);
  });
});

describe('kill switch is independent of capture mode', () => {
  const modes: Array<[CaptureMode, NodeJS.ProcessEnv]> = [
    ['full', cleanEnv({ [SUPPRESS_VAR]: '1' })],
    ['lightweight', cleanEnv({ [SUPPRESS_VAR]: '1', [ARMY_PROJECT_VAR]: 'my-project' })],
  ];

  it.each(modes)('%s mode: AUTO_SOP_CAPTURE_SUPPRESS=1 still suppresses', (mode, env) => {
    expect(resolveCaptureMode(env)).toBe(mode);
    expect(isCaptureDisabled(env)).toBe(true);
  });

  it('army variables alone never suppress capture', () => {
    expect(isCaptureDisabled(cleanEnv({ [ARMY_PROJECT_VAR]: 'p', [ARMY_HOME_VAR]: '/h' }))).toBe(
      false,
    );
  });
});

// ── End to end through the built writer ──────────────────────────────────
// The writer is where the mode takes effect, so these drive the real bundle
// the way an installed hook does: a payload file path on argv.

describe('built writer honours the capture mode', () => {
  let root: string;
  let project: string;
  let home: string;

  beforeAll(() => {
    if (!existsSync(BUILT_WRITER)) {
      throw new Error(`missing ${BUILT_WRITER} — run 'npm run build' before the tests`);
    }
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'auto-sop-mode-'));
    project = join(root, 'project');
    home = join(root, 'home');
    for (const d of [project, home]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runWriter(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
    const payloadPath = join(root, `${randomUUID()}.json`);
    writeFileSync(payloadPath, JSON.stringify(payload), { mode: 0o600 });
    const proc = spawnSync(process.execPath, [BUILT_WRITER, payloadPath], {
      cwd: project,
      env: { ...env, HOME: home },
      timeout: WRITER_TIMEOUT_MS,
    });
    expect(proc.status).toBe(0);
    return payloadPath;
  }

  const base = (event: string): Record<string, unknown> => ({
    session_id: randomUUID(),
    transcript_path: join(root, 'transcript.jsonl'),
    cwd: project,
    hook_event_name: event,
  });
  const prompt = (): Record<string, unknown> => ({
    ...base('UserPromptSubmit'),
    prompt: 'refactor the order service',
  });
  const preTool = (): Record<string, unknown> => ({
    ...base('PreToolUse'),
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'toolu_1',
  });

  const SUBAGENT_RESULT = 'Found 12 call sites of service.process';
  const subagentStop = (): Record<string, unknown> => ({
    ...base('SubagentStop'),
    agent_id: 'agent_1',
    agent_type: 'Explore',
    last_assistant_message: SUBAGENT_RESULT,
  });

  const captureDir = (): string => join(project, '.auto-sop');

  function onlyTurnMeta(): Record<string, unknown> {
    const capturesDir = join(captureDir(), 'captures');
    const turns = readdirSync(capturesDir);
    expect(turns).toHaveLength(1);
    return JSON.parse(readFileSync(join(capturesDir, turns[0]!, 'meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('full mode: a turn meta.json carries no capture_mode field', () => {
    runWriter(prompt(), cleanEnv());
    expect(onlyTurnMeta()).not.toHaveProperty('capture_mode');
  });

  it('lightweight mode: a turn meta.json records capture_mode', () => {
    runWriter(prompt(), cleanEnv({ [ARMY_PROJECT_VAR]: 'my-project' }));
    expect(onlyTurnMeta()).toHaveProperty('capture_mode', 'lightweight');
  });

  it('lightweight mode: a tool-call event writes nothing and its payload is consumed', () => {
    const payloadPath = runWriter(preTool(), cleanEnv({ [ARMY_HOME_VAR]: '/opt/army' }));
    expect(existsSync(captureDir())).toBe(false);
    expect(existsSync(payloadPath)).toBe(false);
  });

  it('full mode: the same tool-call event still reaches the writer pipeline', () => {
    runWriter(preTool(), cleanEnv());
    // No turn is open, so nothing is appended — but the writer did resolve the
    // project and create its capture directories, proving it was not dropped.
    expect(existsSync(captureDir())).toBe(true);
  });

  it('lightweight mode: a subagent result is kept although its tool calls never opened a turn', () => {
    runWriter(subagentStop(), cleanEnv({ [ARMY_PROJECT_VAR]: 'my-project' }));

    const capturesDir = join(captureDir(), 'captures');
    const turns = readdirSync(capturesDir);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endsWith('.pending')).toBe(false);
    const response = readFileSync(join(capturesDir, turns[0]!, 'response.md'), 'utf8');
    expect(response).toContain(SUBAGENT_RESULT);
    expect(onlyTurnMeta()).toMatchObject({
      capture_mode: 'lightweight',
      finalization_reason: 'subagent_stop',
    });
  });

  it('full mode: a subagent stop with no open turn is still not invented', () => {
    runWriter(subagentStop(), cleanEnv());
    expect(readdirSync(join(captureDir(), 'captures'))).toHaveLength(0);
  });

  it.each([
    ['full', cleanEnv({ [SUPPRESS_VAR]: '1' })],
    ['lightweight', cleanEnv({ [SUPPRESS_VAR]: '1', [ARMY_PROJECT_VAR]: 'my-project' })],
  ])('%s mode: AUTO_SOP_CAPTURE_SUPPRESS=1 suppresses a turn-level event', (_mode, env) => {
    const payloadPath = runWriter(prompt(), env);
    expect(existsSync(captureDir())).toBe(false);
    expect(existsSync(payloadPath)).toBe(false);
  });
});
