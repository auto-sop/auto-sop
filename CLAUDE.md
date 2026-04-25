# CLAUDE.md

_Project-level instructions for Claude Code._

<!-- auto-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->

_Data as of: 2026-04-25T19:38:00Z · 180 turns analyzed · 8 agents: Explore, apex-security-auditor, architect-principal-engineer, code-improvement-analyzer, code-review-master-yoda, commander, jonathan-gsd-planner, main_

**Learnings** (20 active directives)

- **[warning]** Never exclude failing tests to unblock a commit. If a test fails, first verify whether it fails on the base branch. If it is a pre-existing flaky test, create a tracking issue or add a skip annotation with a TODO before proceeding — do not silently drop it from the test command.
  _(evidence: 3 sessions)_

- **[warning]** When resetting a learner cursor to epoch, always document the root cause of why it got stuck. Resetting without root cause analysis masks underlying issues and leads to repeated resets across projects.
  _(evidence: 3 sessions)_

- **[warning]** Before running auto-sop ticks or checking learner output for any project, first verify three prerequisites: hooks are installed, the captures directory exists and contains data, and the project is registered in the project registry.
  _(evidence: 3 sessions)_

- **[warning]** Before starting a debugging session, form a hypothesis about the most likely root cause and check it first. Limit exploratory tool calls to 5 before stopping to reassess the approach rather than chaining incremental checks.
  _(evidence: 3 sessions)_

- **[warning]** When a tick completes successfully but produces no recap output, check in this order: (1) captures directory has data, (2) learner cursor points to unprocessed captures, (3) recap log path matches what the tick writes to. Do not re-run the tick until these are verified.
  _(evidence: 3 sessions)_

- **[warning]** Always verify plan completion status by checking both the plans directory structure and recent git history, since plan file moves and git commits can fall out of sync.
  _(evidence: 3 sessions)_

- **[warning]** Always run build and test suite after creating new files or editing multiple modules before considering the task complete. Never leave a turn with code changes unverified.
  _(evidence: 3 sessions)_

- **[warning]** Always quote glob patterns passed to vitest --exclude to prevent shell expansion (e.g., --exclude 'test/integration/**'). Use a space separator, not equals sign, before the quoted glob.
  _(evidence: 3 sessions)_

- **[warning]** Never use hardcoded numeric limits for data loading or processing bounds. Define shared constants in a single location and import them wherever the same limit applies.
  _(evidence: 3 sessions)_

- **[info]** Run test suites in the foreground when their output is needed immediately. Only use background execution with proper wait mechanisms when genuine parallelism is required.
  _(evidence: 3 sessions)_

- **[info]** Prefer a single scripted deploy command over manual build-copy-verify sequences for distributing plugin artifacts to the marketplace directory.
  _(evidence: 3 sessions)_

- **[info]** After discovering a stuck or stale cursor in one project, immediately check all registered projects for the same issue rather than discovering them one at a time in separate turns.
  _(evidence: 3 sessions)_

- **[info]** When inspecting auto-sop learner state across multiple projects, combine hook checks, directive counts, and cursor positions into a single consolidated inspection script rather than running separate passes.
  _(evidence: 3 sessions)_

- **[info]** Before adding a new bug entry to the roadmap, verify the ID prefix matches the established convention and check for ID conflicts with existing entries.
  _(evidence: 3 sessions)_

- **[info]** Before dispatching an architect agent, ensure the prompt includes sufficient context and a clear deliverable so the agent can take action rather than producing an empty turn.
  _(evidence: 3 sessions)_

- **[info]** When modifying interfaces or adding fields to types, update all related test assertions in the same editing pass before running the test suite, rather than discovering mismatches at test runtime.
  _(evidence: 3 sessions)_

- **[info]** When planning multi-step feature work across the learner and directive subsystems, consolidate related changes into fewer sessions to avoid redundant context-gathering reads of the same core module set.
  _(evidence: 3 sessions)_

- **[info]** When extracting helpers into a shared module, replace the original inline code with clean imports. Do not leave behind comments narrating what was removed or where it moved.
  _(evidence: 3 sessions)_

- **[info]** When dispatching multiple review agents against the same file set, stagger execution so later agents can consume earlier agents' findings rather than duplicating file reads and analysis.
  _(evidence: 3 sessions)_

- **[info]** Batch TodoWrite updates within a single turn — update the full todo list once after completing a logical group of tasks rather than after each individual step.
  _(evidence: 3 sessions)_

<!-- auto-sop:managed-section:end -->
