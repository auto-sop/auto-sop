# Phase 0: Distribution Decision + Foundations — Research

**Researched:** 2026-04-13
**Domain:** Node CLI library foundations — distribution shape, project identity, encrypted config, secret scrubber
**Overall confidence:** HIGH for plugin/marketplace schema, scrubber architecture, and ADR format. MEDIUM for `node-machine-id` security posture (no 2025 CVEs but also no recent audit surfaced). MEDIUM for secretlint rule extraction path (packages exist under MIT, pattern source is JS not JSON).

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

**A — Distribution Model (ADR)**
- Hybrid distribution: ship as BOTH a pure npm CLI (`npx claude-sop install`) AND a Claude Code Marketplace plugin entry.
- Plugin bundle lives as a Claude Code Marketplace entry (not freestanding sideload). The npm CLI's `install` command is responsible for orchestrating marketplace installation on the user's behalf.
- Hook scope is project-local — hooks written to `<project>/.claude/settings.json`, never `~/.claude/settings.json`.
- Uninstall is total-within-scope: `npx claude-sop uninstall` deletes every file, directory, hook entry, scheduler unit, keychain entry, and managed-section marker the plugin ever created. Never touches user-created files or their CLAUDE.md content outside managed markers.

**B — Scrubber Rule Pack**
- Format: YAML (user-facing rule files).
- Baseline corpus: `secretlint` package as a rule-data source, not runtime. Accept the dependency cost for battle-tested coverage (Anthropic/AWS/GitHub/Stripe/Slack/JWT). Runtime regex engine is our own so we control redaction output.
- Entropy threshold: STRICT (Shannon ≥ 4.5). Minimize false-positive destruction of learner context.
- Redacted value format: `[REDACTED:a1b2]` where `a1b2` = first 4 hex chars of SHA-256(secret). Same-secret detection without leaking the secret or its length.

**C — Config Storage**
- Secrets: `~/.claude-sop/secrets.enc` encrypted with machine-id + per-install salt derived key. NOT keychain/libsecret. Encryption is "stop casual filesystem inspection," not cryptographic defense.
- Config split: `~/.claude-sop/config.json` (global defaults) + `<project>/.claude-sop/config.json` (per-project overrides). Project wins.
- Schema: FAIL LOUD on unknown keys. Zod strict schema. No silent ignores.
- First-run creation: auto-create during `install`, no separate `config init`.

**D — Project Identity (PathResolver)**
- Primary ID source hierarchy: (1) `git remote get-url origin` normalized + `sha256[:12]`; (2) `git rev-parse --show-toplevel` absolute path + `sha256[:12]`; (3) `process.cwd()` absolute path + `sha256[:12]`.
- Human slug: repo name if git, else `basename(cwd)`. Stored only in `project.json`.
- Directory naming: `<hash12>` only, NO slug in the path (privacy-leaning).
- Move/rename detection: store `{remoteUrl, toplevel, cwd, projectId}` in `<project>/.claude-sop/project.json` at install time; on subsequent runs, compare and auto-migrate global state dir. Surface in `status`.

**E — License & Anti-RE (Phase 6 territory, Phase 0 must accommodate)**
- Freemium, 14-day trial → subscription. License key collected during `install`. Test key: `123`.
- Phase 0 Config schema must reserve a `license` namespace from day one so Phase 6 doesn't require schema migration.
- Phase 0 code paths have ZERO network egress. License client is Phase 6.
- Anti-RE layers 1+2+3 accepted (obfuscation, SEA binary, ed25519 signed responses). Layers 4+5 rejected.

**Phase 0 Build Order (locked)**
1. Distribution ADR (`ADR-distribution.md`) — first deliverable.
2. **PathResolver** — pure lib.
3. **Config** — Zod schemas, merger, encrypted secrets I/O.
4. **Scrubber** — YAML loader → secretlint rule data → regex pipeline → entropy catch-all → redaction formatter.
5. Test matrix: Node 18.17 / 20.x / 22.x × macOS / Linux. CI green gate.
6. `engines.node >=18.17`, explicit Windows refusal exit.
7. Zero `postinstall`/`preinstall`/`install` npm scripts.

### Claude's Discretion (planner picks; recommendations below)
- Machine-id derivation: `node-machine-id` package vs hashed `os.hostname()+os.userInfo().uid+salt`.
- YAML parser: `yaml` (eemeli/yaml) vs `js-yaml`.
- Hash length: `sha256[:12]` (keep) vs `[:16]`.
- Fixture corpus internal layout (per-rule subdirs vs flat).
- Test runner ergonomics and file naming.

### Deferred Ideas (OUT OF SCOPE for Phase 0)
- License validation client, ed25519 verification, trial countdown UI, subscription gate, obfuscation build pipeline, SEA/pkg binary compile, backend API contract, user-authored rule pack v2.

---

## Executive Summary

- **Distribution ADR: use MADR 4.0 template.** Short, structured, four-variant upstream, well-understood in 2026. Store as `ADR-0001-distribution-model.md` with MADR "minimal" shape.
- **Claude Code marketplace format is fully specified.** Plugin = directory with `.claude-plugin/plugin.json` + `hooks/hooks.json` + component subdirs. Marketplace = `.claude-plugin/marketplace.json` catalog that references plugin sources. The npm CLI's `install` orchestration path is: (a) bundled plugin files get copied into a local marketplace directory under `~/.claude-sop/marketplace/`, (b) CLI shells out to `claude /plugin marketplace add <local-dir>` and `claude /plugin install claude-sop@claude-sop-local` OR the CLI writes directly into `~/.claude/settings.json`'s `extraKnownMarketplaces` (open question — see §2). **This is the single biggest unresolved area**; planner should spike it.
- **PathResolver: hand-rolled with `execa` + small normalization function.** `normalize-git-url` (npm) exists but is abandoned and targets npm-specific edge cases. For our five-line normalization (strip `.git`, lowercase host, collapse `git@host:owner/repo` → `ssh://git@host/owner/repo`) a local function is cheaper and more auditable than a dep.
- **Config encryption: Node built-in `crypto` with `aes-256-gcm` + `scrypt` KDF, no external deps.** Machine-id via `node-machine-id` package (MIT, wraps OS-native sources) — accept the dep; hand-rolling `ioreg`/`/etc/machine-id`/registry shellouts is more fragile than pinning a 40-line library.
- **Scrubber: pipeline of path-exclusion → rule-pack regex (YAML-loaded) → entropy catch-all → SHA-256 fingerprint formatter.** secretlint rule extraction is **not straightforward** — each `@secretlint/secretlint-rule-*` package ships TypeScript-compiled JS with patterns inlined in code, not a JSON manifest. We will vendor a build-time extraction script that pulls patterns from specific upstream rule files, captures commit SHA + license header, and emits our own `baseline.yaml`.
- **YAML parser: `yaml` (eemeli/yaml).** Active maintenance, YAML 1.2 compliant, streaming-capable, same author as Node YAML TC39 discussions. `js-yaml` is more popular but was stale (now v4.1.1) and has no first-class 1.2 support.
- **ZERO-network assertion technique: global `vi.stubGlobal('fetch', ...)` + `vi.mock('node:net')` + spy on `node:http`/`node:https` `request`.** `undici` MockAgent had known compat issues with Vitest 2.1.5+; avoid.

---

## 1. Distribution ADR Content

**Recommendation: MADR 4.0 "minimal" variant.** Store at `.planning/phases/00-distribution-decision-foundations/ADR-0001-distribution-model.md`.

### Structure (MADR 4.0 minimal)

```markdown
# ADR-0001: Distribution Model — Hybrid npm CLI + Claude Code Marketplace Plugin

Status: Accepted
Date: 2026-04-13
Deciders: <user>, claude-sop

## Context and Problem Statement
claude-sop must be installable by Claude Code developers. Two viable channels exist:
the npm registry (universal, `npx`-friendly) and the Claude Code Marketplace (native
UX, auto-updates). Choosing only one excludes a meaningful user segment.

## Decision Drivers
- Developers on Claude Code expect `/plugin install` UX
- Developers on npm workflows expect `npx <pkg> install`
- We need install-time code to write project-scoped hooks and (Phase 6) prompt for license key
- Claude Code plugins cannot run install-time code; marketplace plugins are passive
- Single distribution source for both channels (no divergent artifacts)

## Considered Options
1. npm-only CLI (`npx claude-sop install`)
2. Marketplace plugin only
3. Hybrid: npm CLI is the source; marketplace plugin is a thin catalog entry that
   points users back to the npm CLI (or vice versa)
4. Hybrid: ship a real plugin bundle in the npm package; CLI can register it
   into a local marketplace during `install`

## Decision Outcome
Chosen: **Option 4 — Hybrid, plugin bundle shipped inside the npm package.**
The npm CLI is the orchestrator. On `npx claude-sop install`, the CLI:
1. Writes a local marketplace directory under `~/.claude-sop/marketplace/`
2. Registers it with Claude Code via `claude /plugin marketplace add <path>`
   (or programmatic equivalent — see Open Questions)
3. Installs the plugin via `claude /plugin install claude-sop@claude-sop-local`
4. Writes project-scoped hooks to `<project>/.claude/settings.json`
5. Creates `~/.claude-sop/` config + secrets + project.json anchor

Rationale: this gives us install-time code execution (required for hooks, license
prompt, scheduler setup in Phase 6) AND marketplace discoverability. Hooks are
project-local; uninstall is reversible and total-within-scope.

## Consequences
- Good: Single source of truth (npm). Both user segments addressed.
- Good: Install-time code can prompt, validate, and explain.
- Good: Marketplace plugin inherits from the same bundle (no drift).
- Bad: "Hybrid" is more moving parts than "npm-only."
- Bad: Uninstall must unregister from both the local marketplace AND project settings.
- Bad: We must verify Claude Code's local marketplace registration works programmatically (see Open Questions).

## Confirmation
Phase 2 acceptance test: a fresh machine runs `npx claude-sop install`, sees the
plugin appear in Claude Code's `/plugin` list AND in `<project>/.claude/settings.json`
hook config. `npx claude-sop uninstall` removes BOTH.

## Open Questions (tracked as issues)
- Can the CLI register a marketplace without shelling to interactive `claude /plugin marketplace add`?
- Is there a JSON settings key (e.g., `extraKnownMarketplaces`) we can write directly?
- How does `claude /plugin install` behave non-interactively (needs `--yes` or stdin)?
```

**Sources:**
- [MADR 4.0 templates](https://github.com/adr/madr/tree/4.0.0/template)
- [MADR project](https://adr.github.io/madr/)

**Confidence:** HIGH for template choice. Content drafted above is a starting point; planner should treat it as the skeleton to fill in.

---

## 2. Claude Code Marketplace Plugin Bundle Format

### Verified facts (from https://code.claude.com/docs/en/plugins and /plugin-marketplaces, fetched 2026-04-13)

**Plugin bundle = directory containing:**
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json           # REQUIRED — manifest
├── hooks/
│   └── hooks.json            # hook event handlers
├── skills/<name>/SKILL.md    # optional skills
├── agents/                   # optional subagents
├── commands/                 # optional (legacy flat commands dir)
├── .mcp.json                 # optional MCP server configs
├── .lsp.json                 # optional LSP server configs
├── bin/                      # optional PATH additions
└── settings.json             # optional default Claude Code settings
```

**plugin.json manifest schema (verified):**
```json
{
  "name": "claude-sop",
  "description": "SOP capture + learner for Claude Code",
  "version": "0.1.0",
  "author": { "name": "..." },
  "homepage": "https://...",
  "repository": "https://github.com/.../claude-sop",
  "license": "MIT"
}
```

**Marketplace catalog = `.claude-plugin/marketplace.json` at the root of a git repo or local directory:**
```json
{
  "name": "claude-sop-local",
  "owner": { "name": "claude-sop" },
  "plugins": [
    {
      "name": "claude-sop",
      "source": "./plugin",
      "description": "..."
    }
  ]
}
```

**Plugin source types available in marketplace entries:**
| Source | Fields | Notes |
|---|---|---|
| Relative path (`"./plugin"`) | none | Must start with `./`, resolved to marketplace root |
| `github` | `repo`, `ref?`, `sha?` | |
| `url` | `url`, `ref?`, `sha?` | Any git URL |
| `git-subdir` | `url`, `path`, `ref?`, `sha?` | Sparse clone for monorepos |
| `npm` | `package`, `version?`, `registry?` | Plugin installed via `npm install` (!!) |

**CRITICAL FINDING:** There IS an `npm` plugin source type. This means our marketplace entry can literally be `{ "source": { "source": "npm", "package": "claude-sop" } }` and Claude Code will run `npm install` under the hood. This is the cleanest hybrid shape and the planner should strongly consider it.

**User-facing install flow:**
```
/plugin marketplace add <url-or-local-path>     # adds a catalog
/plugin install claude-sop@claude-sop-local     # installs named plugin
/plugin marketplace update                       # refresh
```

**Plugin cache location (verified):** `~/.claude/plugins/cache`

### Orchestrating marketplace install from the CLI

**Three paths, in decreasing preference:**

1. **Publish an NPM-sourced marketplace entry** — Host a `marketplace.json` at a stable URL (e.g., `https://claude-sop.dev/.claude-plugin/marketplace.json` or a tiny GitHub repo `claude-sop/marketplace`). The entry uses `{"source": "npm", "package": "claude-sop"}`. Users run `/plugin marketplace add https://github.com/claude-sop/marketplace` once, then `/plugin install claude-sop@claude-sop`. The npm CLI's `install` command then only handles the project-hook wiring and license prompt, not the plugin bundle registration. **Cleanest separation.**

2. **Write a local marketplace from the CLI** — On `npx claude-sop install`, CLI writes `~/.claude-sop/marketplace/.claude-plugin/marketplace.json` + `~/.claude-sop/marketplace/plugin/` (copied from `node_modules/claude-sop/bundle/`), then shells out `execa('claude', ['/plugin', 'marketplace', 'add', '~/.claude-sop/marketplace'])` and `execa('claude', ['/plugin', 'install', 'claude-sop@claude-sop-local'])`. **Problem: these are slash-commands, not documented CLI flags.** Needs a spike to confirm `claude` CLI accepts them non-interactively.

3. **Direct settings.json poke** — If Claude Code exposes `extraKnownMarketplaces` or similar in `~/.claude/settings.json`, the CLI could write the marketplace path there directly and tell the user to run `/plugin install` interactively. **Not confirmed to exist** in the docs we read.

### Unresolved sub-questions (planner must spike)

- **Q1:** Does `claude /plugin marketplace add <path>` work non-interactively from a child process? (Likely yes based on slash-command UX but unverified.)
- **Q2:** Is there a settings.json key for pre-registering marketplaces so the CLI doesn't need to shell out at all?
- **Q3:** If we use the `npm` plugin source type, does Claude Code auto-update on `npm publish` or does the user need `/plugin marketplace update` + `/plugin install` again?
- **Q4:** How do project-local hooks in `<project>/.claude/settings.json` interact with plugin-provided `hooks/hooks.json`? Do they stack or does one override?
- **Q5:** Can a plugin's hooks be scoped per-project, or are plugin hooks always global-to-the-plugin?

**Recommendation for planner:** Pick Path 1 (NPM-sourced marketplace entry hosted in a tiny GitHub repo). It avoids shelling into interactive slash commands entirely. The npm CLI then has a single job — project-scoped hook wiring + config/secrets + license prompt. The plugin bundle + marketplace entry is a separate artifact that gets published to GitHub.

**Sources:**
- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

**Confidence:** HIGH on schema (verified from official docs). MEDIUM-LOW on orchestration path — needs a Phase 0 spike.

---

## 3. PathResolver Details

### Git detection: `execa` not `simple-git`

- **`execa('git', ['remote', 'get-url', 'origin'])`** — 3 lines, no new dep. We already have execa for the learner path.
- **`simple-git`** — 200KB, wraps the same shellouts we'd do. Gratuitous dep.
- Handle `ENOENT` (git not installed) and non-zero exit (not a repo) as "fall through to next tier." Never throw from PathResolver on missing git — treat as "non-git project."

### Git remote URL normalization

**Handled formats:**
| Input | Canonical |
|---|---|
| `https://github.com/owner/repo.git` | `https://github.com/owner/repo` |
| `https://github.com/owner/repo` | `https://github.com/owner/repo` |
| `git@github.com:owner/repo.git` | `https://github.com/owner/repo` |
| `ssh://git@github.com/owner/repo.git` | `https://github.com/owner/repo` |
| `git+ssh://git@github.com/owner/repo.git` | `https://github.com/owner/repo` |
| `git://github.com/owner/repo.git` | `https://github.com/owner/repo` |

**Normalization algorithm (40 lines, hand-rolled):**
```ts
function normalizeRemoteUrl(raw: string): string {
  let url = raw.trim();
  // strip git+ prefix
  url = url.replace(/^git\+/, '');
  // git@host:owner/repo -> ssh://git@host/owner/repo
  const scpMatch = url.match(/^([^@]+)@([^:]+):(.+)$/);
  if (scpMatch) url = `ssh://${scpMatch[1]}@${scpMatch[2]}/${scpMatch[3]}`;
  // parse as URL
  const parsed = new URL(url);
  // force https scheme, lowercase host, strip userinfo
  const host = parsed.host.toLowerCase();
  // strip .git suffix, lowercase path
  const path = parsed.pathname.replace(/\.git$/, '').toLowerCase();
  return `https://${host}${path}`;
}
```

**Do NOT use `normalize-git-url` (npm)** — last published 2014, targets npm-internal cache dedup, not our needs.

### Atomic project.json writes

Use `fs.writeFile(tmp)` + `fs.rename(tmp, final)` pattern. POSIX rename is atomic. No `proper-lockfile` needed for project.json — it's written once at install and read-only after. For CaptureStore files (Phase 1 scope) we'll need locks.

### Move detection logic

```
on any read after install:
  stored = readJson(<project>/.claude-sop/project.json)
  current = resolveIdentity()
  if current.projectId !== stored.projectId:
    # moved — migrate <hash12> dir in global state
    migrateGlobalState(stored.projectId, current.projectId)
    writeJson(<project>/.claude-sop/project.json, current)
    emitStatus("migrated from <old> to <new>")
```

**Edge case:** a repo cloned twice at different paths will produce the same `projectId` (remote URL hashes identically). Two installs of the same repo will NOT collide — that's a feature, not a bug.

**Confidence:** HIGH.

---

## 4. Config Library with Encrypted Secrets

### Machine-id derivation

**Recommendation: `node-machine-id` package (MIT).** Wraps OS-native sources:
- macOS: `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID`
- Linux: `/var/lib/dbus/machine-id` or `/etc/machine-id`
- Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (we refuse Windows anyway)

Fallback chain if `node-machine-id` throws: hash of `os.hostname() + os.userInfo().uid + '/claude-sop-install-salt'`. Always wrap in try/catch — machine-id sources are flaky in containers and some CI.

**Alternative considered:** hand-roll the `ioreg`/`/etc/machine-id` shellouts. Rejected — `node-machine-id` is 40 lines and saves us cross-platform bug triage.

**Security note:** `node-machine-id` has no 2025 CVEs surfaced, but also no recent audit. Since we're using it only as "filesystem-inspection deterrent" (not cryptographic defense), this is acceptable.

### Encryption scheme

**No external deps. Use Node `crypto` module.**

```ts
// key derivation
const salt = /* per-install random, stored in secrets.enc header */
const machineId = await machineIdAsync();  // from node-machine-id
const key = crypto.scryptSync(machineId, salt, 32, { N: 16384, r: 8, p: 1 });

// encrypt
const iv = crypto.randomBytes(12);  // GCM standard
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

// file format (versioned for Phase 6 migration)
{
  "v": 1,                    // format version — bump for migration
  "salt": "<hex>",           // 16 bytes
  "iv": "<hex>",             // 12 bytes
  "tag": "<hex>",            // 16 bytes
  "ciphertext": "<base64>"
}
```

**Why `scrypt` not `pbkdf2`:** Scrypt is memory-hard and Node has a first-class `crypto.scryptSync` since Node 10. Parameters `N=16384, r=8, p=1` are current-era defaults, subsecond on modern machines.

**Why GCM not CBC:** AEAD (authenticated). Tamper detection is automatic — ciphertext modification throws on decrypt.

**Format versioning for Phase 6 migration:** The `v: 1` field is critical. When Phase 6 lands with the license API, we may want to rotate to a different KDF or add fields. Migration = on read, if `v === 1` we support read-only; on write, we always write the current version.

### Zod schema strategy

```ts
import { z } from 'zod';

const configSchema = z.object({
  version: z.literal(1),
  learner: z.object({
    model: z.string().default('claude-sonnet-4'),
    maxCapturesPerRun: z.number().int().positive().default(50),
  }),
  scrubber: z.object({
    entropyThreshold: z.number().min(0).max(8).default(4.5),
    rulePackPath: z.string().optional(),
  }),
  // RESERVED for Phase 6 — Config schema must accept this namespace from day one
  license: z.object({
    keyRef: z.string().optional(),       // points into secrets.enc
    trialStartedAt: z.number().optional(),
    lastValidated: z.number().optional(),
  }).strict().default({}),
}).strict();  // FAIL LOUD on unknown keys
```

**Zod `.strict()` behavior:** unknown keys cause a `ZodError` with `code: 'unrecognized_keys'`. Format the error as:
```
Config error at /learner: unknown keys [foo, bar]
  expected keys: model, maxCapturesPerRun
  file: ~/.claude-sop/config.json
```

**Zod 3.x gotchas:**
- `.strict()` does NOT propagate to nested objects — must be applied at every level explicitly.
- `.default()` runs AFTER `.strict()` validation — unknown keys at the level where `.default()` is applied still fail loud.
- For the project→global merge, do NOT use `.deepPartial()` blindly; it loses defaults. Instead: validate global with strict schema, validate project with `.partial()` on the outer object (nested still strict), then merge keyed.

**Sources:**
- [Node.js crypto docs](https://nodejs.org/api/crypto.html)
- [node-machine-id on npm](https://www.npmjs.com/package/node-machine-id)

**Confidence:** HIGH on crypto approach. MEDIUM on node-machine-id (no recent audit).

---

## 5. Scrubber Architecture

### Pipeline stages

```
capture payload
  │
  ▼
[1] Path exclusion
     - tool_input.file_path matches **/.env*, **/*.pem, **/id_rsa*, **/*secret*
     - if match: replace entire payload with [REDACTED: sensitive path]
     - short-circuit
  │
  ▼
[2] Rule-pack regex pass (layered)
     - baseline pack (shipped, from secretlint extraction)
     - user override pack (~/.claude-sop/rules/*.yaml — Phase 0 loads if present)
     - rules run in order; matches replaced with [REDACTED:<sha4>]
  │
  ▼
[3] Shannon entropy catch-all
     - tokenize on whitespace + common delimiters
     - for each token >= 20 chars: compute Shannon entropy
     - if entropy >= 4.5: replace with [REDACTED:<sha4>]
  │
  ▼
[4] Output formatter
     - sha4 = sha256(original_secret).slice(0, 4)   # 4 hex chars, NOT 4 bytes
     - redaction = `[REDACTED:${sha4}]`
     - same secret always produces same redaction (learner can dedupe)
```

### YAML rule pack format

```yaml
# baseline.yaml
version: 1
rules:
  - id: anthropic-api-key
    description: Anthropic API key
    pattern: 'sk-ant-[A-Za-z0-9_-]{20,}'
    flags: 'g'
  - id: aws-access-key-id
    description: AWS access key ID
    pattern: 'AKIA[0-9A-Z]{16}'
    flags: 'g'
  - id: github-pat
    description: GitHub personal access token
    pattern: 'gh[pousr]_[A-Za-z0-9]{36,}'
    flags: 'g'
  - id: env-assignment
    description: Environment variable assignment
    pattern: '^([A-Z_][A-Z0-9_]*)=(.+)$'
    flags: 'gm'
    replacement: '$1=[REDACTED]'  # special: keep the key name
```

### YAML parser: `yaml` (eemeli/yaml)

| | `yaml` (eemeli) | `js-yaml` |
|---|---|---|
| Weekly DL | 57M | 89M |
| Latest | 2.8.3 (active) | 4.1.1 (slower cadence) |
| YAML 1.2 | Full | 1.2 core schema |
| Streaming | Yes | No |
| CST preservation | Yes | No |
| Size | ~240KB | ~150KB |

**Recommendation: `yaml`.** Active maintenance, proper 1.2 support (our rule packs use `|` block strings), same author authored the TC39 YAML proposal. Size difference is irrelevant for a CLI tool. We also get better error messages on malformed user rule packs.

**Sources:** [npm-compare js-yaml vs yaml](https://npm-compare.com/js-yaml,yaml)

### secretlint rule extraction (DATA not RUNTIME)

**Verified reality:** secretlint rules are shipped as compiled TypeScript, not JSON. Each `@secretlint/secretlint-rule-*` package exports a module with patterns inlined in JS. Examples that exist on npm as of 2026:
- `@secretlint/secretlint-rule-preset-recommend` — MIT, 781K weekly downloads, aggregates others
- `@secretlint/secretlint-rule-pattern` — custom pattern rule (we don't need this)
- `@secretlint/secretlint-rule-npm` — npm-specific tokens
- Individual rules for AWS, GCP, GitHub, Slack, Stripe, JWT (via the preset)

**All MIT-licensed.** Good for vendoring.

**Extraction strategy:**
1. Build-time script (`scripts/extract-secretlint-rules.ts`) runs at claude-sop dev time, not at user install.
2. Script reads specific files from a pinned `@secretlint/secretlint-rule-*` commit in GitHub (we don't need it at runtime OR build-time as an npm dep — fetch raw files from a pinned SHA).
3. Script parses out the regex patterns from the source. For most rules the pattern is a single `const pattern = /.../g` literal — stable AST extraction.
4. Script emits `src/scrubber/baseline.yaml` with pattern + `source: { repo, sha, path }` metadata per rule.
5. Re-run quarterly as a dependabot-style maintenance task.
6. MIT license attribution: include a `NOTICES.md` listing each extracted pattern's upstream source.

**This means `secretlint` does NOT end up as a runtime OR build-time npm dep.** The 30MB cost cited in prior research is avoided. The "baseline corpus" is really "patterns we extracted from secretlint source."

**Alternative (simpler but heavier):** install `@secretlint/secretlint-rule-preset-recommend` as a devDependency and import its exports at build time. Size is ~5MB installed, MIT-clean. Planner's call.

**Recommendation: go simple — devDependency import at build time**, emit YAML, ship only the YAML. Best of both worlds.

**Sources:**
- [@secretlint/secretlint-rule-preset-recommend on npm](https://www.npmjs.com/package/@secretlint/secretlint-rule-preset-recommend)
- [secretlint rules on GitHub](https://github.com/secretlint/secretlint/tree/master/packages/%40secretlint/secretlint-rule-preset-recommend)

### Shannon entropy implementation

```ts
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const count of freq.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

const ENTROPY_THRESHOLD = 4.5;
const MIN_TOKEN_LEN = 20;
```

**Performance note:** this runs on every capture payload. Bench on 100KB adversarial strings. Regex catastrophic backtracking is the real risk — use non-greedy patterns and test with `re2` (just for CI, not runtime).

### Fixture corpus layout

**Recommendation: per-rule directory with input/expected pairs.**
```
test/fixtures/scrubber/
├── anthropic-api-key/
│   ├── 01-bare-key.input.txt
│   ├── 01-bare-key.expected.txt
│   ├── 02-in-json.input.txt
│   ├── 02-in-json.expected.txt
│   └── 03-in-shell-export.input.txt
├── aws-access-key-id/
├── entropy-catchall/
│   ├── 01-random-base64-blob.input.txt
│   └── 01-random-base64-blob.expected.txt
└── false-positives/
    ├── 01-git-sha.input.txt            # should NOT be redacted
    ├── 01-git-sha.expected.txt
    └── 02-lorem-ipsum.input.txt
```

**Recall measurement (automated test):**
- Load each `*.input.txt`, run through scrubber, compare to `*.expected.txt`.
- Count files where all sensitive spans were redacted → that's the numerator.
- Denominator: total files in positive fixtures (excluding `false-positives/`).
- Assert `recall >= 0.95`. Fail CI otherwise.
- Separately assert `false-positives/` directory produces zero redactions — `precision >= 0.99` in false-positive set.

**Seed corpus:** use our hand-written fixtures (~30 cases per rule) plus the detect-secrets public corpus where license-compatible. detect-secrets is Apache-2.0; we can redistribute test cases.

**Confidence:** HIGH on pipeline + YAML + entropy. MEDIUM on secretlint extraction (unverified if devDep import path works cleanly at build time).

---

## 6. Phase 6 Reservation in Phase 0 Config

**Critical design constraint from CONTEXT.md:** Phase 6 adds license validation + trial countdown + SEA binary. Phase 0 Config must accept this without schema migration later.

**Concrete reservations in the Zod schema (see §4):**
1. Top-level `license` namespace with `keyRef`, `trialStartedAt`, `lastValidated` — all optional, defaults to `{}`.
2. secrets.enc format versioning (`v: 1`) — Phase 6 can bump to v2 with additional fields without breaking v1 reads.
3. Config file `version: 1` literal — allows Phase 6 to detect pre-license configs and migrate.
4. Scrubber rule pack `version: 1` — same reasoning.

**What Phase 0 MUST NOT do:**
- Phone home for any reason (license client is Phase 6 code path).
- Import `@noble/ed25519` or any signature verification lib (Phase 6).
- Ship obfuscation build config (Phase 6 tsup rebuild).

**Phase 0 unit tests:** explicitly assert zero network calls from PathResolver, Config, Scrubber code paths. See §9 for technique.

---

## 7. Testing Strategy

### memfs for filesystem isolation

```ts
// vitest setup
import { beforeEach, vi } from 'vitest';
import { vol } from 'memfs';

vi.mock('node:fs', async () => ({ ...(await import('memfs')).fs }));
vi.mock('node:fs/promises', async () => ({ ...(await import('memfs')).fs.promises }));

beforeEach(() => vol.reset());
```

**Scrubber test pattern:** populate `vol` with fixture files, run scrubber, assert against expected files. The scrubber itself takes strings, so memfs isn't strictly needed for Scrubber — but it IS needed for the YAML rule-pack loader (it reads from `~/.claude-sop/rules/`).

**PathResolver test pattern:** mock `execa` via DI (constructor-inject a git runner). Don't mock at module level — ESM hoisting is painful. Example:
```ts
class PathResolver {
  constructor(private git: GitRunner = new RealGitRunner()) {}
}
// in tests:
new PathResolver(new FakeGitRunner({ remoteUrl: 'git@github.com:foo/bar.git' }))
```

### Zero-network assertion

**Technique: stub globals + spy on `node:http`/`node:https` at setup time.**

```ts
// test/setup/no-network.ts
import { beforeAll, afterAll, vi } from 'vitest';

beforeAll(() => {
  // 1. stub fetch
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('NETWORK ACCESS IN PHASE 0 TEST');
  }));

  // 2. intercept node:http + node:https request
  const http = require('node:http');
  const https = require('node:https');
  const orig = { hReq: http.request, hsReq: https.request };
  http.request = () => { throw new Error('NETWORK ACCESS: http.request'); };
  https.request = () => { throw new Error('NETWORK ACCESS: https.request'); };

  // 3. intercept dgram + net (low-level TCP)
  const net = require('node:net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    throw new Error('NETWORK ACCESS: net.Socket.connect');
  };
});
```

**Why not `undici` MockAgent:** known compat issue with Vitest 2.1.5+ ([vitest#6952](https://github.com/vitest-dev/vitest/issues/6952)). The global-stub approach above is fragile but works across Vitest versions.

**Per-file opt-in:** add `import './test/setup/no-network.ts'` to any test file that should prove zero egress. All Phase 0 test files should have this.

**Sources:** [Vitest mocking docs](https://vitest.dev/api/mock), [vitest issue #6952](https://github.com/vitest-dev/vitest/issues/6952)

---

## 8. CI Matrix for Phase 0

```yaml
# .github/workflows/ci.yml
strategy:
  fail-fast: false
  matrix:
    node: ['18.17', '20', '22']
    os: [ubuntu-latest, macos-latest]
    # NOTE: windows-latest explicitly excluded; we refuse Windows in v1
```

**Jobs:**
1. `lint` — tsc --noEmit, eslint, prettier check
2. `test` — vitest run (across matrix)
3. `scrubber-recall` — separate job that runs fixture corpus and asserts >=95% recall
4. `no-network-check` — runs `test/no-network-*.test.ts` subset with the global stub active, asserts zero calls
5. `engines-check` — runs `node -e "require('./package.json').engines.node === '>=18.17.0' || process.exit(1)"`
6. `windows-refusal-check` — spawn the CLI with `CLAUDE_SOP_FAKE_PLATFORM=win32` and assert exit code 1 + message "Windows not supported in v1, use WSL."

**OS-specific gotchas surfaced during research:**
- **macOS machine-id:** `ioreg -rd1 -c IOPlatformExpertDevice` works on all macOS versions ≥ 10.x. No sandbox issues.
- **Linux machine-id:** `/etc/machine-id` is systemd-installed; `/var/lib/dbus/machine-id` is the fallback. Both may be missing in stripped containers — `node-machine-id` handles this by throwing. Our fallback-to-hashed-hostname path catches it.
- **GitHub Actions runners:** both macos-latest and ubuntu-latest have `git`, `node`, and machine-id sources available. No special setup needed.

**Windows refusal implementation:**
```ts
// src/platform-check.ts
import { platform } from 'node:os';

export function assertPlatformSupported() {
  const current = process.env.CLAUDE_SOP_FAKE_PLATFORM ?? platform();
  if (current === 'win32') {
    console.error('claude-sop: Windows is not supported in v1. Use WSL.');
    process.exit(1);
  }
}
```

Call from every CLI entry AND from package-level init (but not from imports — we need this to be testable without side effects).

---

## Planner Action Items

Concrete decisions the planner must make:

1. **[Distribution]** Choose marketplace orchestration path: (a) npm-sourced marketplace entry hosted in tiny GitHub repo, (b) local marketplace written by CLI + shell to `claude /plugin`, (c) direct settings.json write. **Recommendation: (a).** Defer the tiny GitHub repo to Phase 2; Phase 0 only writes the ADR.
2. **[PathResolver]** Hand-roll normalization (40 lines). No `normalize-git-url` dep. `execa` for git detection. **Confirmed.**
3. **[Config]** Use `node-machine-id` devDep + `crypto` built-in. aes-256-gcm + scrypt. Format-versioned secrets.enc.
4. **[Config]** Zod 3.x strict schemas at every nesting level. Reserve `license` namespace in schema from day one. Error messages must list expected keys.
5. **[Scrubber]** YAML parser = `yaml` (eemeli).
6. **[Scrubber]** Rule extraction = devDep `@secretlint/secretlint-rule-preset-recommend`, extract at build time, emit `baseline.yaml`, ship only the YAML. secretlint is NOT a runtime dep.
7. **[Scrubber]** Pipeline = path exclusion → rule-pack regex → entropy catch-all → `[REDACTED:<sha4>]` formatter. sha4 = first 4 hex chars of SHA-256.
8. **[Scrubber]** Fixture corpus = per-rule subdirs with `*.input.txt` + `*.expected.txt` pairs. Include `false-positives/` dir. Recall gate: ≥95% on positive fixtures; zero redactions on false-positive fixtures.
9. **[Testing]** memfs for filesystem tests. DI for `execa`. Global-stub zero-network setup (NOT undici MockAgent).
10. **[CI]** Node 18.17 / 20 / 22 × macOS / Linux. Windows job omitted. Separate jobs for scrubber-recall, no-network-check, engines-check, windows-refusal-check.
11. **[Discipline]** Every Phase 0 code path must pass the zero-network assertion. License + phone-home code lives in Phase 6 or does not exist yet.
12. **[Docs]** Write `ADR-0001-distribution-model.md` as first deliverable using MADR 4.0 minimal template.
13. **[Docs]** Write `NOTICES.md` with MIT attribution for any extracted secretlint patterns.

### Suggested Phase 0 task decomposition (build order)

```
T0: Scaffold package (package.json with engines + no postinstall, tsup config, vitest config, test/setup/no-network.ts)
T1: ADR-0001-distribution-model.md
T2: platform-check.ts (Windows refusal)
T3: PathResolver
    T3a: normalizeRemoteUrl + unit tests
    T3b: git detection (DI'd GitRunner) + tests
    T3c: identity hierarchy + sha256[:12] hash + tests
    T3d: project.json atomic I/O + move detection + tests
T4: Config
    T4a: Zod schemas (global + project + license reservation) + tests
    T4b: merge logic + fail-loud unknown-key errors + tests
    T4c: secrets.enc format v1 (aes-256-gcm + scrypt) + tests
    T4d: machine-id wrapper with fallback + tests
T5: Scrubber
    T5a: YAML rule-pack loader + schema + tests
    T5b: devDep build script: extract secretlint patterns → baseline.yaml
    T5c: Path exclusion stage + tests
    T5d: Regex pipeline stage + tests
    T5e: Shannon entropy catch-all + tests
    T5f: Redaction formatter ([REDACTED:sha4]) + tests
    T5g: Fixture corpus (~30 per rule + false-positives)
    T5h: Recall gate test (≥95%) + CI job
T6: CI matrix wiring
T7: Phase 0 smoke — end-to-end: create a fake project, init config + secrets, scrub a fixture payload, assert no network was hit
```

---

## Open Risks

1. **Marketplace orchestration spike.** Until we verify whether (a) the `npm` plugin source type updates automatically, (b) a JSON settings key can pre-register marketplaces, or (c) `claude /plugin marketplace add` works from a child process — we can't fully lock the install flow. **Mitigation:** Phase 0 only writes the ADR with Open Questions listed; Phase 2 (installer) does the spike.
2. **secretlint rule extraction fragility.** If an upstream rule package refactors from `const pattern = /.../g` to a different export shape, our build-time extractor breaks silently. **Mitigation:** pin the devDep version, run recall tests as the gate, update extractor in a Phase 0.x maintenance task.
3. **node-machine-id opacity.** No 2025 audit surfaced. The package is small enough to audit ourselves (~200 LOC). **Mitigation:** read the source before committing; include a `NOTICES.md` entry; fall back to hashed-hostname if it throws.
4. **Entropy threshold 4.5 false-positive risk on real captures.** git SHAs (entropy ~4.0), uuids (~3.9), base64 lorem (~5.0). Most git SHAs are under 4.0 so safe; uuids are marginal. **Mitigation:** add uuid and git-sha to the `false-positives/` fixture dir; if they redact, add explicit skip patterns to baseline.yaml.
5. **Zod strict + merge is verbose.** Deep merge with strict-at-every-level schemas is finicky. **Mitigation:** use a tiny custom merge (no `deepmerge` dep) that validates the result with the outer strict schema after merging.
6. **Vitest no-network stub bypasses:** a creative user could `require('node:dns').lookup()` + raw TCP. Our stub doesn't cover `dgram` or DNS. **Mitigation:** add `dns.lookup` and `dns.resolve` stubs as well; accept that determined circumvention is possible and focus on catching accidents.
7. **CLAUDE_PROJECT_DIR vs project-local hooks interaction** — Phase 0 doesn't wire hooks but the ADR needs to mention this is a Phase 2 concern.

---

## Sources

**HIGH confidence (primary):**
- [Claude Code — Create plugins](https://code.claude.com/docs/en/plugins) — plugin.json schema, directory structure, hooks.json location
- [Claude Code — Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) — marketplace.json schema, plugin source types including npm source
- [MADR 4.0 template](https://github.com/adr/madr/tree/4.0.0/template) — ADR format
- [Node.js crypto docs](https://nodejs.org/api/crypto.html) — aes-256-gcm, scrypt
- [@secretlint/secretlint-rule-preset-recommend on npm](https://www.npmjs.com/package/@secretlint/secretlint-rule-preset-recommend) — MIT license verified
- [Vitest mocking API](https://vitest.dev/api/mock)

**MEDIUM confidence:**
- [MADR project](https://adr.github.io/madr/)
- [npm-compare: js-yaml vs yaml](https://npm-compare.com/js-yaml,yaml)
- [Vitest issue #6952 — undici MockAgent compat](https://github.com/vitest-dev/vitest/issues/6952)
- [eemeli/yaml performance discussion](https://github.com/eemeli/yaml/discussions/358)
- [secretlint rule preset on GitHub](https://github.com/secretlint/secretlint/tree/master/packages/%40secretlint/secretlint-rule-preset-recommend)

**LOW confidence (flagged for validation):**
- node-machine-id current security posture — no recent audit surfaced
- Exact behavior of `claude /plugin marketplace add` from a non-interactive child process — needs spike
- Whether `settings.json` has a hidden `extraKnownMarketplaces` key — not documented

---

## Confidence Breakdown

| Area | Level | Reason |
|---|---|---|
| ADR template choice | HIGH | MADR 4.0 is the current standard, template verified |
| Plugin/marketplace schema | HIGH | Verified from official Claude Code docs 2026-04-13 |
| Marketplace orchestration path | MEDIUM-LOW | Three viable paths, needs spike to confirm |
| PathResolver normalization | HIGH | Hand-rolled algorithm, all edge cases enumerated |
| Config encryption scheme | HIGH | Node built-in crypto, standard AEAD pattern |
| Machine-id lib | MEDIUM | node-machine-id is OS-native wrapper but no recent audit |
| Zod 3.x strict merge | MEDIUM | Known API, some gotchas around `.strict()` not propagating |
| Scrubber pipeline | HIGH | Layered approach is industry standard |
| YAML parser pick | HIGH | Active maintenance + 1.2 support wins |
| secretlint extraction path | MEDIUM | Two viable sub-paths (devDep vs raw-fetch), devDep recommended |
| Zero-network assertion | MEDIUM | Global stub is fragile but portable |
| CI matrix | HIGH | Standard GHA pattern |

**Research date:** 2026-04-13
**Valid until:** 2026-05-13 (30 days — Claude Code docs are semi-stable, secretlint updates quarterly)

---

## RESEARCH COMPLETE
