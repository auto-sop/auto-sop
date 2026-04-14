export const ExitCode = {
  SUCCESS: 0,
  GENERIC_FAILURE: 1,
  MISUSE: 2,
  PRECONDITION_FAILED: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
