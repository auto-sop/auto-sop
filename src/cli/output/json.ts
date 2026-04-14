/** Emit stable JSON to stdout. */
export function emit(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

/** Emit a JSON error object to stdout. */
export function emitError(
  code: number,
  message: string,
  hint?: string,
): void {
  process.stdout.write(
    JSON.stringify({ ok: false, code, message, hint }) + '\n',
  );
}
