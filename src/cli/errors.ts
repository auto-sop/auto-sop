export class PreconditionError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'PreconditionError';
    this.hint = hint ?? undefined;
  }
}
