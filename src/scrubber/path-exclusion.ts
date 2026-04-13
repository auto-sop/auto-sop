/**
 * Path-exclusion stage (Stage 1).
 * Redacts the entire payload when the tool_input file path matches
 * known sensitive patterns (.env, .pem, id_rsa, secrets, credentials, .key).
 *
 * The pattern list is exported so the pipeline (05b) doesn't hardcode it.
 */

/** Patterns that indicate a file whose contents should never be forwarded. */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..+)?$/,
  /\.pem$/,
  /(^|\/)id_rsa(\.\w+)?$/,
  /(^|\/)id_ed25519(\.\w+)?$/,
  /secret/i,
  /credentials?/i,
  /\.key$/,
];

/** Returns `true` when `filePath` matches any sensitive pattern. */
export function isSensitivePath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath));
}

/**
 * If the path is sensitive, replace the entire payload with a redaction
 * notice. Otherwise pass through unchanged.
 */
export function applyPathExclusion(
  payload: string,
  filePath?: string,
): { redacted: boolean; output: string } {
  if (isSensitivePath(filePath)) {
    return { redacted: true, output: '[REDACTED: sensitive path]' };
  }
  return { redacted: false, output: payload };
}
