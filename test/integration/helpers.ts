import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  SchedulerBackend,
  SchedulerStatus,
  SchedulerInstallOpts,
} from '../../src/scheduler/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create a temp HOME + project directory pair for integration tests.
 * Returns a cleanup function that removes everything when done.
 */
export async function makeTempHome(): Promise<{
  homeDir: string;
  projectRoot: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-sop-e2e-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  return {
    homeDir,
    projectRoot,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Copy the fixtures/plugin-bundle directory into <destPkgRoot>/dist/plugin
 * so the orchestrator sees it as a valid plugin bundle source.
 */
export async function seedPluginBundleFixture(destPkgRoot: string): Promise<string> {
  const src = path.join(__dirname, 'fixtures', 'plugin-bundle');
  const dst = path.join(destPkgRoot, 'dist', 'plugin');
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true, force: true });
  return dst;
}

/**
 * Create a SchedulerBackend stub that records all calls without touching
 * the real OS (no launchctl, systemctl, or crontab invocations).
 */
export function stubSchedulerBackend(
  overrides: Partial<SchedulerBackend> = {},
): SchedulerBackend & {
  calls: {
    install: SchedulerInstallOpts[];
    uninstall: number;
    status: number;
  };
} {
  const calls = {
    install: [] as SchedulerInstallOpts[],
    uninstall: 0,
    status: 0,
  };
  return {
    name: 'launchd' as const,
    async install(opts: SchedulerInstallOpts) {
      calls.install.push(opts);
    },
    async uninstall() {
      calls.uninstall++;
      return { warnings: [] };
    },
    async status(): Promise<SchedulerStatus> {
      calls.status++;
      return {
        backend: 'launchd',
        installed: calls.install.length > 0,
        lastTickAt: null,
        lastExitCode: null,
        details: {},
      };
    },
    calls,
    ...overrides,
  } as SchedulerBackend & { calls: typeof calls };
}
