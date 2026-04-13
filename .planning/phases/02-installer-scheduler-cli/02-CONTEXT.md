# Phase 2: Installer + Scheduler + CLI Skeleton - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning (planned jointly with Phase 1)

<domain>
## Phase Boundary

A user running `npx claude-sop install` in a project ends up with: hooks wired non-destructively into `<project>/.claude/settings.json`, an hourly OS scheduler job registered (launchd on macOS, systemd user unit on Linux, cron fallback), `.claude-sop/` gitignored, an empty managed section in CLAUDE.md, encrypted license storage created with the trial timestamp, and a working inspection/control CLI (status/doctor/pause/resume/purge/uninstall).

Uses Phase 0 foundations (PathResolver, Config, Scrubber) and Phase 1 deliverables (hook shim binary, writer library). Does NOT implement the learner (Phase 3), the managed-section editor (Phase 4), the license validation backend client (Phase 6), or inspection verbs `recent`/`show` (Phase 5).
</domain>

<decisions>
## Implementation Decisions

### G — Installer

- **G1 — Plugin bundle placement strategy: PLANNER DECIDES based on ADR research.** Phase 0 ADR flagged this as an open question (plugin bundle location, marketplace sideload vs copy). The Phase 2 planner MUST spend the first research step resolving this concretely — likely by reading current Claude Code plugin docs and running a one-off probe on the dev machine. Acceptable outcomes: (a) plugin bundle lives under `~/.claude/plugins/claude-sop/` copied by our installer; (b) plugin bundle lives inside the npm package itself and settings.json points to it by absolute path. Planner must commit to one path before writing tasks.
- **G2 — Hook merge strategy: merge with order preservation.** If `<project>/.claude/settings.json` already has hooks, the installer appends claude-sop's hook entries AFTER any existing user hooks (so user hooks run first, claude-sop captures after). The installer never reorders user hooks, never deletes them, and detects its own entries by a stable `"id": "claude-sop"` marker on each hook entry to make re-install idempotent.
- **G3 — Upgrade behavior: version-compare.** Re-running `npx claude-sop install` with a newer package version than the installed one triggers an in-place upgrade: hook entries re-emitted (with new paths if they changed), scheduler unit re-written (with new binary path), `secrets.enc` migrated if schema changed, managed-section markers left alone. Same version = no-op. Older version = refuse with error.
- **G4 — License key prompt UX: interactive prompt with test key `123`.** `install` prompts via stdin: "Enter your claude-sop license key (test key: 123):". Input is validated against Phase 6 format (for now: any non-empty string, with `123` explicitly accepted as dev mode). Stored encrypted via Phase 0 Config `secrets.enc`. `--license <key>` flag available for non-interactive/CI installs. **"Şimdilik"**: real validation comes in Phase 6; Phase 2 just collects and stores.

### H — Scheduler

- **H1 — Unit file locations: standard OS conventions.**
  - macOS: `~/Library/LaunchAgents/com.claude-sop.learner.plist` loaded with `launchctl bootstrap gui/$UID` + `launchctl enable`.
  - Linux: `~/.config/systemd/user/claude-sop-learner.timer` + `.service` with `systemctl --user enable --now`, and `loginctl enable-linger $USER` to keep the timer alive when logged out.
- **H2 — Entry point: shell wrapper script.** Scheduler units do NOT call the node binary directly. They call `~/.claude-sop/bin/tick.sh` which:
  1. Sources a minimal env (PATH, HOME).
  2. Sets `CLAUDE_SOP_LEARNER=1` (the Phase 1 kill-switch).
  3. Acquires the per-project flock (see H4).
  4. Invokes the learner binary with absolute path.
  The wrapper lets us change what runs hourly without rewriting launchd/systemd units (which is fragile). Wrapper is written on `install` with the correct absolute paths baked in.
- **H3 — Cron fallback on Linux without systemd-user: install anyway with warning.** If `systemctl --user` is unavailable (rare but happens on some minimal distros or inside containers), installer writes a crontab entry via `crontab -l | { cat; echo '<entry>'; } | crontab -` and prints a yellow warning: "systemd user unit unavailable; using cron fallback. Reboot-persistence depends on your cron daemon config." Install does NOT abort.
- **H4 — Concurrency: per-project flock, not global.** Lock file at `/tmp/claude-sop-<hash12>.lock`. Hourly tick tries `flock -n` — on failure, logs "previous tick still running" to errors.jsonl and exits 0. Per-project (not global) because two different projects can legitimately tick at the same time.

### I — CLI Surface

- **I1 — Verb shape: flat verbs.** Commands are `claude-sop install`, `claude-sop status`, `claude-sop doctor`, `claude-sop pause`, `claude-sop resume`, `claude-sop purge`, `claude-sop uninstall`, `claude-sop errors` (from Phase 1 F2). No nested verbs like `claude-sop scheduler status` — if a command needs to inspect subsystems, flags do that (`status --scheduler-only`). Keeps discoverability flat and tab-completion shallow.
- **I2 — Output mode: human default + `--json` flag.** `status` defaults to a colorized human table (using a minimal ANSI helper — no heavy TUI dep). `--json` emits the same data as a stable JSON schema for scripting and for the `doctor` command to consume. All other commands have `--json` too.
- **I3 — `status` base fields:**
  - project id + slug + absolute path
  - hook wiring state (present/absent/stale)
  - scheduler state (installed/running/last-tick-time)
  - last learner run timestamp + exit status
  - pending capture count (turns since last learner run)
  - directive count (from managed section, via a read-only parse — Phase 4 writes it)
  - license state: `trial (N days left)` | `paid` | `expired` | `dev-key`
  - last-24h error count (from errors.jsonl, Phase 1 F2)
  - disk usage vs cap (Phase 1 F3)
- **I4 — Exit codes: rich.**
  - `0` success
  - `1` generic failure (current unknown error)
  - `2` misuse (bad flags, missing args, etc. — commander.js default)
  - `3` precondition failed (not installed, not a project, license expired, etc.)
  - Each command documents which codes it can return; `doctor` is the canonical source of "what does exit 3 mean right now."

### J — Uninstall

- **J1 — Default uninstall preserves captures; `--purge` wipes everything.** `claude-sop uninstall` removes hooks, scheduler unit, CLAUDE.md managed-section markers, and `~/.claude-sop/bin/tick.sh`, but leaves `<project>/.claude-sop/captures/` and `~/.claude/sop/<hash12>/` intact. `claude-sop uninstall --purge` additionally deletes the project capture dir, the global per-project dir, and `secrets.enc`.
- **J2 — Managed section handling on uninstall: backup before deletion.** Before stripping the markers from CLAUDE.md, the current managed-section content is copied to `~/.claude/sop/<hash12>/managed-history/uninstall-<ts>.md`. User can restore it manually after reinstall. The CLAUDE.md file itself is rewritten atomically (temp + rename) with the markers and everything between them removed; content outside the markers is byte-identical.
- **J3 — Error handling during uninstall: best-effort with summary.** If any step fails (e.g., scheduler unit can't be unloaded because launchd is in a weird state), uninstall continues with the next step and prints a summary at the end: `"Uninstall completed with 2 warnings: [list]"`. Exit code is `0` if zero failures, `1` otherwise. The user is never left in a "half-uninstalled" state that requires manual filesystem archaeology — the summary tells them exactly what to clean up by hand.
- **J4 — Secrets on uninstall: delete `secrets.enc`.** `uninstall` (with or without `--purge`) removes `~/.claude-sop/secrets.enc`. Rationale: the license key is tied to this install; reinstalling should re-prompt. No "forgot to clean up credentials" footgun.

### Claude's Discretion

- Exact `settings.json` merge algorithm (jsonc-parser to preserve comments, or strict JSON — planner decides after checking what Claude Code actually writes)
- nodejs CLI framework: `commander@14` already locked in stack; use it
- Color helper: `picocolors` (zero-dep) — planner confirms
- launchd plist / systemd unit templates (planner writes from scratch; research already surfaced exemplars)
- `doctor` check list expansion beyond the spec minimum (planner can add checks it thinks are valuable)

</decisions>

<specifics>
## Specific Ideas

- **Phase 2 is THE dogfood unlock.** After Phase 2 the user can run `npx claude-sop install` inside `~/.claude/dev-army/commander/` (or wherever the DEV ARMY agent home is) and see captures flow automatically, hourly tick register, and `status` report real state. Learner is still a no-op until Phase 3.
- **G1 is the critical path.** If the planner can't resolve the plugin-bundle-location question in research, Phase 2 cannot be planned. The planner MUST stop and surface the blocker back to the human rather than guessing.
- **License flow is the thinnest possible shim in Phase 2** — prompt, validate format, store encrypted, record trial-start timestamp. That's it. Everything else (validation, signing, grace period, subscription gating) is Phase 6.
- **Zero-network mandate still applies** — Phase 2 code paths must not make any network calls. Tests enforce via the same stub harness from Phase 0.

</specifics>

<deferred>
## Deferred Ideas

- **`recent` and `show` inspection verbs** — Phase 5.
- **License validation against real backend** — Phase 6.
- **Ed25519 signature verification of license responses** — Phase 6.
- **Node SEA binary build** — Phase 5 packaging / Phase 6 hardening.
- **Windows support** — never (v1 out-of-scope).
- **Service-level uninstall (stopping a daemon that's currently mid-tick)** — rejected; H4 flock handles it. Uninstall just waits for the in-flight tick or lets it error naturally.
- **Multi-project scheduler sharing (one launchd unit for all projects)** — rejected; each `install` registers its own project. Global aggregation happens through the Phase 1 D1 index.

</deferred>

---

*Phase: 02-installer-scheduler-cli*
*Context gathered: 2026-04-13*
