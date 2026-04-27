# CLAUDE.md

_Project-level instructions for Claude Code._

<!-- auto-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->

_Data as of: 2026-04-26T22:29:00Z · 394 turns analyzed · 9 agents: Explore, apex-security-auditor, architect-principal-engineer, code-improvement-analyzer, code-review-master-yoda, commander, general-purpose, jonathan-gsd-planner, main_

**Learnings** (25 active directives)

- **[error]** Before any production deployment to Vercel, verify all required environment variables are configured in the Vercel project. Compare local env vars against Vercel env vars and push any missing ones before deploying, not after discovering failures.
  _(evidence: 3 sessions)_

- **[error]** For Next.js projects deployed on Vercel, never set framework to null or override buildCommand in vercel.json. Let Vercel auto-detect the framework. Remove any framework or buildCommand overrides that conflict with the actual project type.
  _(evidence: 3 sessions)_

- **[warning]** When an Explore agent needs to understand a file, read it in chunks of at least 100-200 lines rather than repeatedly reading 5-15 line fragments at scattered offsets. If the file is under 1000 lines, read it in full on the first pass.
  _(evidence: 3 sessions)_

- **[warning]** Explore agents should target fewer than 30 tool calls per investigation. Before issuing a new read of a file already visited, check if the needed content was already retrieved in a prior read. Plan reads upfront rather than incrementally discovering adjacent lines.
  _(evidence: 3 sessions)_

- **[warning]** Before increasing timeouts to fix deadline misses, investigate why the operation is slow. Increasing timeouts should be a last resort after confirming the operation genuinely requires more time, not a workaround for undiagnosed performance issues.
  _(evidence: 3 sessions)_

- **[warning]** Jonathan (planner agent) must not directly edit code or scripts. When Jonathan discovers a bug during planning, it should document the bug and fix approach in a plan, then hand off to Commander or Architect for execution.
  _(evidence: 3 sessions)_

- **[warning]** Always use the Glob tool for file discovery and listing directory contents. Never use Bash with find or ls for locating files by pattern — Glob is purpose-built for this and avoids unnecessary shell invocations.
  _(evidence: 3 sessions)_

- **[warning]** Before writing a new file, fully plan its contents including all imports, types, and edge cases. Never write a file expecting to immediately rewrite it in the same turn — get it right on the first pass.
  _(evidence: 3 sessions)_

- **[warning]** Do not add multi-line JSDoc comment blocks to new files. Default to no comments, and if a comment is needed, keep it to one short line. Module-level doc blocks describing what the file does are redundant when file and function names are descriptive.
  _(evidence: 3 sessions)_

- **[warning]** When modifying plans, decide on scope changes before editing the file. Do not add content to a plan and then immediately revert it in the same turn — evaluate cross-repo scope implications before making any edits.
  _(evidence: 3 sessions)_

- **[warning]** When renaming a variable or identifier across a single file, use the Edit tool with replace_all=true in one call instead of making many individual edit calls for each occurrence.
  _(evidence: 3 sessions)_

- **[warning]** Before spawning a code-improvement-analyzer agent, check if another analyzer is already running on the same file set. Never run duplicate analysis agents on identical files in the same review cycle.
  _(evidence: 3 sessions)_

- **[warning]** When editing shell scripts from an agent, always verify tool parameters are fully populated before invocation. Run a syntax check immediately after each edit, not only at the end.
  _(evidence: 3 sessions)_

- **[warning]** When modifying exported symbols or function signatures in source files, always update corresponding test mocks and fixtures in the same editing pass before running the test suite.
  _(evidence: 3 sessions)_

- **[warning]** Before deploying to production, run a pre-flight checklist: verify framework detection settings, confirm all environment variables are synced, ensure build config is correct, and check that non-deployment files are excluded. Fix all issues before the first deploy rather than iterating through multiple failed deployments.
  _(evidence: 3 sessions)_

- **[warning]** When initializing a Vercel-deployed project that has internal or planning directories, create a .vercelignore file early to exclude non-deployment directories like planning files, tool configs, and internal metadata.
  _(evidence: 3 sessions)_

- **[warning]** The planner agent should focus on research, discussion, and plan creation. Deployment operations, infrastructure debugging, and environment configuration should be handled by the commander or architect agents with appropriate ops tooling.
  _(evidence: 3 sessions)_

- **[warning]** Never use arbitrary sleep delays to wait for Vercel deployments. Instead, use the Vercel CLI or API to poll deployment status, or use the Monitor tool to watch for completion.
  _(evidence: 3 sessions)_

- **[warning]** Planner agents must only produce plan documents. Never allow a planner agent to make Edit calls to source or component files — delegate implementation to executor or architect agents.
  _(evidence: 3 sessions)_

- **[warning]** Always use the dedicated Read, Glob, and Grep tools for file reading and searching. Never use cat, find, or grep via Bash when a built-in tool can accomplish the same task.
  _(evidence: 3 sessions)_

- **[warning]** Before issuing a Glob call, check if the same pattern and path combination was already called in the current session. Cache and reuse prior Glob results instead of re-querying.
  _(evidence: 3 sessions)_

- **[warning]** Before launching a code-improvement-analyzer agent, verify that the same review scope has not already been run in the current session to avoid duplicate reviews consuming resources.
  _(evidence: 3 sessions)_

- **[warning]** Never make test or exploratory HTTP requests to arbitrary domains during a security audit. WebFetch should only be used when checking a specific security-relevant endpoint or fetching vulnerability reference data.
  _(evidence: 3 sessions)_

- **[warning]** Security auditor agents must stay scoped to the codebase under review. Never explore unrelated directories like messaging inboxes or external agent communication channels during a security audit.
  _(evidence: 3 sessions)_

- **[warning]** When dispatching independent quality gate reviews (security audit, code improvement analysis), run them in parallel rather than sequentially to reduce total pipeline duration.
  _(evidence: 3 sessions)_

<!-- auto-sop:managed-section:end -->
