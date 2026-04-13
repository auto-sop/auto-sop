/**
 * Thin semantic wrapper around turn-dir session state helpers.
 * Session state marker files live under `<project>/.claude-sop/state/`,
 * not inside the captures directory.
 */
export { resolveCurrentTurn, setCurrentTurn, clearCurrentTurn } from './turn-dir.js';
export type { CurrentTurnState } from './turn-dir.js';
