# Scrubber Fixture Corpus

Test fixtures for the scrubber recall gate (`test/scrubber/recall.test.ts`).

## Layout

```
fixtures/
  positives/   # One file per secret category — secrets the scrubber MUST redact
  negatives/   # One file per benign-lookalike category — tokens the scrubber MUST NOT redact
```

## File Format

- One entry per line
- Blank lines and lines starting with `#` are ignored
- LF line endings, no trailing spaces

## Fake-Secrets Policy

**NEVER commit real credentials.** All secrets must be structurally realistic but
clearly synthetic. Use patterns like:

- AWS: `AKIAIOSFODNN7EXAMPLE` (official AWS example)
- Anthropic: keys containing `FAKE` substring
- GitHub: `ghp_FAKE...`

## Budgets

| Metric | Budget       | Description                                      |
| ------ | ------------ | ------------------------------------------------ |
| Recall | ≥ 0.95 (95%) | Fraction of positive secrets that are redacted   |
| FPR    | ≤ 0.05 (5%)  | Fraction of negative tokens incorrectly redacted |

## How to Add New Fixtures

1. Add lines to the appropriate file (or create a new file)
2. Run `npx vitest run test/scrubber/recall.test.ts`
3. Commit both the fixture change and the updated `scrubber-recall-report.json`

The CI `scrubber-recall-check` job verifies the committed report matches the latest run.
