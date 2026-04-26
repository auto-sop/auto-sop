# CLAUDE.md

_Project-level instructions for Claude Code._

<!-- auto-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->

_Data as of: 2026-04-26T17:56:00Z · 309 turns analyzed · 9 agents: Explore, apex-security-auditor, architect-principal-engineer, code-improvement-analyzer, code-review-master-yoda, commander, general-purpose, jonathan-gsd-planner, main_
_AI analysis: First batch analysis of 5 turns across architect and jonathan agents. Main findings: a variable rename done via ~10 individual edits instead of replace_all, test fixtures not updated alongside production code changes causing predictable test failures, and a shell script edited extensively with syntax validation deferred to the very end._

**Learnings** (25 active directives)

- **[warning]** Always verify plan completion status by checking both the plans directory structure and recent git history, since plan file moves and git commits can fall out of sync.
  _(evidence: 3 sessions)_

- **[warning]** Always run build and test suite after creating new files or editing multiple modules before considering the task complete. Never leave a turn with code changes unverified.
  _(evidence: 3 sessions)_

- **[warning]** Always quote glob patterns passed to vitest --exclude to prevent shell expansion (e.g., --exclude 'test/integration/**'). Use a space separator, not equals sign, before the quoted glob.
  _(evidence: 3 sessions)_

- **[warning]** Never use hardcoded numeric limits for data loading or processing bounds. Define shared constants in a single location and import them wherever the same limit applies.
  _(evidence: 3 sessions)_

- **[warning]** Always use the Read tool with offset and limit parameters to read portions of files. Never use Bash with cat, head, or tail to read file contents — the Read tool provides a better experience and avoids unnecessary shell invocations.
  _(evidence: 3 sessions)_

- **[warning]** Always use the dedicated Grep tool for content search instead of running grep or rg via Bash. The Grep tool is optimized for correct permissions and access. Reserve Bash for shell-only operations that have no dedicated tool equivalent.
  _(evidence: 3 sessions)_

- **[warning]** When exploring an unfamiliar CLI tool's capabilities, prefer Read and Grep on its source code over repeated Bash invocations. Limit exploratory Bash calls to 3 before switching to source-reading.
  _(evidence: 3 sessions)_

- **[warning]** Before guessing CLI commands, always read the project's source code (CLI entry point, command registration files) or documentation to understand available commands. Never try more than 2 command variations without reading source.
  _(evidence: 3 sessions)_

- **[warning]** Jonathan agents must never edit source files, commit, or push code. Jonathan creates plans in plans/queued/ only. All code execution, commits, and pushes are Commander's responsibility.
  _(evidence: 3 sessions)_

- **[warning]** Never push directly to main. Always create a feature branch and open a pull request, even for small changes like config file updates, to preserve review history.
  _(evidence: 3 sessions)_

- **[warning]** Define clear success criteria for auto-sop plugin installation (e.g., specific file or hook that must exist) so agents can verify in one step and stop retrying once the check passes.
  _(evidence: 3 sessions)_

- **[warning]** Document the canonical install command for the auto-sop plugin in the project README or CLAUDE.md so agents do not resort to trial-and-error guessing across multiple invocation styles.
  _(evidence: 3 sessions)_

- **[warning]** Always use the Read tool instead of Bash cat/head/tail for reading files, and Glob instead of Bash ls/find for listing or finding files. Reserve Bash for operations that have no dedicated tool equivalent.
  _(evidence: 3 sessions)_

- **[warning]** Avoid empty agent turns that produce no tool calls or outputs. If the agent has nothing actionable to do in a turn, it should either complete its task or clearly state what it is blocked on.
  _(evidence: 3 sessions)_

- **[warning]** Before guessing CLI flag syntax, read the relevant CLI verb source file to determine supported flags and their positions. Never trial-and-error flag combinations via repeated Bash calls.
  _(evidence: 3 sessions)_

- **[warning]** Always use the Glob tool for file pattern matching instead of running find commands via Bash. Glob is faster, safer, and provides better output formatting.
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
  _(evidence: 124 sessions · [view turns](.auto-sop/captures/N2HkHVOsBUz9))_

<!-- auto-sop:managed-section:end -->
