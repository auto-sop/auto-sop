# ADR-0001: Distribution Model — Hybrid npm CLI + Claude Code Marketplace Plugin

Status: Accepted
Date: 2026-04-13
Deciders: project owner, claude-sop planning agent

## Context and Problem Statement

claude-sop must be installable by Claude Code developers through familiar channels. Two viable distribution channels exist today: the **npm registry** (universal, `npx`-friendly, supports install-time orchestration code) and the **Claude Code Marketplace** (native `/plugin install` UX, auto-discovery, plugin lifecycle management).

Choosing only one channel excludes a meaningful user segment. npm-only misses developers who expect the marketplace `/plugin install` workflow. Marketplace-only is a non-starter because marketplace plugins are passive — they cannot execute install-time code, and claude-sop requires install-time orchestration to write project-scoped hooks, create config/secrets files, and (in Phase 6) prompt for a license API key.

The distribution model must also accommodate Phase 6's plan to compile the CLI to a Node Single Executable Application (SEA) binary. Whatever shape we choose now must remain valid when the published artifact is a binary, not raw JS in `node_modules/.bin/`.

## Decision Drivers

- **npm UX expectation:** Developers on npm workflows expect `npx claude-sop install` to work out of the box
- **Marketplace UX expectation:** Developers on Claude Code expect `/plugin install` UX for discovering and managing tools
- **Install-time code requirement:** We need to run code during install to write project-scoped hooks and (Phase 6) prompt for a license API key — marketplace plugins cannot do this; they are passive bundles
- **Single source of truth:** Both channels must serve the same artifact — no divergent codebases, no version drift between npm and marketplace
- **INST-07 zero-postinstall constraint:** The npm package must have NO `postinstall`, `preinstall`, or `install` scripts; all state-changing work happens inside the explicit `npx claude-sop install` command
- **Hook scope project-local only:** Hooks are written to `<project>/.claude/settings.json`, never to `~/.claude/settings.json`; each repo opts in independently
- **Total-within-scope uninstall:** `npx claude-sop uninstall` must remove every artifact the tool ever created without touching user-created files

## Considered Options

### Option 1: npm-only CLI

Distribute exclusively via npm. Users run `npx claude-sop install` to set up hooks and config. No marketplace presence at all.

- **Pro:** Simplest implementation; single distribution channel; full control over install-time orchestration
- **Pro:** Zero dependency on Claude Code marketplace mechanics
- **Con:** Invisible to developers who browse the marketplace for tools
- **Con:** No auto-update via marketplace lifecycle; users must re-run `npx claude-sop install` manually after `npm update`

### Option 2: Marketplace plugin only

Distribute exclusively as a Claude Code Marketplace plugin. Users discover and install via `/plugin install`.

- **Pro:** Native Claude Code UX; auto-discovery; managed update lifecycle
- **Con:** **Blocking:** Marketplace plugins are passive bundles — they cannot execute install-time code. We cannot prompt for a license key, write project-scoped hooks dynamically, or run any orchestration logic during install
- **Con:** Requires the entire tool to fit within the plugin bundle constraints (hooks.json, skills, agents) with no escape hatch for CLI commands

### Option 3: Hybrid — one channel points to the other

Publish a marketplace plugin entry that tells users "run `npx claude-sop install`" or vice versa. One channel is the real distribution; the other is a signpost.

- **Pro:** Both segments see something; npm remains the real source
- **Con:** Poor UX — marketplace users expect `/plugin install` to work, not a "go run this npm command" redirect
- **Con:** The signpost plugin provides no actual functionality, creating confusion about what "installed" means

### Option 4: Hybrid — npm package ships the plugin bundle; CLI orchestrates registration

The npm package contains the full plugin bundle. On `npx claude-sop install`, the CLI copies the bundle into a local marketplace directory, registers it with Claude Code, installs the plugin, writes project-scoped hooks, and creates config/secrets files. Users who prefer marketplace discovery can add a hosted marketplace entry that uses the `npm` source type to pull the same package.

- **Pro:** Single source of truth (npm package); both user segments addressed
- **Pro:** Install-time code can prompt, validate, write hooks, and explain
- **Pro:** Marketplace plugin inherits from the same bundle (no drift)
- **Pro:** The `npm` plugin source type in marketplace.json means Claude Code can `npm install` the package itself
- **Con:** More moving parts than npm-only
- **Con:** Uninstall must clean both the local marketplace registration AND project settings
- **Con:** Requires a Phase 2 spike to verify Claude Code's orchestration mechanics work programmatically

## Decision Outcome

**Chosen: Option 4 — Hybrid, plugin bundle shipped inside the npm package.**

The npm CLI is the orchestrator. On `npx claude-sop install`, the CLI performs the following steps:

1. Writes a local marketplace directory under `~/.claude-sop/marketplace/` containing the plugin bundle and a `marketplace.json` catalog
2. Registers the marketplace with Claude Code (mechanism TBD — see Open Questions)
3. Installs the plugin via the registered marketplace entry
4. Writes project-scoped hooks to `<project>/.claude/settings.json`
5. Creates `~/.claude-sop/config.json`, `~/.claude-sop/secrets.enc`, and `<project>/.claude-sop/project.json` anchor

**Initial implementation strategy (per research recommendation):** Prefer **Path 1** — publish a tiny GitHub-hosted `marketplace.json` at a dedicated repository (e.g., `claude-sop/marketplace`) with source type `npm`:

```json
{
  "name": "claude-sop-marketplace",
  "owner": { "name": "claude-sop" },
  "plugins": [
    {
      "name": "claude-sop",
      "source": { "source": "npm", "package": "claude-sop" },
      "description": "SOP capture + learner for Claude Code"
    }
  ]
}
```

This avoids shelling into interactive slash commands entirely. The npm CLI's `install` command then has a focused job: project-scoped hook wiring + config/secrets creation + license prompt (Phase 6). The plugin bundle and marketplace entry are a separate, declarative artifact.

**We do not commit to the orchestration code path in this ADR.** The exact mechanism for registering the marketplace and installing the plugin programmatically is deferred to the Phase 2 spike (see Open Questions).

## Consequences

### Good

- **Single source of truth:** The npm package is the canonical artifact; the marketplace entry points back to it via the `npm` source type — zero divergence risk
- **Both user segments addressed:** npm developers use `npx claude-sop install`; marketplace developers use `/plugin marketplace add` + `/plugin install`
- **Install-time code execution:** The CLI can prompt for license keys (Phase 6), validate environments, write hooks, and provide interactive guidance — none of which is possible with a passive marketplace plugin
- **Marketplace inheritance:** The plugin bundle served through the marketplace is the same code that ships in the npm package — no separate build, no version drift
- **Phase 6 SEA compatibility:** The distribution shape (npm CLI as orchestrator + declarative marketplace entry) remains valid when the CLI is compiled to a Node SEA binary; the binary replaces `npx claude-sop` but the marketplace.json continues pointing at the npm package for the plugin bundle

### Bad

- **More moving parts:** Hybrid distribution requires maintaining both the npm package AND the marketplace.json repository/entry, plus the plugin bundle layout within the npm package
- **Uninstall complexity:** `npx claude-sop uninstall` must clean up artifacts in three locations: `<project>/.claude/settings.json` hooks, `<project>/.claude-sop/` project config, and `~/.claude-sop/` global state (marketplace, config, secrets)
- **Phase 2 spike required:** The orchestration mechanics (how the CLI registers the marketplace and triggers plugin install programmatically) are unverified and may require workarounds if Claude Code's slash commands don't support non-interactive invocation
- **User confusion potential:** Two install paths exist; documentation must clearly explain that both lead to the same result and that `npx claude-sop install` is the recommended path

## Confirmation

**Phase 2 acceptance test:** On a fresh machine:

1. Run `npx claude-sop install` in a project directory
2. Verify the plugin appears in Claude Code's `/plugin` list
3. Verify `<project>/.claude/settings.json` contains the claude-sop hook configuration
4. Verify `~/.claude-sop/config.json` and `~/.claude-sop/secrets.enc` exist with valid defaults
5. Run `npx claude-sop uninstall`
6. Verify the plugin no longer appears in Claude Code's `/plugin` list
7. Verify `<project>/.claude/settings.json` no longer contains claude-sop hooks
8. Verify `~/.claude-sop/` state is cleaned up (marketplace, config, secrets)
9. Verify user-created files (their own hooks, CLAUDE.md content outside managed markers) are untouched

## Open Questions

The following questions are tracked for the **Phase 2 installer spike**:

- **Q1 — Marketplace orchestration mechanism:** Can `claude /plugin marketplace add <path>` run non-interactively from a child process (via `execa`)? If not, is there a programmatic API or settings.json key that achieves the same result? This is the single biggest unresolved question — if neither path works, we fall back to instructing the user to run the marketplace commands manually.

- **Q2 — Settings.json marketplace key:** Is there a settings.json key (e.g., `extraKnownMarketplaces`) that allows pre-registering marketplace sources without shelling out to `claude` CLI? Direct file mutation would be more reliable than process orchestration.

- **Q3 — Plugin update propagation:** When we use the `npm` plugin source type in `marketplace.json`, does Claude Code auto-update the plugin on `npm publish`? Or does the user need to run `/plugin marketplace update` + `/plugin install` again? This affects our upgrade story and user communication.

- **Q4 — Project-local hook stacking:** How do project-local hooks in `<project>/.claude/settings.json` interact with plugin-provided `hooks/hooks.json`? Do they stack (both fire), does one override the other, or is the behavior undefined? This determines whether we can rely on both hook sources coexisting.

- **Q5 — Plugin hook scope:** Can a plugin's hooks be scoped per-project, or are plugin hooks always global-to-the-plugin (firing in every project where the plugin is active)? If global, we may need to duplicate hook logic in both the plugin bundle and the project-local settings.

- **Q6 — Plugin cache wipe semantics:** What happens to `${CLAUDE_PLUGIN_ROOT}` on plugin update? If Claude Code wipes the plugin cache directory on update, any state stored there is lost. This affects where we store plugin-managed files and whether the plugin bundle can carry mutable state.

## Cross-Phase Notes

- **INST-07 (zero postinstall):** The npm package has NO `postinstall`, `preinstall`, or `install` scripts. All state-changing work — hook writing, config creation, marketplace registration, license prompt — happens inside the explicit `npx claude-sop install` command. Users who `npm install claude-sop` get a passive package with no side effects.

- **INST-08 (macOS + Linux only):** Windows is not supported in v1. The CLI performs a platform check at startup and exits with a clear message: "Windows is not supported in v1. Please use WSL." The library layer (PathResolver, Config, Scrubber) remains side-effect-free and platform-agnostic in its pure logic, but the CLI commands refuse to execute on Windows.

- **Phase 6 SEA binary compatibility:** Phase 6 will compile the CLI to a Node Single Executable Application (SEA) binary. The ADR's distribution shape must remain valid for a binary artifact. The marketplace.json `npm` source type points at the npm package (which contains the plugin bundle); the binary replaces `npx claude-sop` as the CLI entry point but does not affect the marketplace entry.

- **Phase 6 license prompt:** The license API key prompt happens during `npx claude-sop install` (Phase 2 implementation). The key is stored encrypted in `~/.claude-sop/secrets.enc` per the Config storage decision (CONTEXT.md C). Phase 0 reserves the `license` namespace in the Config schema but does not populate it.

---

**References:**

- [Claude Code: Create Plugins](https://code.claude.com/docs/en/plugins) — Plugin bundle structure, plugin.json manifest schema, hooks.json format
- [Claude Code: Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) — Marketplace catalog format, source types (npm, github, url, git-subdir, relative path), install flow
- [MADR 4.0 Templates](https://github.com/adr/madr/tree/4.0.0/template) — Architectural Decision Record template used for this document
- Phase 0 plan reference: `.planning/phases/00-distribution-decision-foundations/00-02-PLAN.md`
