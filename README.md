[![CI](https://github.com/auto-sop/auto-sop/actions/workflows/ci.yml/badge.svg)](https://github.com/auto-sop/auto-sop/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/auto-sop)](https://www.npmjs.com/package/auto-sop)
[![npm downloads](https://img.shields.io/npm/dm/auto-sop)](https://www.npmjs.com/package/auto-sop)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)](https://nodejs.org)

# auto-sop

**Claude Code never makes the same mistake twice.**

auto-sop captures every Claude Code interaction, detects recurring mistakes, and writes enforced directives to your project's `CLAUDE.md` — automatically. Zero manual upkeep.

> **See it in action:** _demo GIF coming soon — install → recap --run → tail CLAUDE.md → directives appear_

---

## Install

```bash
npx auto-sop install
```

One command. Hooks, scheduler, and managed `CLAUDE.md` section are configured automatically.

Or via Homebrew (macOS/Linux):

```bash
brew install auto-sop/tap/auto-sop
```

## Quick Start

```bash
npx auto-sop install          # set up hooks + hourly learner
# ... use Claude Code normally — captures happen silently ...
auto-sop recap --run           # trigger learning now (or wait for the hourly scheduler)
cat CLAUDE.md                  # directives appear in the managed section
```

## How It Works

```
  Claude Code hooks (PreToolUse / PostToolUse / Stop)
          │
          ▼
  ┌───────────────┐
  │   Hook Shim   │  <50ms overhead, double-fork
  │  (capture)    │
  └───────┬───────┘
          │  stdin JSON → scrub secrets → write atomically
          ▼
  ┌───────────────┐
  │ Capture Store │  per-project, timestamped, lockfile-protected
  └───────┬───────┘
          │
          ▼
  ┌───────────────┐
  │    Learner    │  hourly (launchd/systemd) or on-demand
  │               │  rule-based detectors (N≥3 evidence)
  │               │  + LLM analysis (claude -p, $0 via Max)
  └───────┬───────┘
          │  validated directives
          ▼
  ┌───────────────┐
  │  CLAUDE.md    │  managed section: hash-checked, git-aware,
  │  Editor       │  revertible, TTL pruning, drift detection
  └───────────────┘
          │
          ▼
    Claude Code reads CLAUDE.md on every session
    → same mistake never happens again
```

## Pricing

### Free (forever)

- **1 project**, unlimited directives
- Full local capture + LLM analysis (uses your Claude Max subscription, $0 cost)
- All CLI verbs: `install`, `uninstall`, `status`, `recap`, `recent`, `show`, `learn-now`, `revert`
- Apache 2.0 open source

### Pro (coming with auto-sop-cloud, v23+)

- Unlimited projects
- Opt-in encrypted cloud sync
- Curated directive packs (framework, language, team)
- Cross-project pattern detection
- Web dashboard
- No credit card on trial

> Pro tier coming with cloud features. **CLI is free forever for solo use, Apache 2.0.**

## Privacy

Captures **never** leave your machine on the Free tier. All analysis runs locally via your own Claude Max subscription.

Pro cloud sync is opt-in and encrypted client-side (AES-256) before upload. The cloud never sees raw captures.

## Compatibility

| Requirement | Version |
|-------------|---------|
| Claude Code | >= 2.1.107 |
| Node.js | >= 18.17 |
| OS | macOS, Linux |
| Windows | Phase 6 (planned) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=auto-sop/auto-sop&type=Date)](https://star-history.com/#auto-sop/auto-sop&Date)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=auto-sop/auto-sop)](https://github.com/auto-sop/auto-sop/graphs/contributors)

## License

[Apache License 2.0](./LICENSE)


