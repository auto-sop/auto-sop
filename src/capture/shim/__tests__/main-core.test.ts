import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { needsWriter } from '../main-core.js';
import { MULTI_SESSION_ENV_VARS } from '../../concurrency-mode.js';
import type { HookEventName } from '../../writer/routes/types.js';
import { BENCH_WRITER_ENV } from '../main-bench.js';

const [ARMY_PROJECT_VAR, ARMY_HOME_VAR] = MULTI_SESSION_ENV_VARS;
const SUPPRESS_VAR = 'AUTO_SOP_CAPTURE_SUPPRESS';
const TURN_LEVEL_EVENTS: HookEventName[] = ['UserPromptSubmit', 'Stop', 'SubagentStop'];
const TOOL_CALL_EVENTS: HookEventName[] = ['PreToolUse', 'PostToolUse'];
const ALL_EVENTS: HookEventName[] = [...TURN_LEVEL_EVENTS, ...TOOL_CALL_EVENTS];

const EXIT_OK = 0;
/** POSIX permission bits are not meaningful on Windows. */
const isWindows = process.platform === 'win32';
const PAYLOAD_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
/** Bounds a hung shim, not a slow one. */
const SHIM_TIMEOUT_MS = 30_000;
/** Bounds a writer that never reports its exit; stays under Vitest's 10 s hook timeout. */
const WRITER_EXIT_TIMEOUT_MS = 8_000;

const DIST = join(process.cwd(), 'dist');
const BUILT_SHIMS = {
  bench: join(DIST, 'capture', 'shim-bench.cjs'),
  production: join(DIST, 'capture', 'shim.cjs'),
  plugin: join(DIST, 'plugin', 'shim.cjs'),
} as const;

/**
 * Built from scratch so the developer's own shell — which may be an army pane
 * or carry a kill switch — never decides a test's mode.
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DEV_ARMY_') || k.startsWith('AUTO_SOP_') || k.startsWith('CLAUDE_SOP_')) {
      continue;
    }
    if (k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

const lightweightEnv = (): NodeJS.ProcessEnv => cleanEnv({ [ARMY_PROJECT_VAR]: 'army-project' });

function payloadFor(event: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/project',
      hook_event_name: event,
      ...extra,
    }),
  );
}

describe('needsWriter', () => {
  describe('full mode (clean environment)', () => {
    it.each(ALL_EVENTS)('hands off %s', (event) => {
      expect(needsWriter(payloadFor(event), cleanEnv())).toBe(true);
    });

    it('hands off without inspecting the payload, so malformed bytes still reach the writer', () => {
      expect(needsWriter(Buffer.from([0xff, 0xfe, 0x00, 0x01]), cleanEnv())).toBe(true);
      expect(needsWriter(Buffer.from(''), cleanEnv())).toBe(true);
    });
  });

  describe('lightweight mode', () => {
    it.each(TOOL_CALL_EVENTS)('drops %s without a writer', (event) => {
      expect(needsWriter(payloadFor(event), lightweightEnv())).toBe(false);
    });

    it.each(TURN_LEVEL_EVENTS)('keeps %s', (event) => {
      expect(needsWriter(payloadFor(event), lightweightEnv())).toBe(true);
    });

    it.each(MULTI_SESSION_ENV_VARS)('is selected by %s alone', (name) => {
      expect(needsWriter(payloadFor('PreToolUse'), cleanEnv({ [name]: 'x' }))).toBe(false);
    });

    it('is selected when the environment cannot be read', () => {
      const unreadable = new Proxy({} as NodeJS.ProcessEnv, {
        get() {
          throw new Error('environment unavailable');
        },
      });
      expect(needsWriter(payloadFor('PreToolUse'), unreadable)).toBe(false);
      expect(needsWriter(payloadFor('Stop'), unreadable)).toBe(true);
    });

    it('drops a tool event whose payload carries a large tool response', () => {
      const big = payloadFor('PostToolUse', { tool_response: { stdout: 'x'.repeat(1 << 20) } });
      expect(needsWriter(big, lightweightEnv())).toBe(false);
    });

    it('drops an event name the mode does not list', () => {
      expect(needsWriter(payloadFor('SomeFutureEvent'), lightweightEnv())).toBe(false);
    });

    it.each([
      ['non-JSON bytes', Buffer.from([0xff, 0xfe, 0x00, 0x01])],
      ['empty input', Buffer.from('')],
      ['JSON null', Buffer.from('null')],
      ['a JSON array', Buffer.from('["PreToolUse"]')],
      ['an object with no event name', Buffer.from('{"session_id":"s"}')],
      ['a non-string event name', Buffer.from('{"hook_event_name":42}')],
    ])('hands %s to the writer, which owns validation and error logging', (_label, payload) => {
      expect(needsWriter(payload, lightweightEnv())).toBe(true);
    });
  });
});

/**
 * The built shims, driven the way Claude Code drives an installed hook. A
 * probe preloaded into each shim counts its child-process spawns from inside
 * the process, so "no writer was started" is observed, not inferred.
 */
describe('built shim hand-off', () => {
  let root: string;
  let home: string;
  let probe: string;
  let probeLog: string;
  let fakeWriter: string;
  let writerServer: Server;
  let writersExited: number;
  let onWriterExit: () => void;

  const tmpPayloadDir = (): string => join(home, '.auto-sop', 'tmp');
  const tmpPayloads = (): string[] =>
    existsSync(tmpPayloadDir()) ? readdirSync(tmpPayloadDir()) : [];
  const spawnsRecorded = (): number =>
    existsSync(probeLog)
      ? readFileSync(probeLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .reduce((sum, line) => sum + Number(line), 0)
      : 0;

  function runShim(
    shim: string,
    payload: Buffer,
    env: NodeJS.ProcessEnv,
  ): { status: number | null; stderr: string } {
    const proc = spawnSync(process.execPath, [shim], {
      input: payload,
      env: {
        ...env,
        HOME: home,
        USERPROFILE: home,
        [BENCH_WRITER_ENV]: fakeWriter,
        NODE_OPTIONS: `--require ${JSON.stringify(probe)}`,
      },
      encoding: 'utf8',
      timeout: SHIM_TIMEOUT_MS,
    });
    return { status: proc.status, stderr: proc.stderr };
  }

  beforeAll(() => {
    for (const shim of Object.values(BUILT_SHIMS)) {
      if (!existsSync(shim)) {
        throw new Error(`${shim} is missing — run 'npm run build' before this suite`);
      }
    }
  });

  /**
   * Resolves once `count` writers have exited. Each fake writer holds a local
   * IPC connection open until it dies, so the connection's close is its exit.
   */
  function awaitWriterExits(count: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${count - writersExited} writer(s) still running`)),
        WRITER_EXIT_TIMEOUT_MS,
      );
      onWriterExit = () => {
        if (writersExited < count) return;
        clearTimeout(timer);
        resolve();
      };
      onWriterExit();
    });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'auto-sop-shim-core-'));
    // A Unix socket or Windows named pipe: local IPC, no DNS or TCP.
    const exitSocket = isWindows ? `\\\\.\\pipe\\${basename(root)}` : join(root, 'exit.sock');
    writersExited = 0;
    onWriterExit = () => {};
    writerServer = createServer((socket) => {
      socket.on('error', () => {});
      socket.on('close', () => {
        writersExited++;
        onWriterExit();
      });
    });
    await new Promise<void>((resolve) => writerServer.listen(exitSocket, resolve));

    home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    probe = join(root, 'probe.cjs');
    probeLog = join(root, 'spawns.log');
    fakeWriter = join(root, 'fake-writer.cjs');
    // The fake writer leaves the payload in place so the test can inspect it.
    writeFileSync(
      fakeWriter,
      `require('node:net').connect(${JSON.stringify(exitSocket)}, () => process.exit(0));`,
    );
    writeFileSync(
      probe,
      `const cp = require('node:child_process');
const fs = require('node:fs');
let spawns = 0;
const spawn = cp.spawn;
cp.spawn = function (...args) { spawns++; return spawn.apply(this, args); };
process.on('exit', () => fs.appendFileSync(${JSON.stringify(probeLog)}, spawns + '\\n'));
`,
    );
  });

  afterEach(async () => {
    // A detached writer still running would write into root while it is removed (ENOTEMPTY).
    try {
      await awaitWriterExits(spawnsRecorded());
    } finally {
      writerServer.close();
    }
    rmSync(root, { recursive: true, force: true });
  });

  it.each(ALL_EVENTS)('full mode writes the payload and spawns a writer for %s', (event) => {
    const payload = payloadFor(event);
    expect(runShim(BUILT_SHIMS.bench, payload, cleanEnv()).status).toBe(EXIT_OK);

    expect(spawnsRecorded()).toBe(1);
    const files = tmpPayloads();
    expect(files).toHaveLength(1);
    const written = join(tmpPayloadDir(), files[0]!);
    expect(readFileSync(written).equals(payload)).toBe(true);
    if (!isWindows) {
      expect(statSync(written).mode & PERMISSION_BITS).toBe(PAYLOAD_FILE_MODE);
    }
  });

  it.each(TOOL_CALL_EVENTS)(
    'lightweight mode writes nothing and spawns no writer for %s',
    (event) => {
      expect(runShim(BUILT_SHIMS.bench, payloadFor(event), lightweightEnv()).status).toBe(EXIT_OK);

      expect(spawnsRecorded()).toBe(0);
      expect(tmpPayloads()).toHaveLength(0);
    },
  );

  it.each(TURN_LEVEL_EVENTS)(
    'lightweight mode still hands %s to a writer, payload unchanged',
    (event) => {
      const payload = payloadFor(event);
      expect(runShim(BUILT_SHIMS.bench, payload, lightweightEnv()).status).toBe(EXIT_OK);

      expect(spawnsRecorded()).toBe(1);
      const files = tmpPayloads();
      expect(files).toHaveLength(1);
      expect(readFileSync(join(tmpPayloadDir(), files[0]!)).equals(payload)).toBe(true);
    },
  );

  it('lightweight mode still hands a malformed payload to the writer', () => {
    const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
    expect(runShim(BUILT_SHIMS.bench, garbage, lightweightEnv()).status).toBe(EXIT_OK);

    expect(spawnsRecorded()).toBe(1);
    expect(tmpPayloads()).toHaveLength(1);
  });

  it.each([
    ['full', (): NodeJS.ProcessEnv => cleanEnv({ [SUPPRESS_VAR]: '1' })],
    [
      'lightweight',
      (): NodeJS.ProcessEnv => cleanEnv({ [SUPPRESS_VAR]: '1', [ARMY_HOME_VAR]: 'x' }),
    ],
  ])('the kill switch still suppresses every event in %s mode', (_mode, env) => {
    for (const event of ALL_EVENTS) {
      expect(runShim(BUILT_SHIMS.bench, payloadFor(event), env()).status).toBe(EXIT_OK);
    }
    expect(spawnsRecorded()).toBe(0);
    expect(tmpPayloads()).toHaveLength(0);
  });

  it.each([
    ['production', BUILT_SHIMS.production],
    ['plugin', BUILT_SHIMS.plugin],
  ])(
    'the %s shim bundle drops lightweight tool events too, so installed hooks get the saving',
    (_name, shim) => {
      for (const event of TOOL_CALL_EVENTS) {
        expect(runShim(shim, payloadFor(event), lightweightEnv()).status).toBe(EXIT_OK);
      }
      expect(spawnsRecorded()).toBe(0);
      expect(tmpPayloads()).toHaveLength(0);
    },
  );
});
