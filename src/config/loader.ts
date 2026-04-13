import { promises as fs } from 'node:fs';
import { ZodError } from 'zod';
import { configSchema, projectOverrideSchema, type ConfigV1 } from './schema.js';
import { mergeConfigs } from './merge.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly file: string,
    public readonly unknownKeys?: readonly string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function createDefaultConfig(): ConfigV1 {
  return configSchema.parse({ version: 1 });
}

function collectUnknownKeys(err: ZodError): string[] {
  const keys: string[] = [];
  for (const issue of err.issues) {
    if (issue.code === 'unrecognized_keys') {
      keys.push(...issue.keys);
    }
  }
  return keys;
}

function formatZodError(err: ZodError, file: string): ConfigError {
  const lines: string[] = [];
  const unknownKeys = collectUnknownKeys(err);
  for (const issue of err.issues) {
    const path = '/' + issue.path.join('/');
    if (issue.code === 'unrecognized_keys') {
      lines.push(`  unknown keys at ${path}: [${issue.keys.join(', ')}]`);
    } else {
      lines.push(`  ${path}: ${issue.message}`);
    }
  }
  return new ConfigError(
    `Config error in ${file}:\n${lines.join('\n')}`,
    file,
    unknownKeys.length > 0 ? unknownKeys : undefined,
  );
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface LoadConfigOptions {
  globalPath: string;
  projectPath?: string | null;
}

export async function loadConfig(opts: LoadConfigOptions): Promise<ConfigV1> {
  const globalRaw = (await readJsonFile(opts.globalPath)) ?? { version: 1 };
  let global: ConfigV1;
  try {
    global = configSchema.parse(globalRaw);
  } catch (err) {
    if (err instanceof ZodError) throw formatZodError(err, opts.globalPath);
    throw err;
  }

  if (!opts.projectPath) return global;

  const projectRaw = await readJsonFile(opts.projectPath);
  if (!projectRaw) return global;

  let override;
  try {
    override = projectOverrideSchema.parse(projectRaw);
  } catch (err) {
    if (err instanceof ZodError) throw formatZodError(err, opts.projectPath);
    throw err;
  }

  return mergeConfigs(global, override);
}
