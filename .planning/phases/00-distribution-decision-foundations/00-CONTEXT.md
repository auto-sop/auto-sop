# Phase 0: Distribution Decision + Foundations - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Resolve the distribution-shape ADR and land the three pure-logic foundation libraries — **PathResolver**, **Config**, **Scrubber** — that every later phase depends on. Zero Claude Code runtime integration in this phase; zero network calls; everything fixture-testable.

**Scope additions surfaced during discussion** (feed into REQUIREMENTS.md + ROADMAP.md update after this context is committed):
- Commercial SaaS freemium product — 14-day trial → subscription via license API key
- Anti-reverse-engineering defense layers 1+2+3 (obfuscation + SEA binary + ed25519 signed server responses)
- New Phase 6 created for License + Distribution Security; Phase 2 grows to include API-key input during install

Those additions are CROSS-PHASE concerns. They are captured here as ADR decisions but implementation of the license client / subscription gate / SEA build pipeline belongs to Phase 6, not Phase 0.

</domain>

<decisions>
## Implementation Decisions

### A — Distribution Model (ADR)

- **Hybrid distribution.** Ship as BOTH a pure npm CLI package AND as a Claude Code Marketplace plugin entry. Developers can install either way:
  - `npx claude-sop install` — npm CLI path, copies the plugin bundle into place and wires hooks
  - Claude Code Marketplace — sideload path for users who prefer the marketplace UX
- **Plugin bundle lives as a Claude Code Marketplace entry** (not a freestanding sideload). The npm CLI's `install` command is responsible for orchestrating marketplace installation on the user's behalf.
- **Hook scope is project-local** — hooks are written to `<project>/.claude/settings.json`, never to `~/.claude/settings.json`. Each repo opts in independently.
- **Uninstall is total-within-scope.** `npx claude-sop uninstall` deletes every file, directory, hook entry, scheduler unit, keychain entry, and managed-section marker the plugin ever created — but never touches user-created files (including the user's own hooks, their CLAUDE.md content outside the managed markers, or their project files).

### B — Scrubber Rule Pack

- **Format: YAML.** Rule packs are authored in YAML for readability and comments; JSON parser is still available for internal use but user-facing rule files are YAML.
- **Baseline corpus: `secretlint` package.** Accept the ~30MB dependency cost to get battle-tested rule coverage (Anthropic keys, AWS, GitHub, Stripe, Slack, JWT, etc.) on day one rather than hand-curating. Treat secretlint as a rule-data source; the runtime regex engine is still our own (so we control the redaction output format).
- **Entropy threshold: STRICT (Shannon ≥ 4.5).** Minimize false-positive redactions that destroy learner context. Miss some high-entropy-but-unprefixed secrets — the learner can re-scan history when rules improve.
- **Redacted value format: `[REDACTED:a1b2]`** — `a1b2` is the first 4 hex chars of SHA-256(original secret). This lets the learner detect "same secret appeared twice" without ever leaking the secret or its length. Bonus: `a1b2` prefix doubles as a rule-debugging fingerprint.

### C — Config Storage

- **Secrets (license API key, optional alt-model key): `~/.claude-sop/secrets.enc`.** Encrypted file with a key derived from the user's machine-id + a per-install salt. NOT plain keychain — explicitly rejected because Keychain/libsecret parity across platforms is fragile and we want a single code path. Encryption is "good enough to stop casual filesystem inspection," not a cryptographic defense.
- **Config split: global defaults + per-project overrides.** `~/.claude-sop/config.json` carries defaults; `<project>/.claude-sop/config.json` overrides per-project. Project file wins where present.
- **Schema enforcement: FAIL LOUD on unknown keys.** Zod strict schema; typos error out with the expected key list. No silent "unknown, ignored" behavior.
- **First-run creation: auto-create on first `install`.** Config file and `secrets.enc` are both created during `npx claude-sop install` with defaults. No separate `config init` step.

### D — Project Identity (PathResolver)

- **Primary ID source hierarchy:**
  1. `git remote get-url origin` — normalized (lowercased, `.git` stripped), then `sha256[:12]`
  2. **Fallback:** `git rev-parse --show-toplevel` absolute path, then `sha256[:12]`
  3. **Last-resort fallback:** `process.cwd()` absolute path, then `sha256[:12]` (for non-git projects)
- **Human slug:** repo name if git; otherwise `basename(cwd)`. Stored in `project.json` for stability.
- **Directory naming:** `<hash12>` only — NO slug in the path. Privacy-leaning: an attacker browsing `~/.claude/sop/` can't tell which projects you've used claude-sop in. The slug lives only inside the per-project `project.json` for internal display.
- **Move/rename detection:** store `{remoteUrl, toplevel, cwd, projectId}` in `<project>/.claude-sop/project.json` at install time. On subsequent runs, if the remote/toplevel/cwd no longer match but the `project.json` is present, treat as a move and auto-migrate the global state directory from old `<hash12>` to new. Surface the migration in `status`.

### E — License & Anti-Reverse-Engineering (new, confirmed)

This entire area is cross-phase — Phase 0 documents the decisions; Phase 6 (new) implements them. Captured here because it changes Phase 2's installer (API-key prompt) and constrains Phase 0's Config design (must accommodate encrypted license storage from day one).

- **Commercial model:** freemium — 14-day trial, then subscription-gated.
- **License API key** is collected during `npx claude-sop install` via a prompt. Test/dev key for now: `123`. Real validation backend comes in Phase 6.
- **Trial countdown** runs locally against a tamper-resistant install timestamp (first-install time stored in `secrets.enc`, not editable via plain filesystem tools).
- **Offline grace period:** trial + paid users get N days (exact value TBD in Phase 6 planning — probably 7 days) of fully-offline operation before a license re-check is required. Phone-home is infrequent by design so the tool feels local-first.
- **Anti-reverse-engineering defense layers (accepted: 1 + 2 + 3):**
  1. **Code obfuscation** — `javascript-obfuscator` in the build pipeline. Variable renaming, control-flow flattening, string array encoding on the published bundle. Source-map-free production build.
  2. **Native bundle** — compile the CLI to a Single Executable Application via `node --experimental-sea-config` (preferred, official) or `pkg`/`nexe` (fallback). Published artifact is a binary, not raw JS in `node_modules/.bin/`.
  3. **Ed25519-signed server responses** — every license-validation response from the SaaS backend is signed with a server-side ed25519 private key. Client has the public key compiled into the binary and refuses to accept any license response that doesn't verify. Prevents a local attacker from intercepting and faking "license valid" responses.
  - **Layer 4 (runtime integrity/tamper detection) REJECTED** — high maintenance cost for marginal benefit; fragile; common false positives during legitimate Node updates.
  - **Layer 5 (server-side critical logic) REJECTED** — conflicts with local-first operation; learner must work during offline grace period; don't make the product dependent on always-online backend.
- **Network egress policy update:** the plugin may now phone home to the license backend for validation and subscription checks. All OTHER capture/learner traffic remains local-only. This is the ONLY network call the plugin itself makes (the `claude` CLI spawned by the learner is separate and already allowed).

### Phase 0 Build Order (locked)

1. Distribution ADR written to `.planning/phases/00-*/ADR-distribution.md` as the first deliverable.
2. **PathResolver** — pure lib, git-detection, hierarchy resolver, `project.json` writer, move detection. 100% unit-testable.
3. **Config** — Zod schemas (strict), global + project merger, `secrets.enc` reader/writer with machine-id-derived key, fail-loud validators.
4. **Scrubber** — layered engine: YAML rule loader → secretlint rule data → regex pipeline → Shannon entropy catch-all → `[REDACTED:sha4]` formatter. Fixture corpus with >95% recall gate.
5. **Test matrix:** Node 18.17 / 20.x / 22.x × macOS / Linux. CI green before phase closes.
6. **Engines + Windows refusal:** `engines.node ">=18.17"`, explicit Windows platform check that exits early with "Windows not supported in v1, use WSL."
7. **Zero postinstall:** package.json has NO `postinstall`, NO `preinstall`, NO `install` scripts. All state-changing work happens inside the explicit `npx claude-sop install` command.

### Claude's Discretion

- Exact machine-id derivation for `secrets.enc` encryption (likely `node-machine-id` package or hashed uid + hostname — planner picks)
- YAML parser choice (`yaml` vs `js-yaml` — planner picks; both are fine)
- `sha256[:12]` vs `sha256[:16]` — 12 is already collision-safe enough; planner keeps 12 unless research surfaces a reason
- Fixture corpus internal layout — planner picks (per-rule subdirs vs flat files)
- Test runner ergonomics and file naming

</decisions>

<specifics>
## Specific Ideas

- **Test license key is `123`** — hardcoded for now, replaced by real backend in Phase 6. Phase 0 Config must accept it as a valid format to not block development.
- **"Offline-first feel"** — even though we now phone home for license, the product MUST feel like a local tool. Infrequent validation, long grace periods, never block capture on network.
- **"Most people won't reverse engineer"** — the anti-RE layers target casual-to-moderate attackers, not nation-states. Don't over-engineer layer 4 (tamper detection).
- **Zero network egress during Phase 0 code paths** — even though Phase 6 adds license phone-home, Phase 0 unit tests must still prove zero network calls from PathResolver/Config/Scrubber code paths. License client is Phase 6 code.

</specifics>

<deferred>
## Deferred Ideas (out of Phase 0 scope)

- **License validation client** — Phase 6 (new, to be added to roadmap)
- **Ed25519 verification** — Phase 6
- **Trial countdown UI** — Phase 6
- **Subscription gate (what happens when trial ends)** — Phase 6 design decision
- **Obfuscation build pipeline** — Phase 6 (plus revisit `tsup` config in Phase 5 packaging)
- **SEA/pkg binary compile** — Phase 6
- **Backend API contract** — separate from this project entirely; captured as "assumed to exist" for Phase 6 planning
- **Rule pack v2 (user-authored rules)** — baseline secretlint is Phase 0; user-override layer lands later

## Cross-Phase Ripples (to handle after Phase 0 CONTEXT commit)

- Update **PROJECT.md**:
  - "Zero network egress" → "Zero network egress except license validation"
  - "Single-developer scope" → "Commercial SaaS freemium product for Claude Code developers"
  - Add license API key to Constraints
- Update **REQUIREMENTS.md**:
  - Add `LIC-01 .. LIC-10` new requirement category (license, trial, subscription, offline grace, anti-RE)
  - Update `INST-*` to include API key prompt during install
- Update **ROADMAP.md**:
  - Grow Phase 2 to include install-time API key prompt + trial-start
  - Add **Phase 6: License & Distribution Security** with all the LIC requirements
  - Update STATE.md for the new roadmap

</deferred>

---

*Phase: 00-distribution-decision-foundations*
*Context gathered: 2026-04-13*
