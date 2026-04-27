# CLAUDE.md

_Project-level instructions for Claude Code._

<!-- auto-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->

_Data as of: 2026-04-27T20:02:00Z · 473 turns analyzed · 9 agents: Explore, apex-security-auditor, architect-principal-engineer, code-improvement-analyzer, code-review-master-yoda, commander, general-purpose, jonathan-gsd-planner, main_

**Learnings** (25 active directives)

- **[error]** Before any production deployment to Vercel, verify all required environment variables are configured in the Vercel project. Compare local env vars against Vercel env vars and push any missing ones before deploying, not after discovering failures.
  _(evidence: 3 sessions)_

- **[error]** For Next.js projects deployed on Vercel, never set framework to null or override buildCommand in vercel.json. Let Vercel auto-detect the framework. Remove any framework or buildCommand overrides that conflict with the actual project type.
  _(evidence: 3 sessions)_

- **[error]** When implementing cryptographic protocols that span client and server repos, define shared constants or a protocol spec document that both sides reference, and add a cross-repo integration test that validates parameter agreement before merging.
  _(evidence: 3 sessions)_

- **[warning]** Security auditor agents must stay scoped to the codebase under review. Never explore unrelated directories like messaging inboxes or external agent communication channels during a security audit.
  _(evidence: 3 sessions)_

- **[warning]** When dispatching independent quality gate reviews (security audit, code improvement analysis), run them in parallel rather than sequentially to reduce total pipeline duration.
  _(evidence: 3 sessions)_

- **[warning]** Never create throwaway e2e test scripts in temp directories. Add them as proper test files in the project test suite so they run in CI and catch regressions automatically.
  _(evidence: 3 sessions)_

- **[warning]** The jonathan-gsd-planner agent must only produce plans and roadmap updates. Source code edits, test modifications, builds, commits, and pushes must be delegated to the appropriate executor or architect agent.
  _(evidence: 3 sessions)_

- **[warning]** Always confirm with the user before running git push, especially when the committing agent is operating outside its designated role boundaries.
  _(evidence: 3 sessions)_

- **[warning]** Derive expected test values from source constants rather than hardcoding magic numbers. When a key format or encoding changes, tests that derive expected lengths from the format will fail with clear messages instead of requiring manual grep hunts.
  _(evidence: 3 sessions)_

- **[warning]** When investigating an unfamiliar area of the codebase that will require more than 3 search queries, delegate to an Explore agent immediately rather than doing extensive manual grep exploration first and then delegating anyway.
  _(evidence: 3 sessions)_

- **[warning]** Always use the dedicated Grep tool for content search and Glob tool for file discovery. Never invoke grep, rg, or find via Bash — the dedicated tools have optimized permissions and output formatting.
  _(evidence: 3 sessions)_

- **[warning]** Never read the full contents of environment files containing secrets. Use Grep to check for specific key names or Bash grep -c to count entries without exposing secret values in agent context.
  _(evidence: 3 sessions)_

- **[warning]** Always use the dedicated Read, Grep, and Glob tools instead of Bash equivalents (cat, grep, ls, find) for file reading, content searching, and file listing. Reserve Bash for shell-only operations like running tests or build commands.
  _(evidence: 3 sessions)_

- **[warning]** When reading a source file for context, read it in one or two large chunks rather than many small sequential reads. Only use small offset/limit reads when targeting a known specific section.
  _(evidence: 3 sessions)_

- **[warning]** Never add comments that describe WHAT a function does when the function name already conveys it. A helper named isFiniteNonNegative or isValidProject needs no docstring explaining it checks validity.
  _(evidence: 3 sessions)_

- **[warning]** Jonathan (planner) must NEVER deploy to production or execute infrastructure changes. Planning agents create plans only — deployment belongs to Commander or Architect.
  _(evidence: 3 sessions)_

- **[warning]** When implementing API endpoints that accept external input, always include from the start: input length limits, numeric range validation (reject NaN/Infinity/negatives), generic error messages for parse failures, and log output sanitization.
  _(evidence: 3 sessions)_

- **[warning]** Consider running a lightweight pre-implementation review step where YODA reviews the plan against project conventions before Architect implements, catching structural issues early instead of after full implementation.
  _(evidence: 3 sessions)_

- **[warning]** Before implementing new features, Architect must read 2-3 similar existing implementations in the codebase to identify project conventions (naming, error handling, structure) that automated checks like tests and tsc will not catch.
  _(evidence: 3 sessions)_

- **[warning]** Commander should trust Architect's test results within the same workflow dispatch. Only re-run tests if source files were modified after Architect's run, not as a routine verification step.
  _(evidence: 3 sessions)_

- **[warning]** When a subagent (including jonathan-gsd-planner) performs file exploration or reading, it must use Read, Glob, and Grep tools instead of shell equivalents like cat, ls, find, or for-loop iteration over file paths. Enforce this in agent prompts.
  _(evidence: 3 sessions)_

- **[warning]** When performing cross-project diagnostics that involve independent checks per project or per file, batch independent tool calls into parallel invocations rather than issuing them one at a time sequentially.
  _(evidence: 3 sessions)_

- **[warning]** Never invoke grep or rg via Bash for code search. Always use the dedicated Grep tool, which has optimized permissions and output formatting. This applies to all agents including jonathan-gsd-planner.
  _(evidence: 3 sessions)_

- **[warning]** Use the Read tool to inspect JSON state files rather than Bash with embedded Python or jq scripts. The Read tool provides structured output without shell overhead and keeps file contents visible for analysis.
  _(evidence: 3 sessions)_

- **[warning]** When the jonathan-gsd-planner agent encounters an operational issue (e.g., metrics not updating, commands not producing expected results), it must document the symptom and recommend delegating to a debugger or executor agent rather than conducting the investigation itself.
  _(evidence: 3 sessions)_

<!-- auto-sop:managed-section:end -->
