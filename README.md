<p align='center'>
  <img src='https://auto-sop.com/images/mascot/logo.webp' alt='auto-sop owl' width='100' />
</p>

<h1 align='center'>auto-sop</h1>

<p align='center'>
  <strong>Make Claude Code self-improving.</strong><br/>
  Auto-detect recurring mistakes · Generate enforced CLAUDE.md directives
</p>

<p align='center'>
  <a href='https://www.npmjs.com/package/auto-sop'><img src='https://img.shields.io/npm/v/auto-sop' alt='npm version'/></a>
  <a href='https://www.npmjs.com/package/auto-sop'><img src='https://img.shields.io/npm/dm/auto-sop' alt='npm downloads'/></a>
  <a href='./LICENSE'><img src='https://img.shields.io/badge/License-ELv2-blue.svg' alt='License: ELv2'/></a>
  <a href='https://nodejs.org'><img src='https://img.shields.io/badge/node-%3E%3D20-brightgreen' alt='Node.js'/></a>
</p>

<p align='center'>
  <a href='https://auto-sop.com/docs'>Documentation</a> ·
  <a href='https://auto-sop.com/dashboard'>Dashboard</a> ·
  <a href='https://auto-sop.com/docs/quickstart'>Quickstart</a>
</p>

<p align='center'>
  <a href='https://www.producthunt.com/products/auto-sop?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-auto-sop' target='_blank' rel='noopener noreferrer'><img src='https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1145178&theme=light' alt='auto-sop - Your Claude Code learns from its mistakes automatically | Product Hunt' width='250' height='54' /></a>
</p>

---

## What It Does

auto-sop captures every Claude Code interaction, detects recurring mistakes (3+ evidence threshold), and writes enforced directives to your project's `CLAUDE.md` — automatically. Zero manual upkeep. Claude Code reads these directives on every session, so the same mistake never happens again.

Beyond directives, auto-sop tracks **metrics** — confirmed directive fires, estimated token savings — and syncs aggregate stats to the [cloud dashboard](https://auto-sop.com/dashboard) so you can see your gains over time. The CLI also **self-updates** by checking the npm registry during learner runs, so you always run the latest version without manual upgrades.

## Install

```bash
npx auto-sop install
```

One command. Hooks, scheduler, and managed `CLAUDE.md` section are configured automatically.

Or via Homebrew:

```bash
brew install auto-sop/tap/auto-sop
```

## Quick Start

```bash
npx auto-sop install          # set up hooks + event-driven learner
# ... use Claude Code normally — captures happen silently ...
auto-sop learn-now            # trigger learning now (or wait for the automatic learner)
cat CLAUDE.md                 # directives appear in the managed section
```

## How It Works

```
  Claude Code hooks (PreToolUse / PostToolUse / Stop)
          |
          v
  +---------------+
  |   Hook Shim   |  <50ms overhead, double-fork
  |  (capture)    |
  +-------+-------+
          |  stdin JSON -> scrub secrets -> write atomically
          v
  +---------------+
  | Capture Store |  per-project, timestamped, lockfile-protected
  +-------+-------+
          |
          v
  +---------------+
  |    Learner    |  event-driven + daily sweep, or on-demand
  |               |  rule-based detectors (N>=3 evidence)
  |               |  + LLM analysis (claude -p, $0 via Max)
  +-------+-------+
          |  validated directives        |  aggregate stats
          v                              v
  +---------------+              +---------------+
  |  CLAUDE.md    |              |  Stats Sync   |
  |  Editor       |              |  → Cloud      |
  +---------------+              +-------+-------+
          |                              |
          v                              v
    Claude Code reads CLAUDE.md    Dashboard shows
    -> same mistake never again    gains over time
```

## Pricing

### Free (forever)

- **1 project**, unlimited directives
- Anonymous usage stats (no capture content — see [Privacy](https://auto-sop.com/docs/privacy))
- All CLI commands: `install`, `uninstall`, `status`, `learn-now`, `stats`, `doctor`, and more
- Uses your Claude Max subscription ($0 cost)

### Pro ($12/mo or $99/yr)

- Unlimited projects
- Full cloud sync
- Web dashboard
- Cross-machine directives
- Priority support
- No credit card on trial

### Earn Free Pro Trial Days

Not ready to pay? Earn Pro trial days for free:

- **Referral** — share your link, both you and your friend get +14 days
- **GitHub Star** — [star the repo](https://github.com/auto-sop/auto-sop) for +7 days (one-time)
- **Tweet / LinkedIn** — share about auto-sop for +3 days each (monthly)
- **CLAUDE.md Badge** — add the auto-sop badge for +7 trial days

See the full [Rewards documentation](https://auto-sop.com/docs/dashboard/rewards) for details.

## Self-Update

auto-sop keeps itself current automatically. The learner checks the npm registry for new versions during each run and installs updates in the background — no manual `npm install` needed after your initial setup. Run `auto-sop status` to see your current version at any time.

## Compatibility

| Requirement | Version |
| ----------- | ------- |
| Claude Code | >= 2.1.107 |
| Node.js | >= 20 |
| OS | macOS, Linux, Windows |

## Privacy

Captures **never** leave your machine — all analysis runs locally via your own Claude Max subscription. Anonymous aggregate stats (error rates, CLI command counts) are synced; no capture content is included. Pro cloud sync is opt-in and encrypted client-side (AES-256) before upload.

For full details, see our [Privacy Documentation](https://auto-sop.com/docs/privacy).

## Documentation

Full documentation is available at [auto-sop.com/docs](https://auto-sop.com/docs).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=auto-sop/auto-sop&type=Date)](https://star-history.com/#auto-sop/auto-sop&Date)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=auto-sop/auto-sop)](https://github.com/auto-sop/auto-sop/graphs/contributors)

## License

[Elastic License 2.0 (ELv2)](./LICENSE)
