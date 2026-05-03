# CLAUDE.md

_Project-level instructions for Claude Code._

<!-- auto-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->

_Data as of: 2026-05-01T13:16:00Z · 611 turns analyzed · 10 agents: Explore, apex-security-auditor, architect-principal-engineer, code-improvement-analyzer, code-review-master-yoda, commander, general-purpose, jonathan-gsd-planner, main, prism-ux-tester_

**Transparency**: When you follow a directive from this section, briefly note which one.
Format: `[sop:applied:<id>]` — e.g., `[sop:applied:sop-7ced]`. One tag per directive applied.
Do not force-apply directives — only tag when a directive genuinely influenced your action.

**Planning gate**: Before creating implementation plans or making architectural decisions, read all directives below. Plans must respect these learned patterns — they exist because past sessions exposed real issues. Tag `[sop:applied:<id>]` in plan tasks when a directive influenced the decision.

**Learnings** (26 active directives)

- **[error]** NEVER run `npm publish` or `npm run build` for release from any branch other than `master`. The build system (`tsup.config.ts`) detects the git branch at build time — `dev` and `feat/*` branches produce staging URLs that get permanently baked into the compiled output. v0.1.0 was published with staging URLs because of this. Always: `git checkout master && npm run build && npm publish`. [sop:sop-publish-gate]
  _(evidence: 1 session)_

- **[error]** Before any production deployment to Vercel, verify all required environment variables are configured in the Vercel project. Compare local env vars against Vercel env vars and push any missing ones before deploying, not after discovering failures. [sop:sop-7de7]
  _(evidence: 3 sessions)_

- **[error]** For Next.js projects deployed on Vercel, never set framework to null or override buildCommand in vercel.json. Let Vercel auto-detect the framework. Remove any framework or buildCommand overrides that conflict with the actual project type. [sop:sop-f960]
  _(evidence: 3 sessions)_

- **[error]** When implementing cryptographic protocols that span client and server repos, define shared constants or a protocol spec document that both sides reference, and add a cross-repo integration test that validates parameter agreement before merging. [sop:sop-43a2]
  _(evidence: 3 sessions)_

- **[error]** The jonathan-gsd-planner agent must never use the Edit or Write tool on source code or infrastructure scripts. When a fix is identified during planning or investigation, document it in the plan and delegate execution to Architect or an executor agent. [sop:sop-38b4]
  _(evidence: 3 sessions)_

- **[warning]** Always use the dedicated Read, Grep, and Glob tools instead of Bash equivalents (cat, grep, ls, find) for file reading, content searching, and file listing. Reserve Bash for shell-only operations like running tests or build commands. [sop:sop-9ea9]
  _(evidence: 3 sessions)_

- **[warning]** When reading a source file for context, read it in one or two large chunks rather than many small sequential reads. Only use small offset/limit reads when targeting a known specific section. [sop:sop-e80c]
  _(evidence: 3 sessions)_

- **[warning]** Never add comments that describe WHAT a function does when the function name already conveys it. A helper named isFiniteNonNegative or isValidProject needs no docstring explaining it checks validity. [sop:sop-7987]
  _(evidence: 3 sessions)_

- **[warning]** Jonathan (planner) must NEVER deploy to production or execute infrastructure changes. Planning agents create plans only — deployment belongs to Commander or Architect. [sop:sop-b0b5]
  _(evidence: 3 sessions)_

- **[warning]** When implementing API endpoints that accept external input, always include from the start: input length limits, numeric range validation (reject NaN/Infinity/negatives), generic error messages for parse failures, and log output sanitization. [sop:sop-d7cb]
  _(evidence: 3 sessions)_

- **[warning]** Consider running a lightweight pre-implementation review step where YODA reviews the plan against project conventions before Architect implements, catching structural issues early instead of after full implementation. [sop:sop-3771]
  _(evidence: 3 sessions)_

- **[warning]** Before implementing new features, Architect must read 2-3 similar existing implementations in the codebase to identify project conventions (naming, error handling, structure) that automated checks like tests and tsc will not catch. [sop:sop-a453]
  _(evidence: 3 sessions)_

- **[warning]** Commander should trust Architect's test results within the same workflow dispatch. Only re-run tests if source files were modified after Architect's run, not as a routine verification step. [sop:sop-ea3e]
  _(evidence: 3 sessions)_

- **[warning]** When a subagent (including jonathan-gsd-planner) performs file exploration or reading, it must use Read, Glob, and Grep tools instead of shell equivalents like cat, ls, find, or for-loop iteration over file paths. Enforce this in agent prompts. [sop:sop-3196]
  _(evidence: 3 sessions)_

- **[warning]** When performing cross-project diagnostics that involve independent checks per project or per file, batch independent tool calls into parallel invocations rather than issuing them one at a time sequentially. [sop:sop-7d83]
  _(evidence: 3 sessions)_

- **[warning]** Never invoke grep or rg via Bash for code search. Always use the dedicated Grep tool, which has optimized permissions and output formatting. This applies to all agents including jonathan-gsd-planner. [sop:sop-4a4e]
  _(evidence: 3 sessions)_

- **[warning]** Use the Read tool to inspect JSON state files rather than Bash with embedded Python or jq scripts. The Read tool provides structured output without shell overhead and keeps file contents visible for analysis. [sop:sop-c7ba]
  _(evidence: 3 sessions)_

- **[warning]** When the jonathan-gsd-planner agent encounters an operational issue (e.g., metrics not updating, commands not producing expected results), it must document the symptom and recommend delegating to a debugger or executor agent rather than conducting the investigation itself. [sop:sop-d687]
  _(evidence: 3 sessions)_

- **[warning]** When jonathan-gsd-planner discovers an operational issue during planning, it must stop investigating after identifying the initial symptom, document it with reproduction steps, and recommend delegating to gsd-debugger or an executor agent. Do not conduct multi-turn root-cause analysis. [sop:sop-0dd4]
  _(evidence: 3 sessions)_

- **[warning]** In shell scripts that capture agent output, use direct file redirection with background tail instead of pipe-based tee. Pipes with tee can silently fail on macOS, causing complete output loss with no error signal. [sop:sop-1171]
  _(evidence: 3 sessions)_

- **[warning]** All agents must use the dedicated Grep tool for content search and Glob tool for file discovery. Never invoke grep, rg, or find via Bash. This rule applies to all agent types including code-review-master-yoda during review workflows. [sop:sop-5a29]
  _(evidence: 3 sessions)_

- **[warning]** Never modify CLAUDE.md directly for testing. Use git stash or a temporary branch to preserve the original, rather than creating manual backup files that may be forgotten or left behind. [sop:sop-5cb5]
  _(evidence: 3 sessions)_

- **[warning]** When checking if a file is tracked in a git commit, use a single definitive command like 'git ls-files' or 'git show HEAD:<path>' instead of iterating through multiple git status, diff, show, and log commands for the same file. One authoritative check replaces ten exploratory ones. [sop:sop-1b50]
  _(evidence: 3 sessions)_

- **[warning]** Before dispatching code for YODA review, ARCHITECT must self-check against common review failures: magic numbers in tests, unexported constants used cross-module, and incomplete error handling. A pre-review self-audit reduces costly rejection-and-redispatch cycles. [sop:sop-80c8]
  _(evidence: 3 sessions)_

- **[warning]** When requesting a UI audit of authenticated pages, either provide test credentials, a pre-authenticated session cookie, or instruct the agent to use the local dev server with auth bypassed — do not expect live site audit of protected routes without auth context [sop:sop-51b3]
  _(evidence: 3 sessions)_

- **[warning]** When spawning a subagent for project-specific work, always include the exact local project directory path in the prompt so the agent does not waste tool calls discovering it [sop:sop-cf46]
  _(evidence: 3 sessions)_

<!-- auto-sop:managed-section:end -->
