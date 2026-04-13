# Phase 0 Task 3: PathResolver Library — Summary

## Public API

### `PathResolver` (class)
- `constructor(git?: GitRunner)` — defaults to `RealGitRunner`
- `resolve(cwd: string)` → `{ identity, projectClaudeSopDir, stored, move }`
- `writeAnchor(cwd: string, identity: ProjectIdentity)` → atomic write to `.claude-sop/project.json`

### `normalizeRemoteUrl(raw: string): string`
Pure function. Handles 6 git URL formats → canonical `https://host/path` (lowercase, no `.git`).

### `resolveIdentity(cwd: string, git: GitRunner): Promise<ProjectIdentity>`
Identity hierarchy:
1. **Tier 1** — git remote origin → `normalizeRemoteUrl` → `sha256[:12]` (source: `git-remote`)
2. **Tier 2** — git toplevel path → `sha256[:12]` (source: `git-toplevel`)
3. **Tier 3** — cwd → `sha256[:12]` (source: `cwd`)

### `GitRunner` (interface) + `RealGitRunner` (class)
DI wrapper around `execa('git', [...])`. Never throws — returns null on failure.

### `readProjectJson` / `writeProjectJsonAtomic` / `detectMove`
- Atomic write: temp file + `fs.rename`, mode `0o600`
- `detectMove(stored, current)` → `{ moved: boolean, previousProjectId?, currentProjectId }`

## Types
- `ProjectIdentity` — `{ projectId, slug, source, remoteUrl?, toplevel?, cwd }`
- `ProjectJsonV1` — persisted form with `version: 1` and `createdAt`
- `IdentitySource` — `'git-remote' | 'git-toplevel' | 'cwd'`
- `MoveDetection` — `{ moved, previousProjectId?, currentProjectId }`

## Test Count
- **39 total tests** (6 test files, all passing)
- 11 normalize-remote-url tests (all 6 URL formats + edge cases)
- 4 git-runner tests (FakeGitRunner interface contract)
- 7 identity tests (3 tiers + cross-format determinism + slug derivation)
- 10 project-json tests (atomic write, ENOENT, forward-compat, move detection)

## Constraints Met
- Zero npm deps for URL normalization (hand-rolled ~30 LOC)
- Zero network calls (no-network harness in all test files)
- Zero real git in unit tests (DI'd FakeGitRunner)
- No cross-lib coupling (no imports from config/ or scrubber/)
- sha256[:12] for all projectIds
- Atomic project.json writes with 0o600 permissions
