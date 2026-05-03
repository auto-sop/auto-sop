import { join } from 'node:path';

// __dirname is baked in by tsup at bundle time (CJS output).
export const WRITER_ENTRY = join(__dirname, 'writer.cjs');
