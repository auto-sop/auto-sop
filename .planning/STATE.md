# STATE: auto-sop

**Last updated:** 2026-05-02

## Project Reference

- **Name:** auto-sop
- **Core Value:** Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically.
- **Current Focus:** Phase 9 — First Public Launch (v61-v63 queued)

## Current Position

- **Phase 0–8:** ALL COMPLETE ✓ (v1-v60 shipped)
- **Phase 9:** IN PROGRESS — 3 plans queued:
  - **v61** 🔜 Post-launch hardening (8 tasks, site repo)
  - **v62** 🔜 Mintlify docs at auto-sop.com/docs (4 tasks, site repo)
  - **v63** 🔜 Public release 0.1.0 — repo split + npm publish + Homebrew (14 tasks, CLI repo)
- **Phase 10:** Viral growth + marketing (post-launch)
- **Phase 11:** Smart directive targeting (post-launch)
- **Progress:** `[#########-]` 9/11 phases complete

## Plan Queue

| Status | Plan | Repo | Tasks |
|--------|------|------|-------|
| 🔜 queued | v61 — Post-launch hardening | auto-sop-site | 8 parallel + quality gates |
| 🔜 queued | v62 — Mintlify docs | auto-sop-site | 3 parallel + 1 sequential + quality gates |
| 🔜 queued | v63 — Public release 0.1.0 | auto-sop (CLI) | 3 parallel + quality gates + 7 sequential release ops |
| ✅ done | v53–v60 | both | 8 plans completed |

## Key Metrics

- CLI version: 0.0.66 (→ 0.1.0 in v63)
- Total plans executed: v1-v60 (60 versions)
- Active directives (auto-sop project): 25
- Turns analyzed: 611+
- Live platform stats: 2.9M+ tokens saved, 5+ directive fires

## Promotion Pending

| Repo | Branch | Behind | What's pending |
|------|--------|--------|---------------|
| auto-sop (CLI) | dev → master | 6 commits (v52-v58) | User promotes before v63 npm publish |
| auto-sop-site | dev → main | Multiple commits (v50-v60) | User promotes after v61/v62 |

## Accumulated Context

### Key Decisions (Recent)

- **Distribution model (v63):** Private `auto-sop-cli` repo (full source) + public `auto-sop` repo (curated, proprietary modules stubbed). npm publishes compiled dist from private repo. ELv2 license.
- **Docs platform:** Mintlify at auto-sop.com/docs (v62). Vercel rewrite proxies to Mintlify CDN.
- **Privacy stance:** Captures never leave machine. User's own Claude does learning. Cloud only gets first 10 words of each directive + aggregate statistics.
- **BeforeAfter section rewrite (v61):** Replace fake terminal with honest workflow visualization showing observe → detect → write → prevent flow.

### Open Questions / Todos

- Mintlify subdomain needed for Vercel rewrite (v62 Task 4) — check Mintlify dashboard
- npm login required before v63 npm publish
- Connect auto-sop-site GitHub repo to Mintlify dashboard before v62

### Blockers

None.

## Session Continuity

- **Last session:** 2026-05-02
- **Next action:** Start army on v61 (site hardening), or v63 (CLI release) — they're independent
- **Resume hint:** v61/v62 are site-only, v63 is CLI-only. All three plans are in `plans/queued/`. v61's PLAN.md is at project root. v62/v63 need to be copied to PLAN.md when their turn comes.

---
*State initialized: 2026-04-13*
