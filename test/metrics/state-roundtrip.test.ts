import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveMetricsState,
  loadMetricsState,
  metricsStatePath,
  type MetricsState,
} from '../../src/metrics/state.js';

describe('MetricsState round-trip', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'auto-sop-metrics-rt-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  const PROJECT_ROOT = '/Users/test/projects/my-app';

  function makeState(overrides: Partial<MetricsState> = {}): MetricsState {
    return {
      v: 1,
      project_slug: 'my-app',
      total_tokens_saved: 4200,
      total_errors_prevented: 7,
      total_time_saved_minutes: 21,
      per_directive_attribution: [],
      last_computed_at: '2026-04-27T12:00:00.000Z',
      ...overrides,
    };
  }

  it('saves and loads identical data', () => {
    const state = makeState();
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).toEqual(state);
  });

  it('returns null when no file exists', () => {
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).toBeNull();
  });

  it('preserves empty attribution array', () => {
    const state = makeState({ per_directive_attribution: [] });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.per_directive_attribution).toEqual([]);
  });

  it('preserves zero values', () => {
    const state = makeState({
      total_tokens_saved: 0,
      total_errors_prevented: 0,
      total_time_saved_minutes: 0,
    });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.total_tokens_saved).toBe(0);
    expect(loaded!.total_errors_prevented).toBe(0);
    expect(loaded!.total_time_saved_minutes).toBe(0);
  });

  it('preserves large numbers', () => {
    const state = makeState({
      total_tokens_saved: 9_999_999,
      total_errors_prevented: 100_000,
      total_time_saved_minutes: 500_000,
    });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.total_tokens_saved).toBe(9_999_999);
    expect(loaded!.total_errors_prevented).toBe(100_000);
    expect(loaded!.total_time_saved_minutes).toBe(500_000);
  });

  it('preserves populated attribution array', () => {
    const state = makeState({
      per_directive_attribution: [
        { directive_id: 'dir-1', tokens_saved: 800, errors_prevented: 2, time_saved_minutes: 10 },
        { directive_id: 'dir-2', tokens_saved: 3400, errors_prevented: 5, time_saved_minutes: 11 },
      ],
    });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.per_directive_attribution).toHaveLength(2);
    expect(loaded!.per_directive_attribution[0].directive_id).toBe('dir-1');
    expect(loaded!.per_directive_attribution[1].tokens_saved).toBe(3400);
  });

  it('returns data shape expected by syncStats', () => {
    const state = makeState({ directive_count: 5 });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT)!;
    // syncStats reads these exact fields (see src/license/stats-sync.ts)
    expect(loaded).toHaveProperty('project_slug');
    expect(loaded).toHaveProperty('total_tokens_saved');
    expect(loaded).toHaveProperty('total_errors_prevented');
    expect(loaded).toHaveProperty('total_time_saved_minutes');
    expect(loaded).toHaveProperty('per_directive_attribution');
    expect(loaded).toHaveProperty('directive_count');
    expect(typeof loaded.project_slug).toBe('string');
    expect(typeof loaded.total_tokens_saved).toBe('number');
    expect(typeof loaded.total_errors_prevented).toBe('number');
    expect(typeof loaded.total_time_saved_minutes).toBe('number');
    expect(Array.isArray(loaded.per_directive_attribution)).toBe(true);
  });

  it('preserves directive_count when set', () => {
    const state = makeState({ directive_count: 12 });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.directive_count).toBe(12);
  });

  it('loads without directive_count (backward compat)', () => {
    const state = makeState();
    // state has no directive_count (undefined) — simulates pre-v42 data
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.directive_count).toBeUndefined();
  });

  it('preserves estimation_method through round-trip', () => {
    const state = makeState({ estimation_method: 'hybrid' });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.estimation_method).toBe('hybrid');
  });

  it('preserves estimation_method byte_counted through round-trip', () => {
    const state = makeState({ estimation_method: 'byte_counted' });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.estimation_method).toBe('byte_counted');
  });

  it('preserves estimation_method tool_call_heuristic through round-trip', () => {
    const state = makeState({ estimation_method: 'tool_call_heuristic' });
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.estimation_method).toBe('tool_call_heuristic');
  });

  it('overwrites previous state on re-save', () => {
    const stateA = makeState({ total_tokens_saved: 100 });
    saveMetricsState(tempHome, PROJECT_ROOT, stateA);

    const stateB = makeState({ total_tokens_saved: 9999 });
    saveMetricsState(tempHome, PROJECT_ROOT, stateB);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded!.total_tokens_saved).toBe(9999);
  });

  it('isolates different project roots', () => {
    const rootA = '/projects/alpha';
    const rootB = '/projects/beta';

    saveMetricsState(
      tempHome,
      rootA,
      makeState({ project_slug: 'alpha', total_tokens_saved: 100 }),
    );
    saveMetricsState(tempHome, rootB, makeState({ project_slug: 'beta', total_tokens_saved: 200 }));

    const loadedA = loadMetricsState(tempHome, rootA);
    const loadedB = loadMetricsState(tempHome, rootB);

    expect(loadedA!.project_slug).toBe('alpha');
    expect(loadedA!.total_tokens_saved).toBe(100);
    expect(loadedB!.project_slug).toBe('beta');
    expect(loadedB!.total_tokens_saved).toBe(200);
  });

  it('file is written to correct path', () => {
    const state = makeState();
    saveMetricsState(tempHome, PROJECT_ROOT, state);

    const expectedPath = metricsStatePath(tempHome, PROJECT_ROOT);
    expect(expectedPath).toContain('.auto-sop/state/metrics/');
    expect(expectedPath).toMatch(/\.json$/);

    // Verify the file actually exists by loading from exact path
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
  });
});
