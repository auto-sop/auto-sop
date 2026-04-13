# Phase 2: Installer + Scheduler + CLI Skeleton — Research

**Researched:** 2026-04-13
**Domain:** Claude Code plugin installation orchestration, macOS launchd, Linux systemd user timers, cron fallback, commander.js CLI, atomic settings.json merge, encrypted license storage
**Confidence:** HIGH for Claude Code plugin mechanics, launchd, systemd, commander, atomic rewrites; MEDIUM for cron fallback edge cases and upgrade-semantics in `npm` plugin source type.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**G — Installer**
- **G1 — Plugin bundle placement strategy: PLANNER DECIDES based on ADR research.** Phase 0 ADR flagged this as an open question. The Phase 2 planner MUST spend the first research step resolving this concretely — likely by reading current Claude Code plugin docs. Acceptable outcomes: (a) plugin bundle lives under `~/.claude/plugins/claude-sop/` copied by our installer; (b) plugin bundle lives inside the npm package itself and settings.json points to it by absolute path. Planner must commit to one path before writing tasks.
- **G2 — Hook merge strategy: merge with order preservation.** Installer appends claude-sop's hook entries AFTER any existing user hooks, never reorders/deletes user hooks, and detects its own entries by a stable `"id": "claude-sop"` marker to make re-install idempotent.
- **G3 — Upgrade behavior: version-compare.** Newer package version → in-place upgrade (hooks re-emitted, scheduler re-written, `secrets.enc` migrated if schema changed, managed-section markers left alone). Same version = no-op. Older version = refuse with error.
- **G4 — License key prompt UX: interactive prompt with test key `123`.** `install` prompts via stdin. Validated against Phase 6 format (for now: any non-empty string, with `123` explicitly accepted as dev mode). Stored encrypted via Phase 0 Config `secrets.enc`. `--license <key>` flag for CI. Real validation is Phase 6.

**H — Scheduler**
- **H1 — Unit file locations: standard OS conventions.**
  - macOS: `~/Library/LaunchAgents/com.claude-sop.learner.plist`, `launchctl bootstrap gui/$UID` + `launchctl enable`.
  - Linux: `~/.config/systemd/user/claude-sop-learner.timer` + `.service`, `systemctl --user enable --now`, `loginctl enable-linger $USER`.
- **H2 — Entry point: shell wrapper script `~/.claude-sop/bin/tick.sh`.** Sources minimal env, sets `CLAUDE_SOP_LEARNER=1`, acquires per-project lock, invokes learner binary with absolute path. Rewritten on each `install`.
- **H3 — Cron fallback on Linux without systemd-user: install anyway with warning.** If `systemctl --user` unavailable, append to user crontab via `crontab -l | { cat; echo '<entry>'; } | crontab -` with yellow warning. Install does NOT abort.
- **H4 — Concurrency: per-project flock, not global.** Lock at `/tmp/claude-sop-<hash12>.lock`. Failure logs "previous tick still running" to errors.jsonl and exits 0.

**I — CLI Surface**
- **I1 — Flat verbs:** `install`, `status`, `doctor`, `pause`, `resume`, `purge`, `uninstall`, `errors`. No nested verbs.
- **I2 — Output: human default + `--json` flag** on every command. Colorized table via minimal ANSI helper (picocolors).
- **I3 — `status` base fields:** project id/slug/path; hook wiring state; scheduler state + last-tick-time; last learner run + exit; pending capture count; directive count; license state (trial N days / paid / expired / dev-key); 24h error count; disk usage vs cap.
- **I4 — Exit codes:** `0` success, `1` generic failure, `2` misuse (commander default), `3` precondition failed.

**J — Uninstall**
- **J1 — Default preserves captures; `--purge` wipes everything.**
- **J2 — Managed section: backup before deletion** to `~/.claude/sop/<hash12>/managed-history/uninstall-<ts>.md`. CLAUDE.md atomic rewrite.
- **J3 — Best-effort with summary.** Continue on step failure; summary at end; exit `0` on zero failures, `1` otherwise.
- **J4 — Secrets on uninstall: delete `secrets.enc`** (both default and `--purge`).

### Claude's Discretion
- Exact `settings.json` merge algorithm (jsonc-parser vs strict JSON — planner decides)
- commander@14 CLI framework (already locked)
- Color helper: `picocolors` (zero-dep)
- launchd plist / systemd unit templates (planner writes from scratch)
- `doctor` check list expansion beyond spec minimum

### Deferred Ideas (OUT OF SCOPE)
- `recent` and `show` inspection verbs — Phase 5
- License validation against real backend — Phase 6
- Ed25519 signature verification — Phase 6
- Node SEA binary build — Phase 5/6
- Windows support — never (v1)
- Service-level uninstall mid-tick — rejected; H4 flock handles it
- Multi-project scheduler sharing — rejected; each install registers its own project
</user_constraints>

## Summary

Phase 2 wires three OS integration layers (Claude Code plugin/hooks, hourly scheduler, CLI control plane) on top of Phase 0 foundations. All three are well-trodden ground — Claude Code publishes formal plugin/marketplace/hooks specs, launchd and systemd are decades-mature, and commander@14 is already in `package.json`. The only remaining architectural question from the ADR (**G1 plugin bundle location**) is answered definitively below: **ship the plugin bundle inside the npm package, register it via `extraKnownMarketplaces` settings.json key pointing at a local directory source, and let Claude Code copy it into its own `~/.claude/plugins/cache/` on first launch.** This is non-interactive, declarative, idempotent, zero-network, and works identically under Phase 6's SEA binary.

The most important subtlety for the planner: **Claude Code's plugin hooks and project-local `<project>/.claude/settings.json` hooks coexist and both fire**. We do NOT need to choose between them. The plugin bundle ships hook metadata (for marketplace consumers who install via `/plugin install`), AND the `npx claude-sop install` CLI writes the same hook commands directly into `<project>/.claude/settings.json` (for the primary npm install path). Both point at the same shim binary, via the same absolute path, baked in at install time.

**Primary recommendation:** Commit to the hybrid-with-declarative-marketplace pattern. Use `${CLAUDE_PLUGIN_ROOT}` inside the plugin bundle's own `hooks/hooks.json`, and absolute paths (derived from `PathResolver`) inside the project-local `.claude/settings.json` merge. Hourly tick runs via launchd on macOS / systemd user timer on Linux / crontab fallback, all calling `~/.claude-sop/bin/tick.sh` which internally uses `proper-lockfile` (Node-level, already a Phase 0 dep) to enforce per-project concurrency — avoiding macOS's missing `flock(1)`.

## G1 Decision — Plugin Bundle Location (RESOLVED)

**Committed answer:** **Option A+ — plugin bundle ships INSIDE the npm package at `dist/plugin/`, and the installer registers it with Claude Code via `extraKnownMarketplaces` in `~/.claude/settings.json` pointing at a copied directory under `~/.claude-sop/marketplace/`.**

### Rationale

Three facts resolve this:

1. **`extraKnownMarketplaces` is a settings.json key** (Claude Code plugin-marketplaces docs, confirmed 2026-04). It allows pre-registering a marketplace source declaratively — no need to shell out to `claude plugin marketplace add`. This means the installer can register the marketplace with a simple JSON file mutation, fully non-interactive.

2. **Marketplace sources support local `directory` and `file` types**, not just git/npm. A local directory source works perfectly for a bundle that's been copied from the npm package into a stable claude-sop-owned location.

3. **Claude Code copies plugins into its own versioned cache** at `~/.claude/plugins/cache/` on install. This cache is Claude Code's territory — we do NOT write there directly. We write to `~/.claude-sop/marketplace/claude-sop/` and let Claude Code copy from there.

### Why not Option B (settings.json points at `node_modules/claude-sop/plugin/` by absolute path)

- `npx` uses a cache directory that can move or be GC'd between invocations. Absolute paths into `_npx/<hash>/node_modules/claude-sop/` are fragile.
- When the user runs `npm install -g claude-sop` later, the path changes again.
- Claude Code's plugin-cache model EXPECTS plugins to be copied into its cache; referencing them in-place from node_modules violates the lifecycle Claude Code expects.

### Why not Option C (marketplace-sideload via public GitHub `marketplace.json`)

- Requires network on install. Violates zero-network test mandate and cold-install ergonomics.
- Makes upgrade semantics depend on the marketplace's publish cadence rather than `npm publish`.
- The ADR's long-term plan DOES include a GitHub-hosted `marketplace.json` for marketplace discoverability, but that is a SECONDARY distribution channel for `/plugin install`-style users. Phase 2's primary path is `npx claude-sop install`, which must work fully offline after the initial `npm download`.

### Concrete layout

```
# Inside the published npm package
node_modules/claude-sop/
├── dist/
│   ├── cli.cjs                      # commander CLI entry
│   ├── capture/
│   │   ├── shim.cjs                 # Phase 1 hook shim
│   │   └── writer.cjs               # Phase 1 detached writer
│   └── plugin/                      # <— THE PLUGIN BUNDLE
│       ├── .claude-plugin/
│       │   └── plugin.json          # name, version, description
│       ├── hooks/
│       │   └── hooks.json           # uses ${CLAUDE_PLUGIN_ROOT}
│       └── marketplace/
│           └── marketplace.json     # local-directory marketplace catalog

# After `npx claude-sop install` runs
~/.claude-sop/
├── marketplace/
│   └── claude-sop/                  # copied from dist/plugin/
│       ├── .claude-plugin/plugin.json
│       ├── hooks/hooks.json
│       └── marketplace.json
├── bin/
│   └── tick.sh                      # hourly wrapper
├── config.json                      # Phase 0
├── secrets.enc                      # Phase 0 + trial timestamp
└── version.txt                      # installed version for G3

~/.claude/settings.json               # declaratively registered via extraKnownMarketplaces
<project>/.claude/settings.json       # hooks merged in with id: "claude-sop"
<project>/.claude-sop/project.json    # Phase 0 anchor
<project>/CLAUDE.md                   # managed-section markers added
```

The bundle is plain files; copying it is `fs.cp(..., {recursive: true})`. No subprocess, no shell, no network. Idempotent because the copy is destructive-but-deterministic (rimraf + copy, same content every time for a given version).

### Upgrade behavior (G3)

On re-run:
1. Read `~/.claude-sop/version.txt`.
2. Compare to `require('./package.json').version` of the currently running `npx` invocation (`semver.compare`).
3. **Same** → no-op (print "already installed vX.Y.Z"); exit 0.
4. **Newer package** → delete `~/.claude-sop/marketplace/claude-sop/`, re-copy `dist/plugin/`, re-merge hooks, rewrite tick.sh + scheduler unit, update `version.txt`.
5. **Older package** → refuse with error + exit 3.

Because Claude Code caches plugins in `~/.claude/plugins/cache/` by version (per docs), bumping `plugin.json`'s `version` on `npm publish` naturally invalidates the cache on next Claude Code startup and re-copies from our marketplace source. We do NOT manipulate `~/.claude/plugins/cache/` directly.

**Confidence: HIGH** for the mechanism (extraKnownMarketplaces, local directory source, `${CLAUDE_PLUGIN_ROOT}` all verified in current official docs). **MEDIUM** on the exact cache-invalidation timing of a plugin.json version bump — safe to verify with a one-shot probe in the first planned task, but the failure mode is gracefully degradable (worst case: user runs `/plugin update` manually, which docs confirm works).

## Standard Stack

### Core (already in package.json)

| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| commander | ^14 | CLI framework | Industry default; already locked in stack |
| execa | ^9 | Subprocess invocation (launchctl, systemctl, crontab) | Promise-based, safer than child_process |
| zod | ^3 | Runtime schema validation (settings.json parse, license shape) | Already in stack from Phase 0 |
| proper-lockfile | ^4 | Per-project advisory locking in tick.sh wrapper flow | Cross-platform (works on macOS where `flock(1)` does not); already in deps |
| yaml | ^2.8 | If needed for CLAUDE.md frontmatter inspection | Already in deps |
| node-machine-id | ^1 | Derives machine-bound key for secrets.enc (Phase 0 uses it) | Already in deps |
| nanoid | ^5 | Trial-session id, unique install marker | Already in deps |

### Supporting (NEW deps to consider)

| Library | Version | Purpose | Justification |
|---|---|---|---|
| picocolors | ^1.1 | ANSI colors for human CLI output | Zero-dep (<1KB); listed in Claude's Discretion; don't hand-roll color codes |
| jsonc-parser | ^3.3 | Parse `<project>/.claude/settings.json` preserving comments and key order | Claude Code settings.json is *technically* strict JSON per json-schema, but users commonly add JSONC comments; VS Code / Claude Code tolerate JSONC. Microsoft's jsonc-parser is the standard. |
| semver | ^7 | G3 version comparison | Bulletproof version compare; `npm` already ships it transitively but declare explicitly |

### NOT needed

| Don't add | Why |
|---|---|
| inquirer / prompts | `install` only needs ONE prompt (license key). Use `node:readline` built-in. |
| chalk | picocolors is smaller and does the same thing. |
| fs-extra | Node ≥18.17 has `fs.cp({recursive: true})` and `fs.rm({recursive: true})` built-in. |
| ini, dotenv | No INI/ENV parsing in Phase 2. |

**Installation:**

```bash
npm install picocolors jsonc-parser semver
```

## Architecture Patterns

### Recommended module structure

```
src/
├── cli/
│   ├── index.ts                    # commander root, registers verbs, sets exit codes
│   ├── verbs/
│   │   ├── install.ts              # orchestrates Steps A–H below
│   │   ├── uninstall.ts            # J1–J4
│   │   ├── status.ts               # I3 fields → human table or --json
│   │   ├── doctor.ts               # check list, exit 3 on precondition fail
│   │   ├── pause.ts                # writes paused.flag (Phase 1 F3)
│   │   ├── resume.ts               # removes paused.flag
│   │   ├── purge.ts                # destructive capture wipe
│   │   └── errors.ts               # tails errors.jsonl (Phase 1 F2)
│   ├── output/
│   │   ├── human.ts                # picocolors-based table renderer
│   │   ├── json.ts                 # stable JSON schema for --json
│   │   └── exit-codes.ts           # 0/1/2/3 constants
│   └── prompt.ts                   # readline-based license prompt (G4)
├── installer/
│   ├── merge-settings.ts           # jsonc-parser-based settings.json merge (G2)
│   ├── plugin-bundle.ts            # copy dist/plugin/ → ~/.claude-sop/marketplace/
│   ├── marketplace-register.ts     # mutate ~/.claude/settings.json extraKnownMarketplaces
│   ├── managed-section.ts          # create empty <!-- claude-sop:begin --> markers
│   ├── gitignore.ts                # ensure .claude-sop/ in project .gitignore
│   ├── license.ts                  # prompt + write to secrets.enc + trial timestamp
│   ├── version.ts                  # read/write ~/.claude-sop/version.txt, semver compare (G3)
│   └── idempotency.ts              # detect partial-install, re-merge deterministically
├── scheduler/
│   ├── index.ts                    # platform dispatch: macOS | linux-systemd | linux-cron
│   ├── macos-launchd.ts            # plist render + launchctl bootstrap
│   ├── linux-systemd.ts            # .timer + .service render + systemctl --user enable
│   ├── linux-cron.ts               # crontab fallback
│   ├── tick-wrapper.ts             # render ~/.claude-sop/bin/tick.sh
│   └── detect.ts                   # probe systemctl --user, decide linux path
└── atomic/
    └── write.ts                    # writeFileAtomic(path, buf): tmp + rename
```

### Pattern 1: `install` orchestration (idempotent multi-step)

**What:** Single `install` command runs 8 ordered steps; each step is individually idempotent; if any step fails, earlier steps are NOT rolled back (they'd be redundant on retry — the next `install` is itself the recovery).

**When to use:** Any install command that touches multiple locations. Gives users "run it twice and it fixes itself" semantics.

**Steps (exact order, critical):**

```ts
// src/cli/verbs/install.ts (sketch)
async function install(opts: InstallOpts) {
  // Step 1: Platform + env preconditions
  await assertPlatformSupported();                    // INST-08: macOS or Linux only
  await assertNodeVersion('>=18.17');
  const paths = PathResolver.resolve(opts.project);   // Phase 0

  // Step 2: Version compare / upgrade branch (G3)
  const installedVersion = await readVersion();       // from ~/.claude-sop/version.txt
  const packageVersion = readPackageJson().version;
  const verdict = compareVersions(installedVersion, packageVersion);
  if (verdict === 'older-package') throw new PreconditionError(3, '...');
  if (verdict === 'same') log.info('already installed');
  // 'newer' falls through to re-run all steps

  // Step 3: License prompt (G4) — only if secrets.enc missing or --license provided
  const license = await resolveLicense(opts);         // prompt or flag
  await writeSecretsEnc({ license, trialStart: Date.now() });  // Phase 0 helper

  // Step 4: Plugin bundle copy → marketplace/
  await copyPluginBundle(paths.pluginBundleSrc, paths.pluginBundleDst);

  // Step 5: Claude Code marketplace registration (declarative)
  await mergeSettingsJson(
    paths.globalClaudeSettings,
    { extraKnownMarketplaces: { 'claude-sop': { source: { source: 'directory', path: paths.pluginBundleDst }}}}
  );

  // Step 6: Project-local hook wiring (G2)
  await mergeProjectHooks(paths.projectClaudeSettings, hookEntries(paths));

  // Step 7: Scheduler registration
  await scheduler.install({ tickScript: paths.tickScript, intervalSec: 3600 });

  // Step 8: Managed section + gitignore
  await ensureManagedSection(paths.claudeMd);
  await ensureGitignore(paths.projectGitignore, '.claude-sop/');

  // Step 9: Finalize
  await writeVersion(packageVersion);                 // stamps version.txt last — if we crash before this, re-run fixes it
}
```

**Critical ordering rule:** `writeVersion()` is the LAST step. If anything before it fails, the next `install` sees "not yet at target version" and re-runs everything. This is the idempotency insurance policy.

### Pattern 2: Atomic settings.json merge with `jsonc-parser`

**What:** Use Microsoft's `jsonc-parser` edit API to merge hook entries without reformatting or reordering the user's existing JSON.

**When to use:** Every write to `<project>/.claude/settings.json` and `~/.claude/settings.json`.

**Example:**

```ts
// src/installer/merge-settings.ts (sketch)
import { parse, modify, applyEdits } from 'jsonc-parser';
import { writeFileAtomic } from '../atomic/write.js';

export async function mergeProjectHooks(settingsPath: string, entries: HookEntry[]) {
  const original = await fs.readFile(settingsPath, 'utf8').catch(() => '{}');
  const parsed = parse(original, [], { allowTrailingComma: true });

  // Existing hooks from other sources: preserve
  const existingHooks = parsed?.hooks ?? {};
  // Strip any prior claude-sop entries (detected by id field)
  const cleaned = stripById(existingHooks, 'claude-sop');
  // Append our entries last per G2
  const merged = appendById(cleaned, entries, 'claude-sop');

  // Use jsonc-parser.modify so we only touch the .hooks key
  const edits = modify(original, ['hooks'], merged, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const next = applyEdits(original, edits);

  await writeFileAtomic(settingsPath, next);
}
```

Key points: (a) parse with `allowTrailingComma` because Claude Code tolerates JSONC; (b) use `modify` so comments and unrelated keys are untouched; (c) always route through `writeFileAtomic` (temp + rename).

### Pattern 3: Platform-dispatched scheduler

**What:** `scheduler/index.ts` exports one interface; implementation picked at runtime by `process.platform` + probe.

```ts
// src/scheduler/index.ts
export interface SchedulerBackend {
  install(opts: InstallOpts): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<SchedulerStatus>;
}

export async function pickBackend(): Promise<SchedulerBackend> {
  if (process.platform === 'darwin') return macosLaunchd;
  // Linux: probe for systemd --user
  if (await detect.systemdUserAvailable()) return linuxSystemd;
  log.warn('systemd --user unavailable; using cron fallback (H3)');
  return linuxCron;
}
```

### Pattern 4: Lock in Node, not shell

**What:** Don't try to do `flock -n /tmp/foo.lock -- ...` inside `tick.sh` because `flock(1)` is absent on stock macOS. Instead, have `tick.sh` exec Node directly; Node takes the lock via `proper-lockfile`.

```bash
# ~/.claude-sop/bin/tick.sh renders to this (macOS + Linux, POSIX sh):
#!/bin/sh
set -eu
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export CLAUDE_SOP_LEARNER=1
exec "/absolute/path/to/node" "/Users/<user>/.claude-sop/marketplace/claude-sop/learner.cjs"
# Locking is done inside learner.cjs via proper-lockfile, NOT in shell
```

```ts
// Inside learner.cjs entry point
import lockfile from 'proper-lockfile';
const lockPath = `/tmp/claude-sop-${projectHash12}.lock`;
try {
  const release = await lockfile.lock(lockPath, { realpath: false, stale: 5 * 60 * 1000 });
  try { await runLearner(); } finally { await release(); }
} catch (e: any) {
  if (e.code === 'ELOCKED') {
    appendErrorsJsonl({ kind: 'tick-skipped', reason: 'previous tick still running' });
    process.exit(0); // H4: exit 0, not error
  }
  throw e;
}
```

### Anti-patterns to avoid

- **Writing to `~/.claude/plugins/cache/` directly.** That is Claude Code's managed cache. Write to `~/.claude-sop/marketplace/` and let Claude Code copy from there.
- **Trying to run `claude plugin install claude-sop@claude-sop` from execa during `npx claude-sop install`.** Non-interactive plugin install is documented (`claude plugin install`), but it requires Claude Code to be installed and in PATH. We might not have that guarantee at `npx claude-sop install` time. The `extraKnownMarketplaces` + `enabledPlugins` declarative route does not require Claude Code to be invoked at all — next Claude Code launch picks it up.
- **Using `fs.writeFile` without atomic rename on settings.json.** A Ctrl-C mid-write corrupts the user's file. Always: write to `.tmp-<nanoid>`, `fsync`, `rename`.
- **Hand-rolling a JSONC parser.** `jsonc-parser` is Microsoft's reference impl, used by VS Code.
- **Using `child_process.exec` for launchctl/systemctl/crontab.** Use `execa` — proper argv escaping, stdout/stderr capture, timeout support.
- **Baking relative paths into launchd plists.** launchd requires absolute paths. Use `PathResolver` output.
- **Depending on `$HOME` in launchd plists.** launchd sanitizes env; plists should embed the resolved path or use `UserName` + `EnvironmentVariables`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| JSONC parse/edit | Custom tokenizer | `jsonc-parser` | Comments, trailing commas, edit-preserving APIs, VS Code-grade |
| ANSI colors | Raw `\x1b[...` codes | `picocolors` | 1KB, supports NO_COLOR, handles tty detection |
| Semver compare | String split on `.` | `semver` | Pre-release, build metadata, range operators |
| Advisory locks | `flock(1)` subprocess | `proper-lockfile` | Works on macOS (no flock); handles stale locks |
| Atomic file write | `fs.writeFile` | Temp + `fsync` + `rename` | Crash-safety; rename is atomic on same FS |
| Launchd plist rendering | String templating | XML template literal with escape helper | Plists are strict XML; embed properly-escaped values |
| Systemd unit parsing | Homegrown INI | Just render — never parse user units | We own our unit filename; user units at different paths |
| Cron line editing | Regex-on-`crontab -l` | Line-marker pattern `# BEGIN claude-sop ... # END claude-sop` | Idempotent strip + append |
| Interactive prompt | inquirer | `node:readline` | One prompt in entire phase; avoid 200KB dep |
| Machine ID for key derivation | `/etc/machine-id` read | `node-machine-id` (Phase 0 already uses it) | Cross-platform, already in deps |

## Templates — Verbatim for Planner

### macOS launchd plist (`~/Library/LaunchAgents/com.claude-sop.learner.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-sop.learner</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/Users/{{USER}}/.claude-sop/bin/tick.sh</string>
  </array>

  <key>StartInterval</key>
  <integer>3600</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>/Users/{{USER}}/.claude-sop/logs/launchd.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/{{USER}}/.claude-sop/logs/launchd.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>CLAUDE_SOP_LEARNER</key>
    <string>1</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
```

**Load commands (execa):**

```ts
await execa('launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath]);
await execa('launchctl', ['enable', `gui/${process.getuid!()}/com.claude-sop.learner`]);
```

**Unload (J3 uninstall):**

```ts
// best-effort: ignore "not loaded" errors
await execa('launchctl', ['bootout', `gui/${process.getuid!()}/com.claude-sop.learner`], { reject: false });
```

**Caveats verified in research:**
- `gui/<uid>` domain runs only when user is logged in at the GUI. This is correct for a dev tool. If we wanted no-login execution we'd use `user/<uid>` — but launchd user domain has fewer guarantees for interactive paths, and `StandardOutPath` permissions get messy. Stick with `gui/`.
- `StartInterval: 3600` fires every hour of wall-clock uptime, NOT on the hour. If missed during sleep, launchd fires once on wake (verified behavior). This matches our "hourly cadence, not wall-clock-aligned" requirement.
- `RunAtLoad: false` — do NOT fire immediately on install. First tick fires after the first interval. This avoids a surprise CPU blip on `npx claude-sop install`.
- `ProcessType: Background` hints launchd that throttling + IO nice levels should be aggressive.

### Linux systemd user units

`~/.config/systemd/user/claude-sop-learner.service`:

```ini
[Unit]
Description=claude-sop hourly learner
After=default.target

[Service]
Type=oneshot
Environment=CLAUDE_SOP_LEARNER=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/home/{{USER}}/.claude-sop/bin/tick.sh
StandardOutput=append:/home/{{USER}}/.claude-sop/logs/systemd.out.log
StandardError=append:/home/{{USER}}/.claude-sop/logs/systemd.err.log
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=6
```

`~/.config/systemd/user/claude-sop-learner.timer`:

```ini
[Unit]
Description=claude-sop hourly learner timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
AccuracySec=1min
Persistent=true
Unit=claude-sop-learner.service

[Install]
WantedBy=timers.target
```

**Install commands (execa):**

```ts
await execa('systemctl', ['--user', 'daemon-reload']);
await execa('systemctl', ['--user', 'enable', '--now', 'claude-sop-learner.timer']);
// Linger so timer runs when user is logged out
await execa('loginctl', ['enable-linger', process.env.USER!], { reject: false });
```

**Uninstall (J3 best-effort):**

```ts
await execa('systemctl', ['--user', 'disable', '--now', 'claude-sop-learner.timer'], { reject: false });
await fs.rm(timerPath, { force: true });
await fs.rm(servicePath, { force: true });
await execa('systemctl', ['--user', 'daemon-reload'], { reject: false });
```

**Caveats verified in research:**
- `Persistent=true` + `OnUnitActiveSec=1h` — systemd docs note a known limitation: "information needed to properly trigger OnUnitActiveSec= timers (the last time the unit was activated) can be lost over a reboot" (systemd issue #3570). For hourly cadence, the practical impact is minimal — worst case a single tick fires slightly early after reboot. Acceptable.
- `OnBootSec=5min` gives the system time to settle before the first tick after boot.
- `loginctl enable-linger` is required for the timer to run when the user is not logged in — critical for desktop users who log out overnight. Call with `{ reject: false }` since some distros / container environments don't have `loginctl`.
- `Type=oneshot` tells systemd this is a short-running script, not a daemon; no restart loops.

### Cron fallback (H3)

Detection: `execa('systemctl', ['--user', 'status'], { reject: false })` — if exit code is non-zero and stderr contains "Failed to connect to bus" or similar, systemd-user is unavailable.

**Crontab append (idempotent via markers):**

```ts
const existing = (await execa('crontab', ['-l'], { reject: false })).stdout || '';
const stripped = existing
  .split('\n')
  .filter(l => !l.includes('# claude-sop:managed'))
  .join('\n');
const entry = `0 * * * * /home/${user}/.claude-sop/bin/tick.sh # claude-sop:managed`;
const next = (stripped.trimEnd() + '\n' + entry + '\n').replace(/\n\n+/g, '\n');
await execa('crontab', ['-'], { input: next });
```

**Uninstall:** strip lines containing `# claude-sop:managed`, rewrite.

**Yellow warning text (literal):**

```
warning: systemd --user is unavailable on this system. claude-sop installed
         an hourly cron entry as a fallback. Reboot-persistence depends on
         your distribution's cron daemon configuration. For best reliability,
         enable systemd --user or use a system with lingering support.
```

### `~/.claude-sop/bin/tick.sh` (H2)

```sh
#!/bin/sh
# claude-sop hourly tick wrapper — generated by `npx claude-sop install`
# Do not edit; regenerated on every re-install.

set -eu

# Minimal, deterministic env
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export HOME="{{HOME}}"
export CLAUDE_SOP_LEARNER=1

# Absolute paths baked in at install time
NODE_BIN="{{NODE_BIN}}"
LEARNER_JS="{{LEARNER_JS}}"
ERRORS_LOG="{{HOME}}/.claude-sop/logs/tick.err.log"

mkdir -p "$(dirname "$ERRORS_LOG")"

# Locking is done INSIDE the learner via proper-lockfile (macOS has no flock(1)).
exec "$NODE_BIN" "$LEARNER_JS" 2>>"$ERRORS_LOG"
```

`{{NODE_BIN}}` is resolved at install time via `process.execPath` (the Node that ran `npx claude-sop install`). If the user's shell has `nvm` switching Node versions, the frozen absolute path at install time is intentional — the scheduler keeps running the Node that was current when they installed. Upgrade re-runs pick up the new Node.

### `<project>/.claude/settings.json` hook merge (G2)

Claude Code hook schema, verified against current docs:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/<user>/.claude-sop/marketplace/claude-sop/shim.cjs",
            "timeout": 10,
            "id": "claude-sop"
          }
        ]
      }
    ],
    "Stop": [ /* identical shape, same id */ ],
    "SubagentStop": [ /* ... */ ],
    "PreToolUse": [ /* ... */ ],
    "PostToolUse": [ /* ... */ ]
  }
}
```

- `id: "claude-sop"` is our own marker for idempotent re-merge. Claude Code ignores unknown keys.
- `command` is an absolute path (docs: "use absolute paths or `$CLAUDE_PROJECT_DIR`"). We use absolute paths because the shim lives in `~/.claude-sop/`, outside the project.
- `timeout: 10` — shim exit target is <50ms; 10s ceiling is generous, protects Claude Code from a hung shim.
- User's existing hooks are preserved in order; our entries append to each event array.

**Merge algorithm (pseudocode):**

```
existing = parse(settings.json)
for each event in [UserPromptSubmit, Stop, SubagentStop, PreToolUse, PostToolUse]:
    event_hooks = existing.hooks?.[event] ?? []
    # strip prior claude-sop entries
    event_hooks = [h for h in event_hooks if not has_id(h, "claude-sop")]
    # append our entry LAST (G2: user hooks fire first)
    event_hooks.append(our_entry(event))
    existing.hooks[event] = event_hooks
write atomically
```

### `<project>/CLAUDE.md` managed section (empty markers)

```markdown
<!-- claude-sop:begin -->
<!-- claude-sop:end -->
```

- If CLAUDE.md doesn't exist → create with ONLY these two lines (plus trailing newline).
- If it exists and has no markers → append with one blank line above.
- If it exists and has markers → no-op.
- Content between markers is left untouched by Phase 2 (Phase 4 writes into it).

### `secrets.enc` trial timestamp shape (Phase 0 schema extension)

Phase 0 already ships `secrets.enc` as aes-256-gcm encrypted JSON. Phase 2 adds:

```jsonc
{
  "schema_version": 1,
  "license": {
    "key": "123",                    // or user-entered key
    "kind": "dev" | "user",          // "dev" iff key === "123"
    "captured_at": 1712000000000
  },
  "trial": {
    "started_at": 1712000000000,
    "duration_days": 14              // Phase 6 can override
  },
  "install": {
    "version": "0.1.0",
    "installed_at": 1712000000000,
    "machine_id_prefix": "abc12345"  // first 8 hex of node-machine-id, for sanity check only
  }
}
```

**Tamper detection:** Because secrets.enc is AES-GCM encrypted with a key derived from node-machine-id, any tampering either (a) decrypts to garbage (GCM tag fail → throws) or (b) requires the user to re-encrypt with the correct key (which means they can do whatever they want; we don't fight the user). This matches the principle "we're not defending against the legitimate user; we're defending against accidental file corruption and casual reverse-engineering."

## Common Pitfalls

### Pitfall 1: Race condition on concurrent `install` runs
**What goes wrong:** User runs `npx claude-sop install` twice simultaneously in two shells; both write to `~/.claude-sop/marketplace/claude-sop/` and clobber each other.
**Why it happens:** No install-time lock.
**How to avoid:** Acquire `proper-lockfile` on `~/.claude-sop/install.lock` for the entire `install` verb duration. Fail fast with "another install is in progress" (exit 3) if lock is held.
**Warning signs:** Truncated `hooks.json` in the bundle after double-install.

### Pitfall 2: Launchd silently ignores plist with syntax error
**What goes wrong:** An unescaped `&` or `<` in a path string breaks the plist; `launchctl bootstrap` says OK but nothing runs.
**Why it happens:** Plist is strict XML; launchd's error reporting is poor.
**How to avoid:** After `launchctl bootstrap`, run `launchctl print gui/<uid>/com.claude-sop.learner` and parse the output to confirm the service registered. Fail install with exit 1 if not. Also: validate plist XML with a shim (e.g., `plutil -lint` on macOS).
**Warning signs:** Install succeeds, first tick never fires, no logs in `~/.claude-sop/logs/`.

### Pitfall 3: Systemd timer doesn't survive logout without lingering
**What goes wrong:** User runs `install` on Ubuntu desktop, reboots, timer never fires until they log back in.
**Why it happens:** Default systemd user session ends on logout.
**How to avoid:** Always call `loginctl enable-linger $USER` (with `reject: false` because some environments reject it — e.g., inside Docker containers without polkit). If lingering can't be enabled, warn the user explicitly.
**Warning signs:** `status` shows last-tick-time as the install time, never advances.

### Pitfall 4: `jsonc-parser` `modify` on missing key
**What goes wrong:** `modify(text, ['hooks'], value, opts)` on a file with no `hooks` key works fine, but on an empty file (`""`) it produces bad output.
**Why it happens:** Parser needs at least `{}` as a base.
**How to avoid:** If source file is empty or missing, initialize with `"{}"` before calling `modify`.
**Warning signs:** JSON parse error in settings.json after install on a fresh project.

### Pitfall 5: `fs.rename` across filesystems fails with EXDEV
**What goes wrong:** On Linux, `/tmp` is often a tmpfs. `writeFileAtomic` that writes tmp to `/tmp` then renames to `~/...` crosses filesystems and fails with EXDEV.
**Why it happens:** `rename(2)` is only atomic within a single filesystem.
**How to avoid:** Always write the `.tmp-<nanoid>` file in the SAME directory as the final target. That guarantees same-filesystem rename.
**Warning signs:** Random EXDEV errors on Linux, none on macOS.

### Pitfall 6: Commander.js eats our exit codes
**What goes wrong:** commander's default error handler calls `process.exit(1)` on unknown command, but we want `process.exit(2)` for misuse per I4.
**Why it happens:** Commander's `exitOverride()` is required to customize exit behavior.
**How to avoid:** Call `program.exitOverride()` at root; catch `CommanderError`, map `commander.unknownCommand` / `commander.missingArgument` / `commander.unknownOption` to exit 2; map our own `PreconditionError` to exit 3; everything else to exit 1. Success path explicitly `process.exit(0)`.
**Warning signs:** Scripts piping to `claude-sop install --json` see exit 1 for misuse instead of exit 2.

### Pitfall 7: Detecting "already installed" incorrectly
**What goes wrong:** `install` sees `~/.claude-sop/version.txt` exists, concludes "fully installed", but some other artifact (e.g., launchd plist) was manually deleted. Re-install doesn't repair it.
**Why it happens:** `version.txt` is a single source of truth; true installation state is spread across 6+ files.
**How to avoid:** Treat `version.txt` as "intended version." Every step of `install` is still idempotent and runs unconditionally on re-install (copying the bundle, merging settings.json, rewriting tick.sh, re-registering scheduler). Version.txt only controls the upgrade/downgrade branch, NOT whether individual steps run.
**Warning signs:** Manual artifact deletion + `install` shows "already installed" but artifact is still gone.

### Pitfall 8: `crontab -` truncates on stdin EOF
**What goes wrong:** Passing new crontab via stdin without trailing newline causes crond to ignore the last entry.
**Why it happens:** POSIX convention — crontab files must end with newline.
**How to avoid:** Always terminate the piped content with `\n`.
**Warning signs:** Cron entry appears in `crontab -l` but never fires.

### Pitfall 9: `extraKnownMarketplaces` path is not `~`-expanded
**What goes wrong:** Writing `"path": "~/.claude-sop/marketplace/claude-sop"` into settings.json; Claude Code treats `~` as a literal directory name.
**Why it happens:** JSON is not shell; no tilde expansion.
**How to avoid:** Always write absolute paths (`os.homedir() + '/.claude-sop/...'`). Never `~`.
**Warning signs:** Claude Code logs "marketplace not found" on next launch.

### Pitfall 10: Plugin bundle path contains spaces / unicode
**What goes wrong:** User's home dir is `/Users/Ayşe Çalışkan/` — shell quoting in tick.sh breaks.
**Why it happens:** Naive string interpolation without quoting.
**How to avoid:** In `tick.sh`, always quote variable expansions (`"$NODE_BIN"`). In plist `ProgramArguments`, strings are passed argv-style and don't need shell quoting. In systemd `ExecStart`, escape spaces with `\` per systemd unit syntax.
**Warning signs:** Install "works" but tick never fires on machines with non-ASCII home directories.

## Code Examples

### Atomic file write (same-filesystem rename)

```ts
// src/atomic/write.ts
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';

export async function writeFileAtomic(path: string, content: string | Buffer) {
  const dir = dirname(path);
  const tmp = join(dir, `.${nanoid(10)}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, content, { mode: 0o600 });
  // fsync to ensure durability before rename
  const fh = await fs.open(tmp, 'r+');
  try { await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, path);
}
```

### Commander v14 root with rich exit codes

```ts
// src/cli/index.ts
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';

class PreconditionError extends Error {
  constructor(msg: string) { super(msg); }
}

const program = new Command()
  .name('claude-sop')
  .version(pkg.version)
  .option('--json', 'emit stable JSON output', false)
  .exitOverride(); // required to customize exit codes

// register verbs
program.command('install').action(runInstall);
program.command('uninstall').option('--purge').action(runUninstall);
// ...

try {
  await program.parseAsync(process.argv);
  process.exit(0);
} catch (err) {
  if (err instanceof CommanderError) {
    // misuse: unknown/bad flags, missing args
    if (err.code.startsWith('commander.') && err.code !== 'commander.version') {
      process.stderr.write(pc.red(err.message) + '\n');
      process.exit(2);
    }
  }
  if (err instanceof PreconditionError) {
    process.stderr.write(pc.yellow(err.message) + '\n');
    process.exit(3);
  }
  process.stderr.write(pc.red(`error: ${(err as Error).message}`) + '\n');
  process.exit(1);
}
```

### Readline license prompt (no inquirer)

```ts
// src/cli/prompt.ts
import * as readline from 'node:readline/promises';

export async function promptLicense(defaultText = '123'): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Enter your claude-sop license key (test key: ${defaultText}): `
    );
    return answer.trim() || defaultText;
  } finally {
    rl.close();
  }
}
```

### Platform detect for scheduler

```ts
// src/scheduler/detect.ts
import { execa } from 'execa';

export async function systemdUserAvailable(): Promise<boolean> {
  try {
    const r = await execa('systemctl', ['--user', 'is-system-running'], {
      reject: false,
      timeout: 2000,
    });
    // "running", "degraded", "starting" are all fine; any of them means bus is up
    return r.exitCode === 0 || /running|degraded|starting/.test(r.stdout);
  } catch {
    return false;
  }
}
```

### Plugin bundle `hooks/hooks.json` (verbatim file in dist/plugin/)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }
        ]
      }
    ]
  }
}
```

The plugin bundle's hooks.json uses `${CLAUDE_PLUGIN_ROOT}` (Claude Code expands at runtime). The project-local settings.json merge uses absolute paths (since `${CLAUDE_PLUGIN_ROOT}` is only defined inside plugin context). Both configurations coexist; both fire; the double-fire is not a problem because Phase 1's shim idempotently writes per `tool_use_id` + turn-dir semantics — BUT to keep it strictly correct, the project-local merge should be **conditional on whether the plugin source was successfully registered**. See Open Question 1.

### Testing strategy (parameterize `$HOME`)

Per Phase 0 pattern, every filesystem access routes through `PathResolver`, which reads `process.env.HOME` (or the equivalent test-override). Tests set `HOME=<tmp>` via vitest's `beforeEach` + `process.env.HOME = tmpDir`. The installer then writes `<tmp>/.claude-sop/`, `<tmp>/Library/LaunchAgents/` (macOS), `<tmp>/.config/systemd/user/` (Linux). For scheduler tests, STUB `execa` via vitest's `vi.mock('execa')` — capture argv, assert shape, never actually shell out to launchctl/systemctl. Zero-network mandate inherited from Phase 0.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| `launchctl load ~/Library/LaunchAgents/foo.plist` | `launchctl bootstrap gui/<uid> foo.plist` + `launchctl enable` | macOS 10.10 "launchd 2.0" | `load`/`unload` deprecated; old syntax still works but emits warnings |
| Manual `~/.config/cron.hourly/` | systemd user timers w/ `loginctl enable-linger` | systemd 228+ (~2015) | Cron still fine for fallback but systemd is primary |
| Shell `flock -n lock.file -- cmd` | `proper-lockfile` in Node | N/A | macOS lacks `flock(1)`; Node-level lock works everywhere |
| `JSON.parse` of settings.json | `jsonc-parser.modify` + `applyEdits` | VS Code popularized JSONC | Preserves user comments and formatting on merge |
| `chalk` | `picocolors` | 2021+ ecosystem shift | 1KB vs 25KB, same API surface for basic colors |
| `inquirer` for prompts | `node:readline/promises` | Node 17+ | Built-in; no dep for single-prompt flows |

**Deprecated / avoid:**
- `launchctl load -w` — deprecated since 10.10; use `bootstrap` + `enable`
- `child_process.exec` with string command — argv-splitting bugs; use `execa(cmd, [args])`
- `JSON.stringify` round-trip for settings.json edit — destroys user formatting/comments
- `fs.writeFile` without atomic rename — crash-unsafe

## Open Questions

1. **Plugin + project-local hook double-fire.** If both the marketplace-registered plugin AND the project-local settings.json merge target the same hook events pointing at the same shim binary, the shim will fire twice per event.
   - **What we know:** Phase 1's shim writes atomically per `tool_use_id`; a double-fire produces the same turn-dir mutation twice. The second write is a no-op on content but doubles the scrubber work (~50ms wasted).
   - **What's unclear:** Whether Claude Code deduplicates hook entries with identical `command` across plugin and project scopes (docs don't say).
   - **Recommendation:** Phase 2's installer writes the project-local merge by default (primary `npx` path), and the plugin bundle's `hooks/hooks.json` is **primarily for marketplace-install users**. Ship the plugin with `hooks/hooks.json` populated, BUT the `npx install` path should NOT call `enabledPlugins: { "claude-sop@claude-sop": true }`. Marketplace users install via `/plugin install` which sets `enabledPlugins` themselves; they get plugin-scoped hooks. npm users get project-local hooks. No user ever has both. A 2-line guard in the install flow implements this.

2. **Does `claude plugin install` run non-interactively from execa without a TTY?** Docs say "non-interactive subcommands" but we have no proof it works in a bare CI-like environment.
   - **Recommendation:** Phase 2 does NOT depend on this. We use `extraKnownMarketplaces` declarative registration only. Shelling out to `claude plugin install` is a marketplace-user workflow, not an npm-installer workflow.

3. **Migration of `secrets.enc` schema on G3 upgrade.** Phase 0 already has an encryption layer; Phase 2 adds the trial-start timestamp. What happens on future schema bumps?
   - **Recommendation:** Include `schema_version` in the plaintext JSON (inside the encrypted blob). On upgrade, decrypt, check schema_version, run migrations if needed, re-encrypt. Phase 2 ships schema_version=1.

4. **`hooks/hooks.json` matcher field for PreToolUse/PostToolUse.** Claude Code hook schema supports a `matcher` field to scope the hook to specific tool names (e.g., `"matcher": "Write|Edit"`). Do we want to scope, or fire on all tools?
   - **What we know:** Phase 1's writer expects to see ALL tool events for turn completeness.
   - **Recommendation:** Leave `matcher` absent → fires on all. Document in plan.

5. **`extraKnownMarketplaces` source type `directory` vs `file`.** Docs mention both but don't cleanly differentiate their precedence or path-resolution semantics.
   - **Recommendation:** Use `directory` pointing at `~/.claude-sop/marketplace/claude-sop/`; that directory contains `.claude-plugin/marketplace.json` inside. Verify with a one-shot probe during the first planned task. If `directory` doesn't work, fall back to `file` pointing at the `.claude-plugin/marketplace.json` path.

## Sources

### Primary (HIGH confidence)
- **Claude Code: Create plugins** — https://code.claude.com/docs/en/plugins (plugin.json schema, `.claude-plugin/` layout, `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, strict mode, caching)
- **Claude Code: Plugin marketplaces** — https://code.claude.com/docs/en/plugin-marketplaces (marketplace.json schema, source types incl. `npm`/`directory`/`file`/`git-subdir`, `extraKnownMarketplaces` settings key, `~/.claude/plugins/cache` install location, private repo auth, seed directories, `claude plugin marketplace add`/`claude plugin install` non-interactive subcommands)
- **Claude Code: Hooks guide** — https://code.claude.com/docs/en/hooks-guide (UserPromptSubmit/SessionStart/Stop payloads, `command` field absolute-path requirement, `$CLAUDE_PROJECT_DIR`)
- **launchd.plist(5) man page** — https://keith.github.io/xcode-man-pages/launchd.plist.5.html (StartInterval, ProgramArguments, EnvironmentVariables, ProcessType)
- **launchctl 2.0 syntax reference** — https://babodee.wordpress.com/2016/04/09/launchctl-2-0-syntax/ (`bootstrap`/`bootout`/`enable`/`disable`, `gui/<uid>` domain)
- **systemd.timer(5) man page** — https://manpages.debian.org/testing/systemd/systemd.timer.5.en.html (OnBootSec, OnUnitActiveSec, Persistent, AccuracySec)
- **Arch Wiki: systemd/Timers** — https://wiki.archlinux.org/title/Systemd/Timers (user timer patterns, loginctl enable-linger)
- **jsonc-parser (Microsoft)** — https://github.com/microsoft/node-jsonc-parser (parse/modify/applyEdits APIs)
- **commander.js v14** — https://github.com/tj/commander.js (exitOverride, CommanderError codes)
- **proper-lockfile** — https://github.com/moxystudio/node-proper-lockfile (stale detection, realpath, cross-platform)

### Secondary (MEDIUM confidence)
- **systemd issue #3570** — https://github.com/systemd/systemd/issues/3570 (Persistent=true limitation with OnUnitActiveSec= across reboot)
- **macOS flock(2) man page** — https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html (confirms syscall exists; `flock(1)` user-space utility does NOT ship with macOS)
- **scriptingosx launchd packaging** — https://scriptingosx.com/2024/07/building-a-launchd-installer-pkg-for-desktoppr-and-other-tools/ (plist structure, installer integration patterns)

### Tertiary (LOW confidence — flag for validation during Phase 2 execution)
- **`extraKnownMarketplaces` with `directory` vs `file` source type precedence** — single doc source; verify with one-shot probe in first task.
- **Plugin hook + project-local hook dedup behavior** — undocumented; verify empirically or guard via mutual-exclusion logic as recommended in Open Question 1.
- **`claude plugin install` exit codes / stdout format in non-TTY execa invocation** — not relevant to Phase 2 primary path (we use declarative registration), but flagged for Phase 2 QA if we ever want to trigger install programmatically.

## Metadata

**Confidence breakdown:**
- G1 plugin bundle decision: HIGH — based on explicit official doc features (`extraKnownMarketplaces`, local `directory` source type, versioned plugin cache).
- launchd plist template: HIGH — verified against launchd.plist(5) man page and scriptingosx exemplars; `StartInterval` semantics are unambiguous.
- systemd unit templates: HIGH — verified against systemd.timer(5) and Arch Wiki; loginctl lingering is standard.
- settings.json merge algorithm: HIGH — jsonc-parser is the canonical tool; pattern is VS Code's own.
- Lock strategy (proper-lockfile over flock(1)): HIGH — macOS flock(1) absence is verified fact.
- Plugin + project-local hook interaction: MEDIUM — mitigation is known (mutual exclusion) but behavior is unverified.
- Cron fallback detection reliability: MEDIUM — `systemctl --user is-system-running` is a reasonable probe but not bulletproof across all minimal distros.

**Research date:** 2026-04-13
**Valid until:** 2026-05-13 (30 days — stable OS-integration domain; only Claude Code plugin mechanics move fast, and those are well-documented).
