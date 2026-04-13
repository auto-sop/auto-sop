---
phase: 00-distribution-decision-foundations
plan: 05b
type: execute
wave: 2
depends_on: ["00-05a"]
files_modified:
  - package.json
  - scripts/extract-secretlint-rules.ts
  - src/scrubber/baseline.generated.ts
  - src/scrubber/regex-pipeline.ts
  - src/scrubber/scrubber.ts
  - src/scrubber/index.ts
  - NOTICES.md
  - .github/workflows/ci.yml
  - test/scrubber/regex-pipeline.test.ts
  - test/scrubber/scrubber.test.ts
autonomous: true
requirements:
  - PRIV-01
  - PRIV-02
  - PRIV-03
  - PRIV-05

must_haves:
  truths:
    - "scripts/extract-secretlint-rules.ts consumes @secretlint/secretlint-rule-preset-recommend as a devDependency ONLY and emits src/scrubber/baseline.generated.ts containing `export const BASELINE_YAML = \\`...\\`;` — a TypeScript string constant, NOT a .yaml file on disk"
    - "At runtime, src/scrubber/scrubber.ts imports BASELINE_YAML as a module constant and parses it via the yaml-loader — no disk reads, no import.meta.url, no __dirname, works identically in ESM and CJS"
    - "The extractor is deterministic: running `npm run extract-rules` twice produces byte-identical src/scrubber/baseline.generated.ts"
    - "CI has a regeneration check step: runs the extractor and `git diff --exit-code src/scrubber/baseline.generated.ts` — the job fails if the committed file is out of sync with what the extractor produces"
    - "baseline.generated.ts yields a rule pack with at minimum: anthropic-api-key, aws-access-key-id, aws-secret-access-key, github-token, stripe-key, slack-token, jwt, env-assignment (with replacement preserving key name)"
    - "Scrubber.scrub(input) composes Stage 1 (path-exclusion) → Stage 2 (regex pipeline) → Stage 3 (entropy catch-all) → Stage 4 (redaction format via formatRedaction) and returns ScrubResult with accurate redactionsApplied count"
    - "User override packs (from ~/.claude-sop/rules/*.yaml) merge on TOP of the baseline without mutating baseline rules"
    - "NOTICES.md attributes the secretlint upstream (MIT, Copyright Takuto Wada / contributors) for any patterns derived from the preset"
    - "Zero runtime imports of @secretlint anywhere under src/ — only scripts/ may import it"
    - "No npm lifecycle scripts added (postinstall/preinstall/install/prepublish/prepublishOnly still forbidden per INST-07). The extractor is invoked via the `build` script composition, not via a lifecycle hook."
  artifacts:
    - path: "scripts/extract-secretlint-rules.ts"
      provides: "Build-time extractor; imports secretlint preset (devDep), emits src/scrubber/baseline.generated.ts as a TS string constant"
    - path: "src/scrubber/baseline.generated.ts"
      provides: "Generated file exporting `BASELINE_YAML` (TS string constant) — consumed at runtime, checked into git"
      exports: ["BASELINE_YAML"]
    - path: "src/scrubber/regex-pipeline.ts"
      provides: "Stage 2 — apply rule pack regexes in order, replacing matches with [REDACTED:<sha4>] (or rule.replacement if set)"
      exports: ["applyRegexPipeline"]
    - path: "src/scrubber/scrubber.ts"
      provides: "Scrubber class composing all 4 stages; createScrubber() loads BASELINE_YAML + optional user packs"
      exports: ["Scrubber", "createScrubber", "ScrubberOptions"]
    - path: "src/scrubber/index.ts"
      provides: "Public scrubber facade re-exporting Scrubber, createScrubber, loadRulePack, types"
      exports: ["Scrubber", "createScrubber", "loadRulePack", "Rule", "RulePack", "ScrubInput", "ScrubResult", "sha4", "formatRedaction", "shannonEntropy"]
    - path: "NOTICES.md"
      provides: "MIT attribution for upstream secretlint patterns"
  key_links:
    - from: "src/scrubber/scrubber.ts"
      to: "src/scrubber/baseline.generated.ts"
      via: "import { BASELINE_YAML } from './baseline.generated.js'"
      pattern: "BASELINE_YAML"
    - from: "src/scrubber/scrubber.ts"
      to: "src/scrubber/path-exclusion.ts → regex-pipeline.ts → entropy.ts → redaction.ts"
      via: "pipeline composition"
      pattern: "applyPathExclusion[\\s\\S]*applyRegexPipeline[\\s\\S]*applyEntropyCatchAll"
    - from: "scripts/extract-secretlint-rules.ts"
      to: "@secretlint/secretlint-rule-preset-recommend"
      via: "devDep import"
      pattern: "secretlint"
    - from: ".github/workflows/ci.yml"
      to: "src/scrubber/baseline.generated.ts"
      via: "regeneration check step (extract + git diff --exit-code)"
      pattern: "baseline.generated"
---

<objective>
Compose the scrubber primitives from Plan 00-05a into a working 4-stage pipeline, build the secretlint-driven baseline extractor, and lock in the "inline baseline as TS string constant" strategy so the runtime has zero filesystem dependence for its rule pack.

Purpose: CONTEXT.md B locks secretlint as a rule-data source and `yaml` (eemeli) as the runtime parser. This plan bridges those two decisions without introducing __dirname/import.meta.url fragility — by emitting the baseline as a TS module constant at build time. CI enforces that the committed generated file matches what the extractor produces.

Output: A working Scrubber pure library ready for Plan 00-06 to feed fixture corpora through and prove ≥95% recall.
</objective>

<execution_context>
@/Users/ugurgokdere/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ugurgokdere/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/00-distribution-decision-foundations/00-CONTEXT.md
@.planning/phases/00-distribution-decision-foundations/00-RESEARCH.md
@.planning/phases/00-distribution-decision-foundations/00-05a-PLAN.md
@test/setup/no-network.ts
@package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Build secretlint extractor + emit src/scrubber/baseline.generated.ts + NOTICES.md attribution + regeneration CI step</name>
  <files>
    package.json
    scripts/extract-secretlint-rules.ts
    src/scrubber/baseline.generated.ts
    NOTICES.md
    .github/workflows/ci.yml
  </files>
  <action>
    Step A — package.json edits:
    - devDependencies: add `@secretlint/secretlint-rule-preset-recommend@^9` and `tsx@^4` (to run the extractor without a separate compile step)
    - scripts: add `"extract-rules": "tsx scripts/extract-secretlint-rules.ts"`
    - Modify the existing `"build"` script from Plan 00-01 to compose the extractor BEFORE tsup: `"build": "npm run extract-rules && tsup"`
    - DO NOT add `prebuild` — that IS a lifecycle-adjacent name npm treats specially (`pre<script>`). Compose inside the build script string instead.
    - VERIFY after edit: `postinstall`, `preinstall`, `install`, `prepublish`, `prepublishOnly` are still absent. The Plan 00-01 CI `no-lifecycle-check` job must still pass unchanged.

    Step B — Create scripts/extract-secretlint-rules.ts.

    Locked strategy: the extractor writes src/scrubber/baseline.generated.ts — a TypeScript file exporting `BASELINE_YAML` as a template-literal string constant. This means zero disk reads at runtime and no ESM/CJS __dirname divergence.

    Implementation outline:
    ```ts
    import { writeFileSync } from 'node:fs';
    import { resolve } from 'node:path';

    // Attempt dynamic import of the secretlint preset. The preset's internal shape
    // varies across versions, so this is wrapped in try/catch. On failure, fall
    // back to a curated baseline and log a warning. Either way, NOTICES.md attributes
    // the upstream.
    async function extractRules(): Promise<string> {
      const rules: string[] = [];
      try {
        const preset = await import('@secretlint/secretlint-rule-preset-recommend');
        // Walk preset.default.rules (shape may vary) and pull { id, pattern } pairs
        // when directly accessible. When the pattern lives behind a closure, skip it
        // and rely on the curated fallback below for that category.
        // ... (executor: inspect the preset exports at dev time and extract what's feasible)
      } catch (err) {
        console.warn('[extract-rules] secretlint preset import failed:', (err as Error).message);
      }

      // CURATED BASELINE (always included; union with anything extracted above, dedup by id)
      const curated = `
      version: 1
      rules:
        - id: anthropic-api-key
          description: "Anthropic API key (sk-ant-*)"
          pattern: 'sk-ant-[A-Za-z0-9_\\\\-]{20,}'
          flags: 'g'
        - id: aws-access-key-id
          description: "AWS access key ID"
          pattern: 'AKIA[0-9A-Z]{16}'
          flags: 'g'
        - id: aws-secret-access-key
          description: "AWS secret access key (heuristic)"
          pattern: '(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])'
          flags: 'g'
        - id: github-token
          description: "GitHub personal access / OAuth token"
          pattern: 'gh[pousr]_[A-Za-z0-9]{36,}'
          flags: 'g'
        - id: gitlab-token
          description: "GitLab personal access token"
          pattern: 'glpat-[A-Za-z0-9_\\\\-]{20,}'
          flags: 'g'
        - id: slack-token
          description: "Slack bot/user token"
          pattern: 'xox[baprs]-[A-Za-z0-9-]{10,}'
          flags: 'g'
        - id: stripe-key
          description: "Stripe secret/publishable key"
          pattern: '(sk|pk|rk)_(test|live)_[A-Za-z0-9]{20,}'
          flags: 'g'
        - id: jwt
          description: "JWT (three base64url-encoded segments)"
          pattern: 'eyJ[A-Za-z0-9_\\\\-]+\\\\.eyJ[A-Za-z0-9_\\\\-]+\\\\.[A-Za-z0-9_\\\\-]+'
          flags: 'g'
        - id: env-assignment
          description: "Environment variable assignment (KEY=VALUE)"
          pattern: '(^|\\\\s)([A-Z_][A-Z0-9_]{2,})=([^\\\\s]+)'
          flags: 'gm'
          replacement: '$1$2=[REDACTED]'
      `.trim() + '\\n';

      return curated;
    }

    async function main() {
      const yaml = await extractRules();
      const out = resolve('src/scrubber/baseline.generated.ts');
      const banner = [
        '// AUTO-GENERATED by scripts/extract-secretlint-rules.ts — DO NOT EDIT BY HAND.',
        '// Regenerate with: npm run extract-rules',
        '// CI enforces that this file matches the extractor output (git diff --exit-code).',
        '',
        'export const BASELINE_YAML: string = `',
      ].join('\\n');
      const footer = '`;\\n';
      // Escape backticks and ${ inside the yaml
      const escaped = yaml.replace(/`/g, '\\\\`').replace(/\\$\\{/g, '\\\\${');
      writeFileSync(out, banner + escaped + footer, 'utf8');
      console.log(`[extract-rules] wrote ${out}`);
    }

    main().catch((e) => { console.error(e); process.exit(1); });
    ```

    Determinism rule: the extractor MUST be fully deterministic — no Date.now() in the output, no unordered iteration. Running it twice must produce byte-identical files.

    Step C — Create NOTICES.md with secretlint attribution:
    - Project name, MIT license reference
    - Attribution block: "Portions of src/scrubber/baseline.generated.ts are derived from or inspired by @secretlint/secretlint-rule-preset-recommend, Copyright (c) Takuto Wada and contributors, MIT License."
    - List each rule id and note whether it was extracted or curated

    Step D — Add a regeneration check step to .github/workflows/ci.yml. The file was created in Plan 00-01. APPEND a new job (or new step within an existing job) — do NOT remove or reorder the 5 jobs from Plan 00-01. Add:

    ```yaml
      baseline-regeneration-check:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: actions/setup-node@v4
            with: { node-version: '20' }
          - run: npm install --ignore-scripts
          - run: npm run extract-rules
          - name: Committed baseline.generated.ts must match extractor output
            run: |
              git diff --exit-code src/scrubber/baseline.generated.ts || {
                echo "FAIL: src/scrubber/baseline.generated.ts is out of sync with the extractor."
                echo "Run 'npm run extract-rules' locally and commit the result."
                exit 1
              }
    ```

    Step E — Run the extractor once locally (`npm run extract-rules`) and COMMIT the generated src/scrubber/baseline.generated.ts alongside this plan's other changes.

    AVOID: importing secretlint from anywhere under src/ (runtime-forbidden). Writing a .yaml file to disk (locked strategy is TS string constant). Adding a `postinstall`/`prebuild` script. Using Date.now() / random UUIDs in extractor output. Silently swallowing extractor failures — fail loud on write errors.
  </action>
  <verify>
    1. `npm run extract-rules` exits 0 and writes src/scrubber/baseline.generated.ts
    2. `grep "export const BASELINE_YAML" src/scrubber/baseline.generated.ts` matches
    3. `grep -E "anthropic-api-key|aws-access-key-id|github-token|env-assignment|jwt" src/scrubber/baseline.generated.ts | wc -l` ≥ 5
    4. `npm run extract-rules && git diff --exit-code src/scrubber/baseline.generated.ts` passes (determinism check)
    5. `grep -E '"(post|pre)?install"|"prepublish"' package.json` returns nothing
    6. `node -e "const s = require('./package.json').scripts; if (!s.build.includes('extract-rules')) process.exit(1)"` exits 0
    7. `grep -i "secretlint" NOTICES.md` matches
    8. `grep -r "from '@secretlint" src/` returns nothing (runtime import forbidden)
    9. `grep "baseline-regeneration-check" .github/workflows/ci.yml` matches
    10. `grep -c '^  [a-z-]+:$' .github/workflows/ci.yml` returns ≥ 6 (original 5 jobs + this one)
  </verify>
  <done>
    Extractor emits src/scrubber/baseline.generated.ts as a deterministic TS string constant. NOTICES.md attributes secretlint. CI has a baseline-regeneration-check job. No lifecycle scripts added. Zero runtime secretlint imports.
  </done>
</task>

<task type="auto">
  <name>Task 2: Regex pipeline + Scrubber class composing all 4 stages + index facade + integration tests</name>
  <files>
    src/scrubber/regex-pipeline.ts
    src/scrubber/scrubber.ts
    src/scrubber/index.ts
    test/scrubber/regex-pipeline.test.ts
    test/scrubber/scrubber.test.ts
  </files>
  <action>
    Create src/scrubber/regex-pipeline.ts (Stage 2):
    ```ts
    import type { Rule } from './types.js';
    import { formatRedaction } from './redaction.js';

    export function applyRegexPipeline(
      input: string,
      rules: Rule[],
    ): { output: string; replaced: number } {
      let output = input;
      let replaced = 0;
      for (const rule of rules) {
        const re = new RegExp(rule.pattern, rule.flags ?? 'g');
        if (rule.replacement !== undefined) {
          const replacement = rule.replacement;
          output = output.replace(re, (match, ...args) => {
            replaced++;
            // Use String.prototype.replace on the single matched substring to
            // resolve $1..$N tokens from `replacement` against the rule regex.
            return match.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), replacement);
          });
        } else {
          output = output.replace(re, (match) => {
            replaced++;
            return formatRedaction(match);
          });
        }
      }
      return { output, replaced };
    }
    ```

    Create src/scrubber/scrubber.ts (composition). CRITICAL: load baseline from `BASELINE_YAML` module constant. NO __dirname. NO import.meta.url. NO fs reads for the baseline.

    ```ts
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';
    import { parse } from 'yaml';
    import type { RulePack, ScrubInput, ScrubResult } from './types.js';
    import { rulePackSchema, loadRulePack } from './yaml-loader.js';
    import { applyPathExclusion } from './path-exclusion.js';
    import { applyRegexPipeline } from './regex-pipeline.js';
    import { applyEntropyCatchAll, ENTROPY_THRESHOLD, MIN_TOKEN_LEN } from './entropy.js';
    import { BASELINE_YAML } from './baseline.generated.js';

    export interface ScrubberOptions {
      baselinePack: RulePack;
      userPacks?: RulePack[];
      entropyThreshold?: number;
      minTokenLen?: number;
    }

    export class Scrubber {
      private readonly rules;
      private readonly entropyThreshold: number;
      private readonly minTokenLen: number;
      constructor(opts: ScrubberOptions) {
        this.rules = [
          ...opts.baselinePack.rules,
          ...(opts.userPacks ?? []).flatMap((p) => p.rules),
        ];
        this.entropyThreshold = opts.entropyThreshold ?? ENTROPY_THRESHOLD;
        this.minTokenLen = opts.minTokenLen ?? MIN_TOKEN_LEN;
      }

      scrub(input: ScrubInput): ScrubResult {
        const path = applyPathExclusion(input.payload, input.filePath);
        if (path.redacted) {
          return { scrubbed: path.output, redactionsApplied: 1, pathExcluded: true };
        }
        const regexed = applyRegexPipeline(path.output, this.rules);
        const entropic = applyEntropyCatchAll(regexed.output, this.entropyThreshold, this.minTokenLen);
        return {
          scrubbed: entropic.output,
          redactionsApplied: regexed.replaced + entropic.replaced,
          pathExcluded: false,
        };
      }
    }

    function parseBaseline(): RulePack {
      const doc = parse(BASELINE_YAML);
      return rulePackSchema.parse(doc);
    }

    export async function createScrubber(opts?: { userRulesDir?: string }): Promise<Scrubber> {
      const baseline = parseBaseline();
      const userPacks: RulePack[] = [];
      if (opts?.userRulesDir) {
        try {
          const entries = await fs.readdir(opts.userRulesDir);
          for (const entry of entries.sort()) {
            if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
              userPacks.push(await loadRulePack(join(opts.userRulesDir, entry)));
            }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      return new Scrubber({ baselinePack: baseline, userPacks });
    }
    ```

    Create src/scrubber/index.ts:
    ```ts
    export { Scrubber, createScrubber, type ScrubberOptions } from './scrubber.js';
    export { loadRulePack, rulePackSchema } from './yaml-loader.js';
    export type { Rule, RulePack, ScrubInput, ScrubResult } from './types.js';
    export { sha4, formatRedaction } from './redaction.js';
    export { shannonEntropy, ENTROPY_THRESHOLD, MIN_TOKEN_LEN } from './entropy.js';
    ```

    Create test/scrubber/regex-pipeline.test.ts:
    - Test 1: anthropic-api-key rule redacts 'sk-ant-abcdefghij1234567890XYZ' to '[REDACTED:<sha4>]'
    - Test 2: aws-access-key-id rule redacts 'AKIAIOSFODNN7EXAMPLE'
    - Test 3: github-token rule redacts 'ghp_abcdefghij1234567890ABCDEFGHIJ123456'
    - Test 4: env-assignment rule preserves key name: 'API_KEY=secret123' becomes 'API_KEY=[REDACTED]'
    - Test 5: jwt rule redacts a fixture JWT (eyJ...eyJ...sig)
    - Test 6: applyRegexPipeline returns total replaced count across multiple rules
    - Test 7: same secret produces same redaction output (deterministic)
    - Import test/setup/no-network.ts

    Create test/scrubber/scrubber.test.ts (full pipeline integration):
    - Test 1: scrub() with a sensitive file path short-circuits to '[REDACTED: sensitive path]' and pathExcluded=true
    - Test 2: scrub() applies BOTH regex stage AND entropy stage (use a payload containing both a known key and an unknown high-entropy token)
    - Test 3: scrub() with no matches returns input unchanged and redactionsApplied=0
    - Test 4: scrub() with a user-provided rule pack added on top redacts user rules AND baseline rules
    - Test 5: createScrubber({ userRulesDir }) loads from memfs and merges baseline + user rules (alphabetical order)
    - Test 6: createScrubber() with missing userRulesDir does NOT throw
    - Test 7: createScrubber() with no opts still works (baseline-only) — proves BASELINE_YAML is importable as a module constant and no filesystem access is needed for the baseline
    - Test 8: an Anthropic key embedded in a larger JSON payload is redacted but surrounding context is preserved
    - Import test/setup/no-network.ts

    AVOID: importing BASELINE_YAML path from disk, using __dirname or import.meta.url for the baseline, importing secretlint at runtime, hand-coding any patterns in regex-pipeline.ts (they come from the rule pack), throwing on missing userRulesDir.
  </action>
  <verify>
    1. `npx vitest run test/scrubber/regex-pipeline.test.ts test/scrubber/scrubber.test.ts` passes ≥15 tests
    2. `npx tsc --noEmit` passes
    3. `grep "from './baseline.generated" src/scrubber/scrubber.ts` matches
    4. `grep -E "__dirname|import\\.meta\\.url" src/scrubber/scrubber.ts` returns nothing
    5. `grep "applyPathExclusion" src/scrubber/scrubber.ts && grep "applyRegexPipeline" src/scrubber/scrubber.ts && grep "applyEntropyCatchAll" src/scrubber/scrubber.ts` all match
    6. `npm run build` succeeds end-to-end (extract-rules → tsup)
    7. `grep -r "from '@secretlint" src/` returns nothing
  </verify>
  <done>
    Regex pipeline with rule.replacement support implemented. Scrubber class composes all 4 stages, imports BASELINE_YAML as a module constant (no disk, no __dirname), createScrubber() merges baseline + optional user packs. ≥15 tests pass. `npm run build` green.
  </done>
</task>

</tasks>

<verification>
- `npm test -- test/scrubber/` runs all primitive AND pipeline tests green (≥40 tests total across 6 files when combined with 00-05a)
- `npx tsc --noEmit` passes
- `npm run build` runs the extractor then tsup successfully
- `npm run extract-rules && git diff --exit-code src/scrubber/baseline.generated.ts` is clean (determinism proven locally)
- `grep -r "from '@secretlint" src/` returns nothing (runtime free of secretlint)
- `grep -rE "__dirname|import\\.meta\\.url" src/scrubber/` returns nothing
- NOTICES.md has secretlint attribution
- No npm lifecycle scripts added
- Same secret → same [REDACTED:sha4] output (deterministic)
</verification>

<success_criteria>
- PRIV-01 (Phase 0 portion): Scrubber pure library exists and is callable BEFORE any capture writer (Phase 1) is built
- PRIV-02 (Phase 0 portion): baseline.generated.ts yields rules covering anthropic, aws, github, gitlab, slack, stripe, jwt, env-assignment patterns; entropy catch-all handles unprefixed high-entropy secrets
- PRIV-03 satisfied: layered rule loading (baseline + user override pack from ~/.claude-sop/rules/*.yaml), alphabetically ordered
- PRIV-05 satisfied for Scrubber: zero network calls in any code path, asserted by no-network harness
- Plan 00-06 can now build the fixture corpus and run the recall gate against this scrubber (via `createScrubber()` with no opts)
</success_criteria>

<output>
After completion, create `.planning/phases/00-distribution-decision-foundations/00-05b-SUMMARY.md` listing the 4 pipeline stages, the BASELINE_YAML module constant strategy, the extractor decision (curated + secretlint attribution), the CI regeneration check, and the test count.
</output>
</content>
</invoke>
</invoke>