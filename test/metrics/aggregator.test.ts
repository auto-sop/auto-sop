import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateMetrics, toMetricsState } from '../../src/metrics/aggregator.js';
import {
  loadMetricsState,
  saveMetricsState,
  emptyMetricsState,
  projectHash,
  metricsStatePath,
} from '../../src/metrics/state.js';
import type { BeforeAfterComparison } from '../../src/learner/session-metrics.js';
import type { PreventedError } from '../../src/learner/error-prevention.js';

function makeComparison(
  beforeAvgCalls: number,
  afterAvgCalls: number,
  beforeAvgMin: number = 20,
  afterAvgMin: number = 10,
): BeforeAfterComparison {
  return {
    cutoff: '2026-04-22T00:00:00Z',
    before: {
      sessions: 5,
      avg_duration_min: beforeAvgMin,
      avg_tool_calls: beforeAvgCalls,
      avg_bash_failures: 2,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    after: {
      sessions: 5,
      avg_duration_min: afterAvgMin,
      avg_tool_calls: afterAvgCalls,
      avg_bash_failures: 1,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    improvement: { duration_pct: -50, tool_calls_pct: -40, bash_failures_pct: -50 },
  };
}

function makePreventedError(t: string, directiveId: string = 'dir-1'): PreventedError {
  return {
    t,
    directive_id: directiveId,
    source_fingerprint: 'npm test',
    session_id: 'sess-001',
    command_preview: 'npm test',
  };
}

describe('aggregateMetrics', () => {
  it('computes all three metrics from valid input', () => {
    const result = aggregateMetrics({
      projectSlug: 'test-project',
      comparison: makeComparison(20, 12, 20, 10),
      preventedErrors: [
        makePreventedError('2026-04-15T10:00:00.000Z'),
        makePreventedError('2026-04-16T10:00:00.000Z'),
      ],
      now: new Date('2026-04-20T12:00:00.000Z'),
    });

    expect(result.tokenSavings).not.toBeNull();
    expect(result.tokenSavings!.total_savings_per_session).toBeGreaterThan(0);

    expect(result.errorPrevention.total_prevented).toBe(2);

    expect(result.timeSavings).not.toBeNull();
    expect(result.timeSavings!.total_minutes_saved).toBeGreaterThan(0);
  });

  it('handles null comparison gracefully', () => {
    const result = aggregateMetrics({
      projectSlug: 'test-project',
      comparison: null,
      preventedErrors: [],
    });

    expect(result.tokenSavings).toBeNull();
    expect(result.timeSavings).toBeNull();
    expect(result.errorPrevention.total_prevented).toBe(0);
  });

  it('handles empty prevented errors', () => {
    const result = aggregateMetrics({
      projectSlug: 'test-project',
      comparison: makeComparison(20, 12),
      preventedErrors: [],
    });

    expect(result.errorPrevention.total_prevented).toBe(0);
    expect(result.errorPrevention.by_directive).toEqual({});
  });
});

describe('toMetricsState', () => {
  it('converts aggregated metrics to state', () => {
    const metrics = aggregateMetrics({
      projectSlug: 'test-project',
      comparison: makeComparison(20, 12, 20, 10),
      preventedErrors: [makePreventedError('2026-04-15T10:00:00.000Z')],
      now: new Date('2026-04-20T12:00:00.000Z'),
    });

    const state = toMetricsState('test-project', metrics, [], new Date('2026-04-20T12:00:00.000Z'));

    expect(state.v).toBe(1);
    expect(state.project_slug).toBe('test-project');
    expect(state.total_tokens_saved).toBeGreaterThan(0);
    expect(state.total_errors_prevented).toBe(1);
    expect(state.total_time_saved_minutes).toBeGreaterThan(0);
    expect(state.last_computed_at).toBe('2026-04-20T12:00:00.000Z');
  });

  it('handles null sub-metrics', () => {
    const metrics = aggregateMetrics({
      projectSlug: 'test-project',
      comparison: null,
      preventedErrors: [],
    });

    const state = toMetricsState('test-project', metrics);

    expect(state.total_tokens_saved).toBe(0);
    expect(state.total_time_saved_minutes).toBe(0);
    expect(state.total_errors_prevented).toBe(0);
  });
});

describe('MetricsState persistence', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'metrics-state-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('projectHash produces consistent hex strings', () => {
    const h1 = projectHash('/Users/test/project');
    const h2 = projectHash('/Users/test/project');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
  });

  it('different paths produce different hashes', () => {
    const h1 = projectHash('/project-a');
    const h2 = projectHash('/project-b');
    expect(h1).not.toBe(h2);
  });

  it('loadMetricsState returns null when no file exists', () => {
    expect(loadMetricsState(tmpHome, '/nonexistent')).toBeNull();
  });

  it('saves and loads state correctly', async () => {
    const state = emptyMetricsState('test-project');
    state.total_tokens_saved = 1000;
    state.total_errors_prevented = 5;

    saveMetricsState(tmpHome, '/test/project', state);
    const loaded = loadMetricsState(tmpHome, '/test/project');

    expect(loaded).not.toBeNull();
    expect(loaded!.v).toBe(1);
    expect(loaded!.project_slug).toBe('test-project');
    expect(loaded!.total_tokens_saved).toBe(1000);
    expect(loaded!.total_errors_prevented).toBe(5);
  });

  it('loadMetricsState returns null for corrupt JSON', async () => {
    const path = metricsStatePath(tmpHome, '/test/corrupt');
    const dir = join(tmpHome, '.auto-sop', 'state', 'metrics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'not-json');

    expect(loadMetricsState(tmpHome, '/test/corrupt')).toBeNull();
  });

  it('loadMetricsState returns null for wrong version', async () => {
    const path = metricsStatePath(tmpHome, '/test/wrong-v');
    const dir = join(tmpHome, '.auto-sop', 'state', 'metrics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ v: 99, project_slug: 'x' }));

    expect(loadMetricsState(tmpHome, '/test/wrong-v')).toBeNull();
  });

  it('emptyMetricsState produces valid zero state', () => {
    const state = emptyMetricsState('my-project');
    expect(state.v).toBe(1);
    expect(state.project_slug).toBe('my-project');
    expect(state.total_tokens_saved).toBe(0);
    expect(state.total_errors_prevented).toBe(0);
    expect(state.total_time_saved_minutes).toBe(0);
    expect(state.per_directive_attribution).toEqual([]);
    expect(state.last_computed_at).toBeTruthy();
  });
});
