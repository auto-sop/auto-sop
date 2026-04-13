/**
 * Normalize any git remote URL to canonical https form.
 *
 * Handles all 6 canonical input formats:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *   git+ssh://git@github.com/owner/repo.git
 *   git://github.com/owner/repo.git
 *
 * Output: https://<host>/<path> (lowercased, no .git suffix)
 *
 * NO npm dependencies. ~30 LOC hand-rolled.
 */
export function normalizeRemoteUrl(raw: string): string {
  let url = raw.trim();

  // Strip git+ prefix (e.g. git+ssh:// → ssh://)
  url = url.replace(/^git\+/, '');

  // Convert SCP-style git@host:path to ssh://git@host/path
  const scpMatch = url.match(/^([^@\s]+@[^:\s]+):(.+)$/);
  if (scpMatch) {
    url = `ssh://${scpMatch[1]}/${scpMatch[2]}`;
  }

  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  let path = parsed.pathname;

  // Strip trailing .git
  path = path.replace(/\.git$/, '');
  // Lowercase the path for determinism
  path = path.toLowerCase();
  // Strip trailing slash
  path = path.replace(/\/+$/, '');

  return `https://${host}${path}`;
}
