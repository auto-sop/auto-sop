---
phase: 00-distribution-decision-foundations
plan: 05a
status: complete
tests: 37
---

# Plan 00-05a Summary: Scrubber Primitives

## Artifacts Created

### Source Files
| File | Exports | Purpose |
|------|---------|---------|
| `src/scrubber/types.ts` | `Rule`, `RulePack`, `ScrubInput`, `ScrubResult` | Shared type definitions for scrubber pipeline |
| `src/scrubber/yaml-loader.ts` | `loadRulePack`, `rulePackSchema` | YAML rule pack loader (eemeli/yaml + Zod strict) |
| `src/scrubber/path-exclusion.ts` | `isSensitivePath`, `applyPathExclusion` | Stage 1 — whole-payload redaction for sensitive paths |
| `src/scrubber/entropy.ts` | `shannonEntropy`, `applyEntropyCatchAll`, `ENTROPY_THRESHOLD`, `MIN_TOKEN_LEN` | Stage 3 — Shannon entropy catch-all |
| `src/scrubber/redaction.ts` | `sha4`, `formatRedaction` | Deterministic `[REDACTED:XXXX]` tag formatter |

### Test Files
| File | Tests |
|------|-------|
| `test/scrubber/yaml-loader.test.ts` | 8 |
| `test/scrubber/path-exclusion.test.ts` | 14 |
| `test/scrubber/entropy.test.ts` | 10 |
| `test/scrubber/redaction.test.ts` | 5 |
| **Total** | **37** |

## Key Decisions

- **YAML parser**: `yaml` (eemeli) — no `js-yaml`
- **Schema strictness**: `.strict()` on both top-level and inner rule objects; unknown keys rejected
- **Regex validation**: Eagerly compiled at load time; error includes rule `id`
- **Entropy threshold**: `ENTROPY_THRESHOLD = 4.5`, `MIN_TOKEN_LEN = 20` (per CONTEXT.md decision B)
- **Redaction format**: `[REDACTED:XXXX]` where XXXX = first 4 hex chars of SHA-256(original)
- **Path-exclusion patterns**: `.env*`, `.pem`, `id_rsa*`, `id_ed25519*`, `*secret*`, `*credential*`, `.key`

## Verification

- ✅ `npm run lint` — 0 errors
- ✅ `npm run typecheck` — 0 errors
- ✅ `npx vitest run test/scrubber/` — 37/37 passed
- ✅ No `js-yaml` dependency
- ✅ No `../config` imports from scrubber modules
- ✅ No `secretlint` runtime imports
- ✅ All test files import `test/setup/no-network.ts`

## Ready For

Plan 00-05b can now compose these primitives into the `Scrubber` class + baseline extractor + NOTICES generator.
