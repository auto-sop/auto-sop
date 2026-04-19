import { systemdUserAvailable } from './detect.js';
import { macosLaunchd } from './macos-launchd.js';
import { linuxSystemd } from './linux-systemd.js';
import { linuxCron } from './linux-cron.js';
import type { SchedulerBackend } from './types.js';

export type {
  SchedulerBackend,
  SchedulerStatus,
  SchedulerInstallOpts,
} from './types.js';
export { systemdUserAvailable, macosLaunchd, linuxSystemd, linuxCron };

export async function pickBackend(
  platform: NodeJS.Platform = process.platform,
): Promise<{ backend: SchedulerBackend; fallbackWarning?: string }> {
  if (platform === 'darwin') return { backend: macosLaunchd };
  if (platform === 'linux') {
    if (await systemdUserAvailable()) return { backend: linuxSystemd };
    return {
      backend: linuxCron,
      fallbackWarning:
        "systemd --user is unavailable on this system. auto-sop installed an hourly cron entry as a fallback. Reboot-persistence depends on your distribution's cron daemon configuration. For best reliability, enable systemd --user or use a system with lingering support.",
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}
