import { describe, it, expect } from 'vitest';
import { diceSimilarity, deduplicateProposals, DEDUP_THRESHOLD } from '../../src/learner/dedup.js';
import type { DirectiveProposalType } from '../../src/learner/directive-schema.js';

function makeProposal(ruleText: string, id: string): DirectiveProposalType {
  return {
    id,
    detector: 'test-detector',
    severity: 'warning',
    rule_text: ruleText,
    evidence: {
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1'],
      pattern: 'test-pattern',
      occurrence_count: 3,
      first_seen: '2026-01-01T00:00:00Z',
    },
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('dedup integration — real-world directive pairs', () => {
  const NEAR_DUPLICATE_PAIRS = [
    ['never embed API tokens in source code', 'never pass access tokens inline in code'],
    [
      'Always use the Read tool instead of Bash cat for reading files',
      'Always use the Read tool instead of Bash cat/head for reading files',
    ],
    [
      'Always use the Glob tool for file pattern matching instead of find',
      'Always use Glob for file pattern matching instead of find commands',
    ],
  ];

  const DISTINCT_PAIRS = [
    ['Never embed API tokens in source code', 'Use PostgreSQL for database migrations'],
    [
      'Always use the Read tool instead of Bash cat for reading files',
      'Never run destructive git commands without explicit user request',
    ],
    [
      'Before deploying to production, verify environment variables',
      'Use the Glob tool for file pattern matching',
    ],
  ];

  it.each(NEAR_DUPLICATE_PAIRS)(
    'detects near-duplicate: "%s" vs "%s"',
    (a, b) => {
      const sim = diceSimilarity(a, b);
      expect(sim).toBeGreaterThan(DEDUP_THRESHOLD);
    },
  );

  it.each(DISTINCT_PAIRS)(
    'allows distinct pair: "%s" vs "%s"',
    (a, b) => {
      const sim = diceSimilarity(a, b);
      expect(sim).toBeLessThanOrEqual(DEDUP_THRESHOLD);
    },
  );

  it('filters duplicates from a batch of mixed proposals', () => {
    const existing = [
      'Always use the Read tool instead of Bash cat for reading files',
      'Never embed API tokens in source code',
    ];
    const candidates = [
      makeProposal('Always use the Read tool instead of Bash cat/head for reading files', 'dup1'),
      makeProposal('Use PostgreSQL for database migrations', 'unique1'),
      makeProposal('Never pass access tokens inline in code', 'dup2'),
      makeProposal('Run tests before committing code changes', 'unique2'),
    ];

    const result = deduplicateProposals(candidates, existing);

    expect(result.skippedCount).toBe(2);
    expect(result.accepted).toHaveLength(2);
    const ids = result.accepted.map((p) => p.id);
    expect(ids).toContain('unique1');
    expect(ids).toContain('unique2');
    expect(ids).not.toContain('dup1');
    expect(ids).not.toContain('dup2');
  });

  it('achieves < 5% duplicate rate on a set of distinct directives', () => {
    const distinctDirectives = [
      'Always use the Read tool instead of Bash cat for reading files',
      'Never run destructive git commands without explicit user request',
      'Use PostgreSQL for database migrations and schema changes',
      'Before deploying, verify Vercel project settings match staging',
      'Run npm test before committing changes to the main branch',
      'Use proper error handling in async functions with try-catch',
      'Follow semantic versioning for package releases on npm registry',
      'Document public API endpoints with OpenAPI specification files',
      'Use TypeScript strict mode for new projects starting from scratch',
      'Keep functions under 50 lines of code for better maintainability',
      'Write unit tests for all business logic in the service layer',
      'Use parameterized queries to prevent SQL injection attacks',
      'Log errors with structured JSON format to stdout not stderr',
      'Store secrets in vault services not in dotenv or config files',
      'Implement rate limiting on public API endpoints using middleware',
      'Use HTTPS for all external API communications and webhooks',
      'Validate user input at the API boundary with Zod schemas',
      'Use dependency injection for testability in class constructors',
      'Keep npm dependencies updated for security patches monthly',
      'Use git hooks for pre-commit linting with husky and lint-staged',
    ];

    const proposals = distinctDirectives.map((text, i) =>
      makeProposal(text, `d-${i}`),
    );
    const result = deduplicateProposals(proposals, []);

    const duplicateRate = result.skippedCount / proposals.length;
    expect(duplicateRate).toBeLessThan(0.05);
  });
});
