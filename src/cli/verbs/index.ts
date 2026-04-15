import type { Command } from 'commander';

// @@VERBS_IMPORTS@@  <-- Wave 2 plans insert import lines here, one per verb
import { registerInstallVerb } from './install.js';
import { registerUninstallVerb } from './uninstall.js';
import { registerPurgeVerb } from './purge.js';
import { registerStatusVerb } from './status.js';
import { registerDoctorVerb } from './doctor.js';
import { registerPauseVerb } from './pause.js';
import { registerResumeVerb } from './resume.js';
import { registerErrorsVerb } from './errors.js';
import { registerRecapVerb } from './recap.js';
import { registerStatuslineVerb } from './statusline.js';

export function registerVerbs(program: Command): void {
  // @@VERBS_REGISTER@@  <-- Wave 2 plans insert register calls here, one per verb
  registerInstallVerb(program);
  registerUninstallVerb(program);
  registerPurgeVerb(program);
  registerStatusVerb(program);
  registerDoctorVerb(program);
  registerPauseVerb(program);
  registerResumeVerb(program);
  registerErrorsVerb(program);
  registerRecapVerb(program);
  registerStatuslineVerb(program);
}
