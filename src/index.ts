// Pure library entry. Safe to import — does NOT call any startup code.
// Side-effectful startup (platform check) belongs in src/cli.ts.
export { assertPlatformSupported } from './platform-check.js';
export { PathResolver } from './path-resolver/index.js';
export type { ProjectIdentity, ProjectJsonV1, IdentitySource } from './path-resolver/types.js';
export { normalizeRemoteUrl } from './path-resolver/normalize-remote-url.js';
export type { GitRunner } from './path-resolver/git-runner.js';
export { RealGitRunner } from './path-resolver/git-runner.js';
export {
  loadConfig,
  createDefaultConfig,
  ConfigError,
  configSchema,
  encryptSecrets,
  decryptSecrets,
  readSecretsFile,
  writeSecretsFile,
  getMachineId,
} from './config/index.js';
export type { LoadConfigOptions, ConfigV1, SecretsFileV1 } from './config/index.js';
