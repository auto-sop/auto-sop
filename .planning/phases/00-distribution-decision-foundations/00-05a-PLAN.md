---
phase: 00-distribution-decision-foundations
plan: 05a
type: execute
wave: 2
depends_on: ["00-01"]
files_modified:
  - src/scrubber/types.ts
  - src/scrubber/yaml-loader.ts
  - src/scrubber/path-exclusion.ts
  - src/scrubber/entropy.ts
  - src/scrubber/redaction.ts
  - test/scrubber/yaml-loader.test.ts
  - test/scrubber/path-exclusion.test.ts
  - test/scrubber/entropy.test.ts
  - test/scrubber/redaction.test.ts
autonomous: true
requirements:
  - PRIV-03
  - PRIV-05

must_haves:
  truths:
    - "YAML rule pack loader uses `yaml` (eemeli) and validates rule packs against a strict Zod schema; unknown keys are rejected"
    - "Each loaded rule's regex source is validated (new RegExp compiles) before the pack is returned — invalid regex throws with the rule id in the error"
    - "Path-exclusion stage skips documented sensitive path patterns (**/.env*, **/*.pem, **/id_rsa*, **/*secret*, **/credentials*, **/*.key) by returning a redacted placeholder payload"
    - "Entropy stage uses Shannon entropy with ENTROPY_THRESHOLD = 4.5 and MIN_TOKEN_LEN = 20 per CONTEXT.md decision B"
    - "Redaction format is exactly `[REDACTED:<sha4>]` where sha4 is the first 4 hex chars of SHA-256(original secret); same secret always produces the same tag"
    - "All scrubber primitive test files import test/setup/no-network.ts and zero network calls occur"
  artifacts:
    - path: "src/scrubber/types.ts"
      provides: "Rule, RulePack, ScrubInput, ScrubResult types"
    - path: "src/scrubber/yaml-loader.ts"
      provides: "loadRulePack(path) using yaml (eemeli) — validates against rule pack schema"
      exports: ["loadRulePack", "rulePackSchema"]
    - path: "src/scrubber/path-exclusion.ts"
      provides: "Stage 1 — redact whole payload if tool_input.file_path matches sensitive globs"
      exports: ["isSensitivePath", "applyPathExclusion"]
    - path: "src/scrubber/entropy.ts"
      provides: "Stage 3 — Shannon entropy catch-all with ENTROPY_THRESHOLD=4.5"
      exports: ["shannonEntropy", "applyEntropyCatchAll", "ENTROPY_THRESHOLD", "MIN_TOKEN_LEN"]
    - path: "src/scrubber/redaction.ts"
      provides: "sha4 fingerprint + format helper"
      exports: ["sha4", "formatRedaction"]
  key_links:
    - from: "src/scrubber/yaml-loader.ts"
      to: "yaml package (eemeli)"
      via: "import { parse } from 'yaml'"
      pattern: "from 'yaml'"
    - from: "src/scrubber/redaction.ts"
      to: "node:crypto sha256"
      via: "createHash('sha256')"
      pattern: "createHash"
    - from: "src/scrubber/entropy.ts"
      to: "src/scrubber/redaction.ts"
      via: "formatRedaction call for high-entropy tokens"
      pattern: "formatRedaction"
---

<objective>
Build the scrubber PRIMITIVES: types, YAML rule pack loader (strict Zod), path-exclusion stage, Shannon entropy stage, and the sha4 redaction formatter — plus their unit tests. This is the first of two scrubber plans; Plan 00-05b builds the pipeline that composes these primitives plus the secretlint baseline extractor.

Purpose: Splitting the scrubber into primitives (this plan) and pipeline/extractor (00-05b) keeps each plan within the ~50% context budget. This plan delivers pure, decoupled stages that 00-05b can wire together and that 00-06 can fixture-test for recall.

Output: Four independently tested scrubber primitive modules + types, ready for 00-05b to compose into the Scrubber class.
</objective>

<execution_context>
@/Users/ugurgokdere/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ugurgokdere/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/00-distribution-decision-foundations/00-CONTEXT.md
@.planning/phases/00-distribution-decision-foundations/00-RESEARCH.md
@test/setup/no-network.ts
@package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Types, YAML loader, and path-exclusion stage + their tests</name>
  <files>
    src/scrubber/types.ts
    src/scrubber/yaml-loader.ts
    src/scrubber/path-exclusion.ts
    test/scrubber/yaml-loader.test.ts
    test/scrubber/path-exclusion.test.ts
  </files>
  <action>
    Create src/scrubber/types.ts:
    ```ts
    export interface Rule {
      id: string;
      description: string;
      pattern: string;        // regex source
      flags?: string;         // regex flags, default 'g'
      replacement?: string;   // optional special replacement (e.g. env-assignment keeps key name)
    }

    export interface RulePack {
      version: 1;
      rules: Rule[];
    }

    export interface ScrubInput {
      payload: string;
      filePath?: string;      // optional tool_input.file_path used by path-exclusion stage
    }

    export interface ScrubResult {
      scrubbed: string;
      redactionsApplied: number;
      pathExcluded: boolean;
    }
    ```

    Create src/scrubber/yaml-loader.ts using `yaml` (eemeli) per CONTEXT B:
    ```ts
    import { promises as fs } from 'node:fs';
    import { parse } from 'yaml';
    import { z } from 'zod';
    import type { RulePack } from './types.js';

    export const rulePackSchema = z.object({
      version: z.literal(1),
      rules: z.array(z.object({
        id: z.string().min(1),
        description: z.string(),
        pattern: z.string().min(1),
        flags: z.string().optional(),
        replacement: z.string().optional(),
      }).strict()),
    }).strict();

    export async function loadRulePack(path: string): Promise<RulePack> {
      const raw = await fs.readFile(path, 'utf8');
      const doc = parse(raw);
      const validated = rulePackSchema.parse(doc);
      for (const r of validated.rules) {
        try { new RegExp(r.pattern, r.flags ?? 'g'); }
        catch (e) {
          throw new Error(`Rule "${r.id}" has invalid regex: ${(e as Error).message}`);
        }
      }
      return validated;
    }
    ```

    Create src/scrubber/path-exclusion.ts:
    ```ts
    const SENSITIVE_PATH_PATTERNS: RegExp[] = [
      /(^|\/)\.env(\..+)?$/,
      /\.pem$/,
      /(^|\/)id_rsa(\.\w+)?$/,
      /(^|\/)id_ed25519(\.\w+)?$/,
      /secret/i,
      /credentials?/i,
      /\.key$/,
    ];

    export function isSensitivePath(filePath: string | undefined): boolean {
      if (!filePath) return false;
      return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath));
    }

    export function applyPathExclusion(payload: string, filePath?: string): { redacted: boolean; output: string } {
      if (isSensitivePath(filePath)) {
        return { redacted: true, output: '[REDACTED: sensitive path]' };
      }
      return { redacted: false, output: payload };
    }
    ```

    Create test/scrubber/yaml-loader.test.ts (use memfs to write fixture YAML):
    - Test 1: Valid YAML rule pack parses and returns RulePack with version 1
    - Test 2: Unknown top-level key in YAML throws (strict)
    - Test 3: Unknown key inside a rule throws (inner strict)
    - Test 4: Invalid regex pattern throws "invalid regex" with rule id
    - Test 5: Empty rules array is allowed
    - Import test/setup/no-network.ts

    Create test/scrubber/path-exclusion.test.ts:
    - Test 1: '.env' triggers exclusion
    - Test 2: 'config/.env.production' triggers exclusion
    - Test 3: 'private.pem' triggers exclusion
    - Test 4: '~/.ssh/id_rsa' triggers exclusion
    - Test 5: 'src/secrets.ts' triggers exclusion
    - Test 6: 'src/index.ts' does NOT trigger exclusion
    - Test 7: undefined filePath returns redacted: false unchanged
    - Test 8: applyPathExclusion replaces entire payload with '[REDACTED: sensitive path]' when matched
    - Import test/setup/no-network.ts

    AVOID: using js-yaml. Importing any src/config or src/path-resolver code. Relaxing strictness on the schema.
  </action>
  <verify>
    1. `npx vitest run test/scrubber/yaml-loader.test.ts test/scrubber/path-exclusion.test.ts` passes ≥13 tests
    2. `npx tsc --noEmit` passes
    3. `grep "from 'yaml'" src/scrubber/yaml-loader.ts` matches
    4. `grep "js-yaml" package.json` returns nothing
    5. `grep -r "from '\.\./config" src/scrubber/` returns nothing
  </verify>
  <done>
    Types, YAML loader (strict Zod + regex compile check), and path-exclusion stage implemented with ≥13 passing tests under no-network harness.
  </done>
</task>

<task type="auto">
  <name>Task 2: Entropy stage + redaction formatter + their tests</name>
  <files>
    src/scrubber/entropy.ts
    src/scrubber/redaction.ts
    test/scrubber/entropy.test.ts
    test/scrubber/redaction.test.ts
  </files>
  <action>
    Create src/scrubber/redaction.ts:
    ```ts
    import { createHash } from 'node:crypto';

    export function sha4(secret: string): string {
      return createHash('sha256').update(secret).digest('hex').slice(0, 4);
    }

    export function formatRedaction(secret: string): string {
      return `[REDACTED:${sha4(secret)}]`;
    }
    ```

    Create src/scrubber/entropy.ts (Shannon entropy catch-all):
    ```ts
    import { formatRedaction } from './redaction.js';

    export const ENTROPY_THRESHOLD = 4.5;
    export const MIN_TOKEN_LEN = 20;

    export function shannonEntropy(s: string): number {
      if (s.length === 0) return 0;
      const freq = new Map<string, number>();
      for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
      let h = 0;
      const n = s.length;
      for (const count of freq.values()) {
        const p = count / n;
        h -= p * Math.log2(p);
      }
      return h;
    }

    export function applyEntropyCatchAll(
      input: string,
      threshold: number = ENTROPY_THRESHOLD,
      minLen: number = MIN_TOKEN_LEN,
    ): { output: string; replaced: number } {
      let replaced = 0;
      const output = input.replace(/[A-Za-z0-9+/=_\-]{20,}/g, (token) => {
        if (token.length < minLen) return token;
        if (shannonEntropy(token) >= threshold) {
          replaced++;
          return formatRedaction(token);
        }
        return token;
      });
      return { output, replaced };
    }
    ```

    Create test/scrubber/redaction.test.ts:
    - Test 1: sha4('hello') is exactly 4 hex chars
    - Test 2: sha4 is deterministic — sha4('foo') === sha4('foo')
    - Test 3: formatRedaction('sk-ant-12345') returns '[REDACTED:' + first 4 hex chars + ']'
    - Test 4: Same secret produces identical formatted output across calls
    - Import test/setup/no-network.ts

    Create test/scrubber/entropy.test.ts:
    - Test 1: shannonEntropy('') === 0
    - Test 2: shannonEntropy('aaaaaa') ≈ 0
    - Test 3: shannonEntropy('abcdefghijklmnopqrstuvwxyz0123456789') > 4.5
    - Test 4: applyEntropyCatchAll redacts a 32-char base64 token
    - Test 5: applyEntropyCatchAll leaves a 19-char (below MIN_TOKEN_LEN) token alone
    - Test 6: applyEntropyCatchAll leaves 'aaaaaaaaaaaaaaaaaaaaaaaa' alone (low entropy)
    - Test 7: applyEntropyCatchAll returns count of replacements
    - Test 8: ENTROPY_THRESHOLD is exactly 4.5
    - Import test/setup/no-network.ts

    AVOID: importing src/config. Using a different threshold than 4.5.
  </action>
  <verify>
    1. `npx vitest run test/scrubber/entropy.test.ts test/scrubber/redaction.test.ts` passes ≥12 tests
    2. `npx tsc --noEmit` passes
    3. `grep "ENTROPY_THRESHOLD = 4.5" src/scrubber/entropy.ts` matches
    4. `grep "slice(0, 4)" src/scrubber/redaction.ts` matches
  </verify>
  <done>
    Entropy stage and redaction formatter implemented with ≥12 passing tests; ENTROPY_THRESHOLD=4.5 locked, sha4 is deterministic.
  </done>
</task>

</tasks>

<verification>
- `npm test -- test/scrubber/yaml-loader.test.ts test/scrubber/path-exclusion.test.ts test/scrubber/entropy.test.ts test/scrubber/redaction.test.ts` runs ≥25 tests green
- `npx tsc --noEmit` passes
- All 4 primitive test files import test/setup/no-network.ts
- No runtime imports of secretlint anywhere
</verification>

<success_criteria>
- PRIV-03 (Phase 0 portion): layered YAML loader exists with strict schema ready to load baseline + user packs
- PRIV-05 (Phase 0 portion): zero network calls in any scrubber primitive code path
- Plan 00-05b can now compose these primitives into the Scrubber class + baseline extractor
</success_criteria>

<output>
After completion, create `.planning/phases/00-distribution-decision-foundations/00-05a-SUMMARY.md` listing the types, yaml-loader behavior, path-exclusion patterns, entropy threshold, sha4 formatter, and the test count.
</output>
</content>
</invoke>