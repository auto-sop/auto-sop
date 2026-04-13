# Stack Research — claude-sop

**Domain:** Node.js CLI tool / Claude Code extension (hook-based capture + hourly learner)
**Researched:** 2026-04-13
**Overall confidence:** HIGH for CLI/build tooling and Claude Code hook schema (verified against live npm registry and official Claude Code docs). MEDIUM for scheduler strategy (decision depends on UX tradeoffs, not a missing package). MEDIUM for secret scrubbing (two viable families, pick driven by bundle-size preference).

---

## Executive Recommendation (one paragraph)

Build claude-sop as a **TypeScript package compiled with `tsup` to dual ESM+CJS**, shipped on npm as `claude-sop`. Use **`commander@14`** for the CLI, **`execa@9`** to spawn the `claude` binary, **`proper-lockfile@4`** for concurrent hook writes, **`nanoid@5`** for short filesystem-safe IDs, **`vitest@4`** for tests, and a **custom regex-based secret scrubber** augmented by `secretlint`'s rule packages as the authoritative pattern source. For scheduling, **write launchd plists on macOS and systemd user units on Linux directly** (do NOT embed `node-cron` — an in-process scheduler dies when the user's shell session dies). Ship as a **standalone npm package installed via `npx claude-sop install`** that writes hooks into `~/.claude/settings.json` — **not** as a Claude Code plugin — because the plugin format cannot drive an external hourly job and because npx distribution is the stated requirement.

---

## The Critical Architectural Decision: Plugin vs. Standalone npm Package

This must be settled before anything else, because it determines 80% of the rest of the stack.

Claude Code supports two extension models (verified from official docs at `code.claude.com/docs/en/plugins` and `.../en/hooks`):

| Model | Distribution | Hook storage | Can run background jobs? |
|---|---|---|---|
| **Plugin** | `/plugin install` from a marketplace or `--plugin-dir` | `hooks/hooks.json` inside the plugin directory | No — plugins are passive; no install-time hooks, no scheduler |
| **Standalone** | Any mechanism (npm, brew, curl) that writes files | `~/.claude/settings.json` (user) or `.claude/settings.json` (project) | Yes — the installer is arbitrary code |

**Recommendation: ship as a standalone npm package invoked via `npx claude-sop install`.** Rationale:

1. The brief explicitly requires `npx claude-sop install`, which is not how plugins are installed.
2. claude-sop needs to install an OS-level scheduler (launchd/systemd). Plugins have no install lifecycle; they cannot run setup code. Only a normal npm package with an `install` subcommand can do this.
3. The hourly learner must run even when no Claude Code session is active. A plugin is only loaded inside a running Claude Code process.
4. Standalone hook config in `~/.claude/settings.json` and `.claude/settings.json` is fully documented and has the same schema as plugin `hooks/hooks.json`, so nothing is lost.

**Do not** try to be both. Pick standalone, document it, move on.

---

## Recommended Stack

### Core Technologies

| Technology | Version (verified) | Purpose | Why |
|---|---|---|---|
| **Node.js** | >=18.17 (engines field: `>=18.17.0`) | Runtime | Node 18 is the lowest LTS with stable `node:test`, `fetch`, and `fs.cp`. 20 is current LTS as of 2026 but 18 is still supported enough to keep the floor low for users. |
| **TypeScript** | ^5.6 | Source language | Free type safety on filesystem + JSON manipulation, which is 90% of this tool. Small surface area — no framework cost. |
| **tsup** | ^8.5.1 | Build (esbuild wrapper) | Zero-config dual ESM+CJS, emits `.d.ts`, bundles bin entry. Ships a single JS file per format, which makes `npx` cold-start fast. |
| **commander** | ^14.0.3 | CLI framework | Small (~40KB), zero deps, battle-tested (used by vercel, create-react-app). Subcommand model (`install`, `uninstall`, `status`, `learn`, `doctor`) fits cleanly. Synchronous parsing, no ESM-only gotchas. |
| **execa** | ^9.6.1 | Spawn `claude` CLI | Best-in-class child-process ergonomics: streams, timeouts, shell escaping, stdin piping. **ESM-only** from v7+ — confirms the "ship ESM primary" choice. |
| **proper-lockfile** | ^4.1.2 | Cross-process mutex | Needed because multiple concurrent hook invocations may write to the same capture index / CLAUDE.md at once. Uses `mkdir` atomicity under the hood — works on macOS and Linux. Stable since 2021 (low version churn = good, not stale). |
| **nanoid** | ^5.1.7 | Short hash for capture dirs | 8-char nanoid gives ~1M IDs before collision risk at the filesystem level. Filesystem-safe alphabet (A-Za-z0-9_-). **ESM-only** in v5 — matches the rest of the stack. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---|---|---|---|
| **secretlint** (+ `@secretlint/secretlint-rule-preset-recommend`) | ^11.7.1 | Secret detection rule source | Use its rule preset as the authoritative pattern library (AWS, GCP, GitHub, Slack, npm, SSH). Wrap in a thin programmatic API; do not invoke via CLI. |
| **fast-glob** | ^3.3.x | Capture directory traversal | Faster and more correct than `fs.readdir` recursion; needed by the learner when walking `~/.claude/sop/<project>/`. |
| **yaml** (eemeli/yaml) | ^2.6.x | Parse YAML frontmatter in CLAUDE.md managed sections | Only if we decide managed-section metadata lives in YAML. Otherwise skip. |
| **zod** | ^3.23.x | Runtime validation of settings.json and capture JSON | Catches schema drift when Claude Code updates its hook JSON format. Critical safety net — see PITFALLS. |
| **picocolors** | ^1.1.x | Terminal colors | 6x smaller than chalk, zero deps. Good `npx` citizenship. |
| **p-queue** | ^8.x | Throttle the learner's model calls | When spawning `claude` CLI per-capture, rate-limit to 1-2 in flight. |

### Development Tools

| Tool | Purpose | Notes |
|---|---|---|
| **vitest** | ^4.1.4 | Test runner | Native ESM, native TypeScript, vite-fast. Has `vi.mock` for filesystem stubbing and first-class snapshot support for the hook-script generator. |
| **memfs** | ^4.x | In-memory fs for tests | Hook installation tests should never touch the real `~/.claude/`. `memfs` + `vitest`'s global mock of `node:fs` does this cleanly. |
| **tsx** | ^4.x | Run TS directly during dev | Replaces ts-node; faster cold start. |
| **@types/node** | ^20.x | Node type defs | Match the runtime floor. |
| **pnpm** | ^9.x | Package manager for authors | Faster installs, stricter `node_modules` hoisting (catches missing declared deps before users do). npm still works for end users — this is authoring-only. |
| **publint** | ^0.3.x | Lints `package.json` `exports` map | Catches dual-package hazards before users hit them on `npx`. |
| **@arethetypeswrong/cli** | ^0.17.x | Lints type resolution for ESM/CJS/bundlers | Same reason — ensures `import 'claude-sop'` works in every consumer context. |

---

## Question-by-Question Answers

### 1. CLI framework — **commander** (HIGH confidence)

Ranked:

1. **commander ^14.0.3** — Recommended. Zero deps, ~40KB, synchronous parse, subcommand-native, widely understood. 14.x is current (verified on npm). Fits `install | uninstall | status | learn | doctor` perfectly.
2. **citty ^0.2.2** — From the UnJS org (Nitro/Nuxt people). Elegant, async-native, but still 0.x after years — API not frozen. Avoid for a package other people depend on.
3. **yargs ^18.x** — Heavier (pulls `cliui`, `y18n`, `escalade`), more features than needed. Fine but pointless here.
4. **oclif ^4.x** — Overkill. Optimized for Salesforce-scale multi-topic CLIs with plugins; adds a build step and a runtime. Using oclif for five subcommands is like using Rails for a contact form.
5. **Plain `process.argv`** — Don't. You'll reimplement commander's `--help`, `--version`, and option parsing poorly.

### 2. Package manager / build / module format — **pnpm (author) / tsup / dual ESM+CJS** (HIGH confidence)

- **Author-side manager: pnpm.** Strict hoisting prevents the "works on my machine because a transitive dep leaked through" class of bug. End users are unaffected — they'll `npx claude-sop install` regardless.
- **Ship format: dual ESM+CJS via `tsup`**, with ESM as the canonical form. Rationale: `execa@9` and `nanoid@5` are ESM-only, so the package internally must be ESM. But you want `npx claude-sop install` to cold-start fast, and bundling down to a single file per format via tsup/esbuild removes the "hundreds of `require` calls" startup tax. Dual build costs nothing with tsup (`format: ['esm','cjs']`) and maximizes compatibility.
- **`package.json` essentials**:
  - `"type": "module"`
  - `"exports"` map with `import`/`require`/`types` conditions
  - `"bin": { "claude-sop": "./dist/cli.cjs" }` — use the CJS file for the bin so Node's shebang loader is fast and immune to ESM loader quirks. The CJS bundle is self-contained thanks to tsup.
  - `"engines": { "node": ">=18.17.0" }`
  - `"files": ["dist"]`
  - Verified with `publint` and `@arethetypeswrong/cli` in CI.
- **What `npx` actually needs**:
  - A `bin` entry pointing to an executable file whose first line is `#!/usr/bin/env node`.
  - `files` field that includes that file.
  - A small unpacked size (tsup's single-file bundle helps — aim <500KB unpacked).
  - No `postinstall` script (npx users expect installs to be passive; put setup behind `install` subcommand instead).

**Anti-rec: do not use `bun` to build.** bun is great for apps; as a build tool for an npm-distributed library it still has rough edges around `exports` maps and `.d.ts` emission. tsup is the boring correct answer.

### 3. Claude Code hooks integration — **write to `~/.claude/settings.json` by default, offer `--project` for `.claude/settings.json`** (HIGH confidence, verified against official docs)

**Verified facts from `code.claude.com/docs/en/hooks` (fetched 2026-04-13):**

- **File locations (in precedence order from lowest to highest scope):**
  - `~/.claude/settings.json` — user scope, all projects, not shareable
  - `.claude/settings.json` — project scope, committed to repo, shareable
  - `.claude/settings.local.json` — project scope, gitignored, local overrides
  - Managed policy settings — enterprise / MDM
  - Plugin `hooks/hooks.json` — bundled with plugin
- **Schema shape (authoritative):**
  ```json
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash|Edit|Write",
          "hooks": [
            { "type": "command",
              "command": "\"$CLAUDE_PROJECT_DIR\"/.claude-sop/hooks/capture.sh",
              "timeout": 30 }
          ]
        }
      ]
    }
  }
  ```
- **Events claude-sop should subscribe to** (all confirmed to exist):
  - `PreToolUse`, `PostToolUse`, `PostToolUseFailure` — capture tool I/O
  - `UserPromptSubmit` — capture the human prompt
  - `SubagentStart`, `SubagentStop` — capture subagent lifecycle
  - `SessionStart`, `SessionEnd` — capture bookends
  - `Stop` — capture final response
- **Environment variables available to hook commands:** `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `$CLAUDE_CODE_REMOTE`.
- **Stdin JSON always includes:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`. PostToolUse additionally includes `tool_name`, `tool_input`, `tool_response`, `tool_use_id`. UserPromptSubmit includes `prompt`. SubagentStart/Stop includes `agent_id`, `agent_type`.
- **Exit codes:** `0` = success (stdout parsed as JSON for control), `2` = block, `1` = non-blocking error. claude-sop's capture hook MUST always exit 0 (capture is never authoritative — it observes, it does not gate).

**Non-destructive merge strategy (recommended):**

1. Read existing `settings.json`. If absent, start with `{}`.
2. Validate with zod against the known hook schema. If validation fails, abort with a clear error and point the user at `claude-sop doctor`.
3. For each event claude-sop cares about, look for an existing entry whose `matcher` equals claude-sop's matcher string exactly, AND whose `hooks[].command` path equals claude-sop's capture script path exactly.
4. If found: leave it alone (idempotent).
5. If not: append a new `{matcher, hooks: [...]}` entry to the array. **Do not** merge into an existing entry with a different matcher — matchers are semantic and merging them changes behavior.
6. Mark every claude-sop-managed entry with a synthetic comment field in the command path (e.g., `# managed-by:claude-sop`) or a sidecar registry file at `~/.claude/sop/managed-hooks.json` so `uninstall` can find and remove them without guessing.
7. Write via `proper-lockfile` + atomic rename (`fs.writeFile` to `settings.json.tmp`, then `fs.rename`).
8. Back up `settings.json` to `settings.json.claude-sop.bak` on first install.

### 4. Scheduler — **native launchd / systemd user units, NOT node-cron** (HIGH confidence on reasoning; MEDIUM on precise plist template)

**Recommendation: at install time, write an OS-native scheduler unit and `launchctl load` / `systemctl --user enable --now` it.** Reject in-process schedulers for this use case.

Why:

- **`node-cron` / `croner` / `bree` all run inside a long-lived Node process.** For that to work, claude-sop would need a daemon. Users won't keep a daemon running just to learn from their captures, and starting one from `claude-sop install` is a support nightmare (who restarts it on reboot? who logs its output? what if two installs race?).
- **launchd (`~/Library/LaunchAgents/com.claude-sop.learner.plist`) and systemd user units (`~/.config/systemd/user/claude-sop-learner.{service,timer}`) are the operating system's answer to exactly this problem.** They're reliable, log to standard locations, survive reboots, and the uninstall story is a single `launchctl unload` / `systemctl --user disable`.
- **Prior art:** `pnpm` uses no scheduler, `n8n` ships a full daemon with pm2 (too heavy), `rclone` writes systemd units, `syncthing` writes launchd/systemd units, `topgrade` writes systemd timers. The pattern is standard.

Implementation details:

- On macOS: write a `LaunchAgent` plist with `StartInterval` 3600 or `StartCalendarInterval`, `ProgramArguments` pointing at `node <installed path>/dist/learner.cjs`, `StandardOutPath` and `StandardErrorPath` under `~/.claude/sop/logs/`. Use `launchctl bootstrap gui/$UID <plist>` on macOS 12+ (not the deprecated `load -w`).
- On Linux: write a `.service` unit (`Type=oneshot`, `ExecStart=/usr/bin/env node ...`) plus a `.timer` unit (`OnCalendar=hourly`, `Persistent=true`). Enable via `systemctl --user enable --now claude-sop-learner.timer`.
- **Detection:** `claude-sop doctor` should verify the unit is registered and the last run timestamp is <2h old.
- **Fallback:** if neither launchd nor systemd is available (e.g., WSL1, some containers), degrade gracefully — write a cron entry via `crontab -l | ... | crontab -` as a last resort, and warn loudly.

**Libraries to help:** none needed — launchd/systemd units are plain text templates. Don't pull in a dependency for string formatting. A single `renderLaunchdPlist(opts): string` function and its systemd twin are ~50 lines each.

**Anti-rec:** do not use `node-cron`, `bree`, or `agenda`. They all assume a host process. Also avoid `node-windows` / `node-mac` / `node-linux` (the "services" family) — they're abandoned or flaky.

### 5. Secret scrubbing — **custom regex engine seeded by secretlint's rule packages** (MEDIUM confidence)

Options evaluated:

| Option | Verdict | Why |
|---|---|---|
| **secretlint** (^11.7.1) | Use its rule packages as a *data source*, not as a runtime | secretlint is designed as a CLI/lint tool, not an embedded scrubber. Pulling in the full engine adds ~30MB of deps. But its `@secretlint/secretlint-rule-preset-recommend` package contains the canonical patterns — extract them. |
| **detect-secrets** (Yelp) | Reject | Python. Can't embed in Node without a subprocess round-trip per capture. |
| **trufflehog** | Reject | Go binary. Same problem plus binary distribution headache. |
| **Custom regex + entropy check** | **Recommended** | 200 lines. Full control over what gets scrubbed. Fast enough to run inline in the hook. |

Recommended implementation:

- Maintain an internal `patterns.ts` with named regexes: `AWS_ACCESS_KEY_ID` (`AKIA[0-9A-Z]{16}`), `AWS_SECRET` (base64-ish 40-char following `aws_secret_access_key`), `GITHUB_PAT` (`gh[pousr]_[A-Za-z0-9]{36,}`), `ANTHROPIC_KEY` (`sk-ant-[A-Za-z0-9_-]{20,}`), `OPENAI_KEY` (`sk-[A-Za-z0-9]{48}`), `SLACK_TOKEN` (`xox[baprs]-[A-Za-z0-9-]+`), `GOOGLE_API` (`AIza[0-9A-Za-z_-]{35}`), `STRIPE` (`sk_live_[0-9a-zA-Z]{24,}`), `JWT` (`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`), `PRIVATE_KEY` (`-----BEGIN [A-Z ]*PRIVATE KEY-----`), `DOTENV_LINE` (`^[A-Z_][A-Z0-9_]*=(.+)$` multi-line mode, redact the RHS).
- Plus a generic high-entropy catcher: any whitespace-bounded token ≥20 chars with Shannon entropy ≥4.5 gets redacted.
- Replace with `<REDACTED:TYPE>`.
- **Cross-check** the pattern list quarterly against the current `@secretlint/secretlint-rule-preset-recommend` source on GitHub; update regex on drift. Document this as a maintenance task in `PITFALLS.md`.
- Scrubber runs once in the capture hook (inline, synchronous) AND once again in the learner (defense in depth, in case the hook's scrubber missed something that a future rule now catches).

### 6. Short hashes / IDs — **nanoid@5, length 8** (HIGH confidence)

- **nanoid ^5.1.7**, `nanoid(8)` → 8-char ID from a 64-char URL/filesystem-safe alphabet. ~47 bits of entropy, ~1M IDs before 1% collision probability. Plenty for "captures within a single timestamp bucket." Directory names become `{ISO-timestamp}-{agent}-{file}-{nanoid8}` which sorts chronologically via timestamp prefix.
- **Rejected: `crypto.randomBytes(4).toString('hex')`** — same info density but base16 is longer per bit.
- **Rejected: `ulid`** — 26 chars, overkill; time-ordering already comes from the timestamp prefix.
- **Rejected: `uuid` v4/v7** — 36 chars, filesystem-noisy.
- Note nanoid@5 is ESM-only; aligns with the ESM-first decision.

### 7. Filesystem locks — **proper-lockfile@4** (HIGH confidence)

- **`proper-lockfile` ^4.1.2**. Uses atomic `mkdir` under the hood, handles stale locks via mtime heuristic, battle-tested (used by `npm`, `yarn`, `renovate`). Low version churn is a feature, not a bug — the filesystem locking problem doesn't change.
- **Do not** rely on "atomic rename alone": rename IS atomic on POSIX, and `fs.rename` is the right way to finalize a write, BUT the *read-modify-write* cycle (read settings.json → merge → write) is not atomic across that — two hooks firing simultaneously can both read the old version and one overwrites the other. Lock the file during the RMW cycle, then use atomic rename to finalize.
- **Do not** use `lockfile` (different package) — older, less actively maintained.
- Lock scope: one mutex per settings.json file path, one mutex per CLAUDE.md file path, one mutex per capture index file. Never a single global lock.

### 8. Markdown managed-section editing — **plain string ops with sentinel markers** (HIGH confidence)

**Recommendation: do not use remark/unified for this.** Use explicit sentinel markers and regex:

```md
<!-- BEGIN claude-sop managed section - do not edit below this line -->
<!-- These directives are auto-generated. Edit your captures to influence them. -->
...directive 1...
...directive 2...
<!-- END claude-sop managed section -->
```

Why:

- **remark/unified** (~20 deps, ~3MB) parses Markdown into an AST. Overkill for replacing content between two markers. Worse, it normalizes whitespace, reflows lists, and will fight with whatever formatter the user runs.
- Users may edit CLAUDE.md outside the markers freely. The marker-based approach is invisible to Prettier, markdownlint, and humans.
- Algorithm: `const re = /<!-- BEGIN claude-sop managed section[\s\S]*?<!-- END claude-sop managed section -->/`. If match, replace; else append with a leading blank line.
- Atomic write via `proper-lockfile` + temp-file-rename.
- Include a version comment inside the block (`<!-- claude-sop vX.Y.Z -->`) so future versions can detect and upgrade old layouts.

### 9. Spawning `claude` CLI — **execa@9** (HIGH confidence)

- **execa ^9.6.1**. Correct argv escaping, streaming stdin/stdout, timeouts, typed results. ESM-only from v7+.
- Pattern for the learner:
  ```ts
  import {execa} from 'execa';
  const {stdout} = await execa('claude', ['-p', '--output-format', 'json'], {
    input: prompt,
    timeout: 120_000,
    reject: false,
  });
  ```
  Passing prompt via stdin avoids shell-quoting hazards. Using `--output-format json` (verify via `claude --help` at runtime in `doctor`) gives structured output the learner can parse without regex.
- **Detection:** `claude-sop doctor` should run `execa('claude', ['--version'])` and gate install on success. If `claude` is not on PATH, fail with actionable message.
- **Anti-rec: plain `child_process.spawn`** works but you'll rewrite execa's error handling. Not worth it.
- **Anti-rec: `zx`** — pulls in a lot more than you need, designed for scripts.

### 10. Testing — **vitest@4** (HIGH confidence)

- **vitest ^4.1.4**. Native ESM, native TS, fast watch mode, `vi.mock('node:fs')`, `vi.useFakeTimers()`, first-class snapshot testing (great for "does the generated hook script match the golden copy").
- **Pair with `memfs`** for filesystem tests. Pattern:
  ```ts
  import {vol} from 'memfs';
  vi.mock('node:fs', async () => (await import('memfs')).fs);
  vi.mock('node:fs/promises', async () => (await import('memfs')).fs.promises);
  ```
- **For execa**, prefer dependency injection (`createInstaller({exec: fakeExec})`) over module mocking — avoids ESM mock-hoisting headaches.
- **Integration test:** spin up a scratch `$TMPDIR/fake-home` with a fake `~/.claude/settings.json`, run `claude-sop install --home $TMPDIR/fake-home`, assert the resulting JSON shape. Add a `--home` override flag in the CLI solely to make this cleanly testable (also useful for `doctor`).
- **Anti-rec: jest** — slow ESM story, transform pipeline overhead, worse TS ergonomics in 2026. No reason to pick it for a greenfield Node CLI.
- **Anti-rec: `node:test`** — viable and zero-dep, but lacks the ergonomics (inline snapshots, `vi.mock`, watch UI) that speed up iteration on a tool this fiddly. Use it if zero dev-deps is a hard constraint; otherwise vitest pays for itself in an afternoon.

---

## Installation

```bash
# Author-side setup (pnpm)
pnpm add commander execa nanoid proper-lockfile picocolors zod fast-glob p-queue
pnpm add -D typescript tsup vitest memfs tsx @types/node publint @arethetypeswrong/cli

# End-user invocation
npx claude-sop install              # user-scope install to ~/.claude/settings.json
npx claude-sop install --project    # project-scope install to ./.claude/settings.json
npx claude-sop status
npx claude-sop doctor
npx claude-sop uninstall
```

---

## Alternatives Considered

| Category | Recommended | Alternative | When Alternative Is Better |
|---|---|---|---|
| CLI framework | commander | citty | Never, until citty reaches 1.0 |
| CLI framework | commander | oclif | You're building a 30-subcommand tool with plugin architecture |
| Build tool | tsup | unbuild | You want Rollup semantics and don't mind more config |
| Build tool | tsup | rollup + ts plugins | You need custom Rollup plugins |
| Module format | ESM primary + CJS bin | Pure ESM | When every dep is ESM and your users are all on Node 20+ (too aggressive for 2026) |
| Module format | Dual | Pure CJS | Never — `execa@9` and `nanoid@5` are ESM-only |
| Scheduler | launchd/systemd | node-cron (in a daemon) | You're already shipping a daemon for other reasons |
| Scheduler | launchd/systemd | cron (classic) | launchd/systemd unavailable; fallback path |
| Lockfile | proper-lockfile | `fs.rename` only | Append-only writes (doesn't apply here — we do RMW) |
| Testing | vitest | node:test | You're in a zero-deps-for-dev shop |
| Testing | vitest | jest | Never, for greenfield Node CLI in 2026 |
| Secret scrub | custom + secretlint patterns | secretlint as runtime | You want drop-in rule updates and don't mind ~30MB deps |
| Hashing | nanoid(8) | ulid | You need sortable IDs without a timestamp prefix |
| CLI spawner | execa | child_process | You want zero deps on this vector |
| Markdown managed section | marker + regex | remark/unified | You need to programmatically edit surrounding content too |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|---|---|---|
| `node-cron` / `bree` / `agenda` | Requires a long-lived Node process; no reliable way to keep it alive across reboots from an `npx` installer | Write launchd/systemd units directly |
| `node-windows` / `node-mac` / `node-linux` | Abandoned or rare updates; wrappers around the same launchd/systemd you can target yourself in 40 lines | Write units directly |
| `jest` | ESM ergonomics are still painful; transform pipeline is slow | `vitest` |
| `ts-node` | Superseded by `tsx` for dev; for prod, tsup produces a single JS file anyway | `tsx` (dev) + `tsup` (build) |
| `chalk` | 5.x is ESM-only AND heavier than picocolors; no feature advantage here | `picocolors` |
| `uuid` / `cuid2` for capture IDs | Too long, no sortability benefit given timestamp prefix | `nanoid(8)` |
| `lockfile` (the package) | Older, less active, less documented than `proper-lockfile` | `proper-lockfile` |
| `remark` / `unified` for CLAUDE.md edits | AST overkill; will reflow whitespace and fight Prettier | Sentinel markers + regex |
| `inquirer` for install prompts | Huge, ESM-only in v9+, overkill | `@clack/prompts` if you need prompts at all; otherwise plain flags |
| `dotenv` | claude-sop should not read `.env` files — it should redact them. Do not depend on dotenv | N/A |
| Bun for building or testing | Still rough `exports` and `.d.ts` story for libraries in early 2026 | tsup + vitest |
| `postinstall` script to set up launchd/systemd | Breaks CI, breaks sandboxed installs, poor UX for `npx` | Explicit `claude-sop install` subcommand |
| Claude Code plugin format for distribution | Cannot run background jobs, no install hook for the scheduler, not installable via `npx` | Standalone npm package that writes to `~/.claude/settings.json` |

---

## Stack Patterns by Variant

**If the user has `claude` CLI on PATH (default path):**
- Learner spawns `claude -p` via execa with `--output-format json`
- No API key needed
- Default model = whatever `claude` CLI is logged into

**If the user supplies `ANTHROPIC_API_KEY` and opts in:**
- Learner uses `@anthropic-ai/sdk` directly
- Add `@anthropic-ai/sdk` as an *optional* dependency loaded via dynamic import only when this mode is active
- Never require the SDK in the default path

**If macOS:**
- Scheduler = launchd plist at `~/Library/LaunchAgents/com.claude-sop.learner.plist`
- Logs = `~/Library/Logs/claude-sop/learner.log`
- Load with `launchctl bootstrap gui/$UID`

**If Linux with systemd user session:**
- Scheduler = `~/.config/systemd/user/claude-sop-learner.{service,timer}`
- Logs = `journalctl --user -u claude-sop-learner`
- Enable with `systemctl --user enable --now`

**If Linux without systemd (rare):**
- Fallback = crontab entry via `(crontab -l 2>/dev/null; echo "0 * * * * ...") | crontab -`
- Warn loudly in install output

**If project-scope install (`--project`):**
- Write hooks to `./.claude/settings.json` (committed)
- Capture dir is `<project>/.claude-sop/captures/`
- Scheduler unit still lives at user scope but its script targets the project path

**If user-scope install (default):**
- Write hooks to `~/.claude/settings.json`
- Capture dir is `<project>/.claude-sop/captures/` (per-project even in user-scope mode — the hook uses `$CLAUDE_PROJECT_DIR`)
- Mirror to `~/.claude/sop/<project-id>/` for aggregation

---

## Version Compatibility

| Package A | Compatible With | Notes |
|---|---|---|
| Node >=18.17 | TypeScript ^5.6 | 18.17 is the floor for stable `node:test`, `fetch`, and `fs.cp` |
| tsup ^8.5 | TypeScript ^5.x | tsup uses esbuild — peer-dep TS only for type emission |
| execa ^9 | Node >=18.19 | execa 9 bumped the Node floor; this is our effective floor |
| nanoid ^5 | ESM consumers only | CJS consumers must use nanoid 3.x — we won't because we're ESM primary |
| vitest ^4 | Node >=18.17 | Aligned |
| commander ^14 | CJS + ESM | Works either way |
| proper-lockfile ^4 | Any Node 14+ | Stable across our range |
| secretlint ^11 | Node >=18 | We only use its rule packages, not the runner |
| Claude Code hooks schema | `type:"command"` hooks, all listed events | Verified 2026-04-13 against `code.claude.com/docs/en/hooks`; add a `zod` schema check in `doctor` to catch future changes |

---

## Sources

- **Claude Code hooks** — `https://code.claude.com/docs/en/hooks` (fetched 2026-04-13) — HIGH confidence. Authoritative schema for events, matchers, stdin JSON, exit codes, env vars.
- **Claude Code settings scopes** — `https://code.claude.com/docs/en/settings` (fetched 2026-04-13) — HIGH confidence. User vs project vs local vs managed policy precedence.
- **Claude Code plugins** — `https://code.claude.com/docs/en/plugins` (fetched 2026-04-13) — HIGH confidence. Confirms plugins cannot host schedulers and are not `npx`-installable; justifies standalone-package choice.
- **npm registry: commander@14.0.3** — `https://registry.npmjs.org/commander/latest` — HIGH confidence.
- **npm registry: execa@9.6.1** — `https://registry.npmjs.org/execa/latest` — HIGH confidence. Confirmed ESM-only.
- **npm registry: nanoid@5.1.7** — `https://registry.npmjs.org/nanoid/latest` — HIGH confidence. Confirmed ESM-only.
- **npm registry: proper-lockfile@4.1.2** — `https://registry.npmjs.org/proper-lockfile/latest` — HIGH confidence. Low churn = intentional.
- **npm registry: secretlint@11.7.1** — `https://registry.npmjs.org/secretlint/latest` — HIGH confidence.
- **npm registry: tsup@8.5.1** — `https://registry.npmjs.org/tsup/latest` — HIGH confidence.
- **npm registry: vitest@4.1.4** — `https://registry.npmjs.org/vitest/latest` — HIGH confidence.
- **npm registry: citty@0.2.2** — `https://registry.npmjs.org/citty/latest` — HIGH confidence. Still 0.x, supporting the "not yet" recommendation.
- **launchd / systemd user unit patterns** — prior art from syncthing, rclone, topgrade project sources — MEDIUM confidence on exact plist XML (templates must be validated during implementation, not copied blind).

---
*Stack research for: claude-sop — Claude Code capture + learner plugin*
*Researched: 2026-04-13*
