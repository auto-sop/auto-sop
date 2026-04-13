# Plan 00-05b Summary: Scrubber Pipeline + Baseline Extractor + NOTICES

## What was built

### 4-Stage Scrubber Pipeline (`src/scrubber/scrubber.ts`)
1. **Stage 1 — Path Exclusion**: Sensitive file paths (`.env`, `.pem`, `id_rsa`, etc.) short-circuit to `[REDACTED: sensitive path]`
2. **Stage 2 — Regex Pipeline**: Applies baseline + user rules in order, replacing matches with `[REDACTED:<sha4>]` or custom `rule.replacement`
3. **Stage 3 — Entropy Catch-All**: Shannon entropy ≥ 4.5 on tokens ≥ 20 chars catches secrets that survive regex
4. **Stage 4 — Redaction Formatting**: Applied inline by stages 2 & 3 via `formatRedaction()`

### BASELINE_YAML Module Constant Strategy
- `scripts/extract-secretlint-rules.ts` emits `src/scrubber/baseline.generated.ts` as a TypeScript template literal constant
- **Zero disk reads at runtime** — no `__dirname`, no `import.meta.url`, works identically in ESM and CJS
- Backslashes double-escaped to survive template literal interpretation
- Deterministic: running the extractor twice produces byte-identical output

### Curated Baseline (9 rules, secretlint-attributed)
| Rule ID | Pattern |
|---------|---------|
| anthropic-api-key | `sk-ant-*` |
| aws-access-key-id | `AKIA*` |
| aws-secret-access-key | 40-char base64 heuristic |
| github-token | `gh[pousr]_*` |
| gitlab-token | `glpat-*` |
| slack-token | `xox[baprs]-*` |
| stripe-key | `sk_test_*` / `pk_live_*` etc. |
| jwt | `eyJ*.eyJ*.*` |
| env-assignment | `KEY=VALUE` → `KEY=[REDACTED]` |

### CI Regeneration Check
- New `baseline-regeneration-check` job in `.github/workflows/ci.yml`
- Runs `npm run extract-rules` then `git diff --exit-code` on the generated file
- Fails if committed file is out of sync with extractor output

### NOTICES.md
- Full MIT attribution for @secretlint/secretlint-rule-preset-recommend (Copyright Takuto Wada and contributors)
- Per-rule source annotation (curated vs inspired-by-secretlint)

## Files created/modified
- `scripts/extract-secretlint-rules.ts` (new)
- `src/scrubber/baseline.generated.ts` (generated, committed)
- `src/scrubber/regex-pipeline.ts` (new)
- `src/scrubber/scrubber.ts` (new)
- `src/scrubber/index.ts` (new)
- `NOTICES.md` (new)
- `test/scrubber/regex-pipeline.test.ts` (new — 11 tests)
- `test/scrubber/scrubber.test.ts` (new — 10 tests)
- `package.json` (added devDep, extract-rules script, build composition)
- `.github/workflows/ci.yml` (added baseline-regeneration-check job)

## Test results
- **124 tests passing** across 17 test files (58 scrubber-specific across 6 files)
- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm run build` ✅ (extract-rules → tsup)
- Determinism verified locally
- Zero runtime secretlint imports
- No lifecycle scripts added
