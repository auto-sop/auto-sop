import pc from 'picocolors';

/** Render a two-column key/value table with dimmed keys. */
export function renderTable(rows: Array<[string, string]>): string {
  const maxKeyLen = Math.max(...rows.map(([k]) => k.length), 0);
  return rows.map(([k, v]) => `${pc.dim(k.padEnd(maxKeyLen))}  ${v}`).join('\n');
}

/** Write a yellow warning to stderr. */
export function warn(msg: string): void {
  process.stderr.write(pc.yellow('warning: ') + msg + '\n');
}

/** Write a red error to stderr. */
export function error(msg: string): void {
  process.stderr.write(pc.red('error: ') + msg + '\n');
}
