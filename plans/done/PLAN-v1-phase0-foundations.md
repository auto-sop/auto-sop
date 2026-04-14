# claude-sop Phase 0: Distribution Decision + Foundations

## Overview

Bootstrap the claude-sop project: write the distribution-model ADR, stand up the TypeScript + tsup + vitest skeleton, and build three pure-logic libraries that every later phase depends on — **PathResolver**, **Config** (with reserved license namespace), and **Scrubber** (with >95% recall gate against a secret-corpus fixture). Zero Claude Code runtime integration, zero network egress, everything fixture-testable.

This is a greenfield project at `/Users/ugurgokdere/Developer/claude-sop` — the directory is empty. ARCHITECT starts from scratch.

## Architecture Decisions (LOCKED — do not re-decide)

- **Distribution:** Hybrid. Ship as both a pure npm CLI (`npx claude-sop install`) AND a Claude Code Marketplace plugin entry (marketplace source type `npm`). ADR documents this as accepted.
- **Stack:** TypeScript ^5.6, tsup ^8.5 (dual ESM+CJS), Node ≥18.17, macOS + Linux only, Windows refused.
- **Test:** vitest@4 + memfs + zero-network harness (stubs fetch/http/https/net/dns).
- **Libraries:** commander@14 (CLI), execa@9 (spawn git), nanoid@5 (IDs), zod@3 (schemas), proper-lockfile@4 (locks), `yaml` (eemeli) for YAML parsing.
- **PathResolver:** Git remote URL → git toplevel → cwd hierarchy; `sha256[:12]` directory hash; project.json anchor file for move detection.
- **Config:** Zod strict schemas, global (`~/.claude-sop/config.json`) + project (`<proj>/.claude-sop/config.json`) merge, fail-loud on unknown keys, `license` namespace reserved for Phase 6, `secrets.enc` via Node built-in crypto (scrypt KDF + aes-256-gcm + machine-id salt).
- **Scrubber:** Build-time extract secretlint patterns into `baseline.generated.ts` (inline TS string constant — NO __dirname/import.meta.url), 4-stage pipeline (path exclusion → regex pack → Shannon entropy ≥4.5 → redaction), output format `[REDACTED:<sha4>]`.
- **Build constraints:** Zero postinstall scripts. Zero network egress in Phase 0 code paths (enforced by test harness).
- **CI:** GitHub Actions matrix Node 18.17/20.x/22.x × ubuntu-latest + macos-latest. Windows explicitly excluded.

Full context: `.planning/phases/00-distribution-decision-foundations/00-CONTEXT.md`
Full research: `.planning/phases/00-distribution-decision-foundations/00-RESEARCH.md`
Task atoms: `.planning/phases/00-distribution-decision-foundations/00-{01..06}-PLAN.md`

## Implementation Tasks

### Wave 1 — Foundation (parallel, no dependencies)

**1. ARCHITECT: Project skeleton + platform check + zero-network harness** — plan `00-01`
   Files: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.eslintrc.cjs`, `.prettierrc`, `.gitignore`, `.github/workflows/ci.yml`, `src/platform-check.ts`, `src/index.ts` (pure library re-export), `src/cli.ts` (CLI entry with shebang calling `assertPlatformSupported()`), `test/setup/no-network.ts`, `test/platform-check.test.ts`, `test/setup/no-network.test.ts`
   Requirements:
   - Initialize npm project with `engines.node ">=18.17"`, `type: "module"`, dual ESM+CJS via tsup with TWO entries (`src/index.ts` as library, `src/cli.ts` as `bin`), NO `postinstall`/`preinstall`/`install` scripts anywhere.
   - `src/platform-check.ts` exports `assertPlatformSupported()` which calls `process.exit(1)` on win32 (support `CLAUDE_SOP_FAKE_PLATFORM` env var for testing). `src/index.ts` is a PURE re-export with ZERO side effects at import time. `src/cli.ts` imports and calls `assertPlatformSupported()` at startup.
   - `test/setup/no-network.ts` installs global guards: override `globalThis.fetch`, `http.request`, `https.request`, `net.Socket.prototype.connect`, `dns.lookup` — any network attempt throws. Expose `installNoNetworkGuards()` / `restoreNetworkGuards()`. Wire into `vitest.config.ts` setupFiles.
   - CI matrix: Node 18.17 / 20.x / 22.x × ubuntu-latest + macos-latest. Jobs: `lint`, `typecheck`, `test`, `build`, `no-lifecycle-check` (greps `package.json` to prove no postinstall), `windows-refusal-check` (runs `CLAUDE_SOP_FAKE_PLATFORM=win32 node dist/cli.cjs` and asserts exit 1; ALSO asserts `node -e "require('./dist/index.cjs')"` does NOT exit on win32 — proves library is side-effect-free).
   Acceptance:
   - `npm install && npm run build && npm test && npm run lint && npm run typecheck` all green
   - `grep -E '"(pre|post)?install"' package.json` returns nothing
   - `windows-refusal-check` CI job exits 1 from CLI and exits 0 from library on simulated win32
   - no-network harness unit test proves every stubbed primitive throws

**2. ARCHITECT: Distribution ADR document** — plan `00-02`
   Files: `.planning/phases/00-distribution-decision-foundations/ADR-0001-distribution-model.md`
   Requirements:
   - Write an ADR following MADR 4.0 minimal structure with sections: Status (Accepted), Context, Decision Drivers, Considered Options, Decision Outcome, Consequences, Confirmation, Open Questions.
   - Document the hybrid decision: npm CLI + Claude Code Marketplace plugin entry (source type `npm`, pointing at a dedicated marketplace.json repo). Project-local hooks only. Total-within-scope uninstall.
   - List at least 4 open questions for Phase 2 spike: (1) marketplace orchestration mechanism, (2) which settings.json key manages hooks, (3) plugin update propagation behavior, (4) project-local hook stacking with existing user hooks.
   Acceptance: ADR file exists at the path above, contains all 8 MADR sections, ≥4 open questions enumerated.

### Wave 2 — Pure libraries (parallel, all depend on Wave 1 project skeleton)

**3. ARCHITECT: PathResolver** — plan `00-03`
   Files: `src/path-resolver/index.ts`, `src/path-resolver/normalize-remote-url.ts`, `src/path-resolver/git-runner.ts`, `src/path-resolver/identity.ts`, `src/path-resolver/project-json.ts`, `src/path-resolver/types.ts`, plus matching `test/path-resolver/*.test.ts`
   Requirements:
   - `normalize-remote-url.ts`: hand-roll ~40 LOC normalization — strip `.git` suffix, lowercase, handle ssh (`git@github.com:foo/bar.git`), https (`https://github.com/foo/bar`), and git protocol variants. No npm dep (`normalize-git-url` is abandoned).
   - `git-runner.ts`: thin DI wrapper around `execa('git', [...])` so tests can inject a fake. Expose `getRemoteOriginUrl()`, `getToplevel()`, `isGitRepo()`.
   - `identity.ts`: hierarchy resolver. (1) Try `git remote get-url origin` → normalize → `sha256[:12]`; (2) fallback `git rev-parse --show-toplevel` → absolute path → `sha256[:12]`; (3) last-resort `process.cwd()` → absolute path → `sha256[:12]`. Also compute human slug: repo name if git, else `basename(cwd)`.
   - `project-json.ts`: atomic read/write (`writeFile` to temp + rename) of `<project>/.claude-sop/project.json` containing `{remoteUrl, toplevel, cwd, projectId, slug}`. Expose `detectMove(currentProjectJson, currentContext)` returning `{moved: true, oldProjectId, newProjectId}` when remote/toplevel/cwd differ from stored.
   - Tests use memfs + DI'd git-runner — zero real disk, zero real git.
   Acceptance:
   - All PathResolver unit tests pass; identity hierarchy handles all 3 cases deterministically; move detection returns correct old/new project IDs; remote URL normalization matches golden fixtures for ssh/https/git-protocol.

**4. ARCHITECT: Config library + secrets.enc encryption primitives** — plan `00-04`
   Files: `src/config/schema.ts`, `src/config/merge.ts`, `src/config/loader.ts`, `src/config/machine-id.ts`, `src/config/secrets.ts`, `src/config/index.ts`, plus `test/config/*.test.ts`
   Requirements:
   - `schema.ts`: Zod strict schemas — global config (`.strict()` at every level), project override schema (partial overlay), top-level version field `z.literal(1)`, and a RESERVED `license` namespace (schema exists from day one even though Phase 6 populates it): `license: z.object({ apiKey: z.string().optional(), trialStartIso: z.string().optional(), lastValidationIso: z.string().optional() }).strict()`. Export `ConfigError` class with `.file` and `.unknownKeys` fields.
   - `merge.ts`: merge global + project, project wins where present, fail-loud on unknown keys at every depth.
   - `machine-id.ts`: wrap `node-machine-id` with sha256 + per-install salt fallback chain: (1) `node-machine-id` if available; (2) hash of `os.hostname() + os.userInfo().uid`; never throw.
   - `secrets.ts`: Pure Node built-in crypto — `scryptSync(password, salt, 32)` KDF + `aes-256-gcm` + 12-byte IV. On-disk format is a versioned JSON envelope: `{v: 1, iv: base64, tag: base64, salt: base64, ciphertext: base64}`. Expose `readSecretsFile(path)` / `writeSecretsFile(path, plaintext)` / `createDefaultSecrets()`. Forward-compat via `v` field so Phase 6 can migrate.
   - `loader.ts`: read global + project files, validate via schema, merge, return typed config. On unknown keys throw `ConfigError` listing the offending file and the unknown keys.
   - Zero network usage (harness from Wave 1 enforces in tests).
   Acceptance:
   - All Config tests pass; schema rejects unknown keys with descriptive ConfigError; merge prefers project overrides; `readSecretsFile(writeSecretsFile(x))` round-trips; encryption format versioned and forward-compatible.

**5. ARCHITECT: Scrubber primitives** — plan `00-05a`
   Files: `src/scrubber/types.ts`, `src/scrubber/yaml-loader.ts`, `src/scrubber/path-exclusion.ts`, `src/scrubber/entropy.ts`, `src/scrubber/redaction.ts`, plus `test/scrubber/*.test.ts` for each
   Requirements:
   - `types.ts`: rule shape `{id, pattern (string regex), replacement?, severity}`, `ScrubbedResult`, `ScrubberOptions`.
   - `yaml-loader.ts`: parse YAML rule packs via `yaml` (eemeli); validate shape via Zod; support layered loading (baseline first, then user pack from `~/.claude-sop/rules/*.yaml`).
   - `path-exclusion.ts`: skip binary and cache dirs (`.git`, `node_modules`, `dist`, `.next`, common image extensions, etc.) — exported list, not hard-coded in pipeline.
   - `entropy.ts`: Shannon entropy implementation; `ENTROPY_THRESHOLD = 4.5` const (strict); `shannonEntropy(s: string): number` function.
   - `redaction.ts`: format redacted values as `[REDACTED:${sha256(original).slice(0,4)}]` (4 hex chars). Exports `redact(original: string): string`.
   Acceptance: all primitives unit-tested; YAML loader rejects malformed shapes; entropy returns expected values for known-entropy strings; redaction format matches exactly.

**6. ARCHITECT: Scrubber pipeline + baseline extractor + NOTICES** — plan `00-05b` (depends on Wave 2 plan 5 above)
   Files: `scripts/extract-secretlint-rules.ts`, `src/scrubber/baseline.generated.ts` (generated), `src/scrubber/regex-pipeline.ts`, `src/scrubber/scrubber.ts`, `src/scrubber/index.ts`, `NOTICES.md`, plus integration tests
   Requirements:
   - `scripts/extract-secretlint-rules.ts`: Node script that imports `@secretlint/secretlint-rule-preset-recommend` as a DEV dependency, walks its rule exports, extracts regex patterns (anthropic `sk-ant-*`, AWS access keys, GitHub tokens, Slack, Stripe, GitLab, JWT), and emits `src/scrubber/baseline.generated.ts` containing `export const BASELINE_YAML = \`...\`;` — a TypeScript string constant, NOT a .yaml file. This avoids all `__dirname`/`import.meta.url` dual-module complexity.
   - `regex-pipeline.ts`: compose baseline + user rules into an ordered regex pipeline; apply to input text and return list of `{match, ruleId, start, end}`.
   - `scrubber.ts`: facade that wires together the 4 stages — (1) path exclusion check, (2) regex pipeline, (3) Shannon entropy catch-all for remaining high-entropy tokens, (4) redaction formatter. Import `BASELINE_YAML` from `baseline.generated.ts` as a module constant — zero disk reads at runtime.
   - `NOTICES.md`: attribution for secretlint-derived patterns (MIT license).
   - `package.json`: add dev script `"extract-rules": "tsx scripts/extract-secretlint-rules.ts"`.
   - CI gets a `baseline-regeneration-check` job: `npm run extract-rules && git diff --exit-code src/scrubber/baseline.generated.ts` — fails if committed file drifts from extractor output.
   Acceptance:
   - Extractor produces deterministic output; `grep -E "__dirname|import\.meta\.url" src/scrubber/scrubber.ts` returns nothing; integration test shows full pipeline redacts a mixed-content sample; regeneration CI check passes.

### Wave 3 — Gate

**7. ARCHITECT: Scrubber fixture corpus + >95% recall gate** — plan `00-06` (depends on plan 6 above)
   Files: `test/fixtures/scrubber/positives/anthropic/*`, `test/fixtures/scrubber/positives/aws/*`, `test/fixtures/scrubber/positives/github/*`, `test/fixtures/scrubber/positives/gitlab/*`, `test/fixtures/scrubber/positives/slack/*`, `test/fixtures/scrubber/positives/stripe/*`, `test/fixtures/scrubber/positives/jwt/*`, `test/fixtures/scrubber/positives/env-kv/*`, `test/fixtures/scrubber/positives/high-entropy-generic/*`, `test/fixtures/scrubber/negatives/uuids/*`, `test/fixtures/scrubber/negatives/git-shas/*`, `test/fixtures/scrubber/negatives/base64-hashes/*`, `test/fixtures/scrubber/negatives/docs/*`, `test/scrubber/recall.test.ts`, `.planning/phases/00-distribution-decision-foundations/scrubber-recall-report.json`
   Requirements:
   - Build a fixture corpus: 9 positives categories (anthropic, aws, github, gitlab, slack, stripe, jwt, env KEY=VALUE, high-entropy generic), each with ≥10 realistic samples; 4 negatives categories (UUIDs, git SHAs, base64 content hashes, sample docs/prose) that must NOT trigger.
   - `recall.test.ts` runs the full Scrubber pipeline over every positives fixture and asserts `recall >= 0.95`; runs it over every negatives fixture and asserts `falsePositiveRate <= 0.05`.
   - Emits a deterministic JSON report at `.planning/phases/00-distribution-decision-foundations/scrubber-recall-report.json` with per-category recall and FPR numbers.
   - CI `scrubber-recall-check` job: runs the recall test, then `git diff --exit-code scrubber-recall-report.json` to guarantee the committed report matches current behavior — prevents silent recall drift.
   Acceptance:
   - `npx vitest run test/scrubber/recall.test.ts` passes
   - `recall >= 0.95` and `FPR <= 0.05` on the full corpus
   - `scrubber-recall-report.json` exists and is deterministic (git-stable)
   - CI `scrubber-recall-check` job fails the build if recall drops below 0.95

## Quality Gates (MANDATORY — run BEFORE commit)

**8. YODA: Code review** — review every file ARCHITECT wrote in tasks 1–7. Focus on project conventions (new project, so: TypeScript strict mode compliance, module boundaries, error handling, DI for testability, import hygiene, no `any`, no `console.log` in library code). Blocks on D/F grade.

**9. APEX: Security audit** — review especially: (a) `secrets.ts` encryption (aes-256-gcm use, IV handling, key derivation), (b) `machine-id.ts` fallback (no secrets leaked to logs), (c) scrubber regex patterns (no ReDoS), (d) `no-network.ts` guard completeness (all egress paths covered), (e) `path-resolver` git command injection surface (argv-only, no shell). Blocks on P0/P1 findings.

**10. ANALYZER: Code improvement review** — readability, performance, best practices across all files. Blocks on D/F grade.

_(No PRISM for Phase 0 — zero UI/frontend work. PRISM returns to the loop in later phases when the CLI surface lands.)_

## Finalize

**11. ARCHITECT: Commit all changes** — only after YODA + APEX + ANALYZER all approve. Single cohesive commit (or per-wave commits if ARCHITECT prefers) with message `feat(phase-0): distribution ADR + PathResolver + Config + Scrubber + recall gate`.

## Acceptance Criteria (Phase 0 goal-backward verification)

Every item below must be true before Phase 0 is considered complete:

1. **ADR accepted:** `.planning/phases/00-distribution-decision-foundations/ADR-0001-distribution-model.md` exists, status Accepted, hybrid distribution documented, ≥4 open questions listed for Phase 2 spike.
2. **Scrubber recall gate passes:** `npx vitest run test/scrubber/recall.test.ts` reports `recall >= 0.95` across the 9 positives categories; `FPR <= 0.05` across the 4 negatives categories; `scrubber-recall-report.json` is git-stable.
3. **Scrubber layered:** baseline rule pack (generated from secretlint) + user rule pack from `~/.claude-sop/rules/` both load via `yaml-loader.ts` and compose in `regex-pipeline.ts`.
4. **Engines + Windows refusal:** `package.json` has `engines.node >=18.17`; CI `windows-refusal-check` job proves CLI exits 1 on simulated win32 AND library entry (`dist/index.cjs`) remains side-effect-free on win32.
5. **Zero postinstall, zero network:** `grep -E '"(pre|post)?install"' package.json` empty; `test/setup/no-network.ts` harness installed in vitest setupFiles; every Phase 0 unit test runs under the harness; any accidental egress throws.
6. **CI matrix green:** Node 18.17 / 20.x / 22.x × ubuntu-latest + macos-latest; all jobs green on the commit; Windows NOT in matrix.
7. **PathResolver deterministic:** identity hierarchy (git remote → toplevel → cwd) produces stable `sha256[:12]` IDs; `detectMove` returns correct old/new IDs when project moved.
8. **Config round-trips:** `readSecretsFile(writeSecretsFile(x))` returns `x`; Zod strict schemas reject unknown keys with descriptive `ConfigError`; `license` namespace reserved in schema from day one (empty but present).
9. **All three mandatory quality gates pass:** YODA approved, APEX approved (no P0/P1), ANALYZER approved (grade ≥ C).
10. **Everything committed:** git log shows `feat(phase-0): ...` commit with all Phase 0 files.

## Notes for Commander

- This is a **greenfield** project — the directory is empty. ARCHITECT starts by creating `package.json` and `npm install`-ing deps. Pre-flight: verify Node ≥18.17 is available (`node --version`).
- NO dev server required — Phase 0 is pure library code. PRISM is NOT needed for this phase.
- Task ordering: **Wave 1 parallel** (plan 1 + plan 2) → **Wave 2 parallel** (plans 3, 4, 5) → **plan 6 after plan 5** → **plan 7 after plan 6** → **quality gates** → **commit**.
- Each ARCHITECT task references a detailed GSD XML plan in `.planning/phases/00-distribution-decision-foundations/` — use those as the source of truth for file names, exact actions, and verification steps.
- Do NOT implement anything from Phase 1+ (no hook shim, no installer, no scheduler, no learner, no ed25519, no SEA binary, no license client). Config schema reserves the `license` namespace but does NOT populate it.
