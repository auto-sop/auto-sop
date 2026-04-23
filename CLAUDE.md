# CLAUDE.md

_Project-level instructions for Claude Code._

<!-- auto-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->

_Data as of: 2026-04-23T10:42:00Z · 97 turns analyzed · 8 agents: Explore, apex-security-auditor, architect-principal-engineer, code-improvement-analyzer, code-review-master-yoda, commander, jonathan-gsd-planner, main_
_AI analysis: Three pattern candidates found across 5 turns. The most actionable is the flaky test exclusion workaround (warning severity) which risks masking real failures by silently dropping a test from the run. The other two are efficiency improvements around deployment automation and test execution strategy._

**Learnings** (3 active directives)

- **[warning]** Never exclude failing tests to unblock a commit. If a test fails, first verify whether it fails on the base branch. If it is a pre-existing flaky test, create a tracking issue or add a skip annotation with a TODO before proceeding — do not silently drop it from the test command.
  _(evidence: 38 sessions · [view turns](.auto-sop/captures/KEUTT_LT_i-L))_

- **[info]** Run test suites in the foreground when their output is needed immediately. Only use background execution with proper wait mechanisms when genuine parallelism is required.
  _(evidence: 38 sessions · [view turns](.auto-sop/captures/KEUTT_LT_i-L))_

- **[info]** Prefer a single scripted deploy command over manual build-copy-verify sequences for distributing plugin artifacts to the marketplace directory.
  _(evidence: 38 sessions · [view turns](.auto-sop/captures/okOIgsINEaX4))_

<!-- auto-sop:managed-section:end -->
