export function isCaptureDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_SOP_LEARNER === '1';
}
