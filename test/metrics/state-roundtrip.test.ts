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

  it('saves and loads identical data', async () => {
    const state = makeState();
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).toEqual(state);
  });

  it('returns null when no file exists', () => {
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).toBeNull();
  });

  it('preserves empty attribution array', async () => {
    const state = makeState({ per_directive_attribution: [] });
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.per_directive_attribution).toEqual([]);
  });

  it('preserves zero values', async () => {
    const state = makeState({
      total_tokens_saved: 0,
      total_errors_prevented: 0,
      total_time_saved_minutes: 0,
    });
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.total_tokens_saved).toBe(0);
    expect(loaded!.total_errors_prevented).toBe(0);
    expect(loaded!.total_time_saved_minutes).toBe(0);
  });

  it('preserves large numbers', async () => {
    const state = makeState({
      total_tokens_saved: 9_999_999,
      total_errors_prevented: 100_000,
      total_time_saved_minutes: 500_000,
    });
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.total_tokens_saved).toBe(9_999_999);
    expect(loaded!.total_errors_prevented).toBe(100_000);
    expect(loaded!.total_time_saved_minutes).toBe(500_000);
  });

  it('preserves populated attribution array', async () => {
    const state = makeState({
      per_directive_attribution: [
        { directive_id: 'dir-1', tokens_saved: 800, errors_prevented: 2, time_saved_minutes: 10 },
        { directive_id: 'dir-2', tokens_saved: 3400, errors_prevented: 5, time_saved_minutes: 11 },
      ],
    });
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.per_directive_attribution).toHaveLength(2);
    expect(loaded!.per_directive_attribution[0].directive_id).toBe('dir-1');
    expect(loaded!.per_directive_attribution[1].tokens_saved).toBe(3400);
  });

  it('returns data shape expected by syncStats', async () => {
    const state = makeState({ directive_count: 5 });
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

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

  it('preserves directive_count when set', async () => {
    const state = makeState({ directive_count: 12 });
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.directive_count).toBe(12);
  });

  it('loads without directive_count (backward compat)', async () => {
    const state = makeState();
    // state has no directive_count (undefined) — simulates pre-v42 data
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.directive_count).toBeUndefined();
  });

  it('overwrites previous state on re-save', async () => {
    const stateA = makeState({ total_tokens_saved: 100 });
    await saveMetricsState(tempHome, PROJECT_ROOT, stateA);

    const stateB = makeState({ total_tokens_saved: 9999 });
    await saveMetricsState(tempHome, PROJECT_ROOT, stateB);

    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded!.total_tokens_saved).toBe(9999);
  });

  it('isolates different project roots', async () => {
    const rootA = '/projects/alpha';
    const rootB = '/projects/beta';

    await saveMetricsState(tempHome, rootA, makeState({ project_slug: 'alpha', total_tokens_saved: 100 }));
    await saveMetricsState(tempHome, rootB, makeState({ project_slug: 'beta', total_tokens_saved: 200 }));

    const loadedA = loadMetricsState(tempHome, rootA);
    const loadedB = loadMetricsState(tempHome, rootB);

    expect(loadedA!.project_slug).toBe('alpha');
    expect(loadedA!.total_tokens_saved).toBe(100);
    expect(loadedB!.project_slug).toBe('beta');
    expect(loadedB!.total_tokens_saved).toBe(200);
  });

  it('file is written to correct path', async () => {
    const state = makeState();
    await saveMetricsState(tempHome, PROJECT_ROOT, state);

    const expectedPath = metricsStatePath(tempHome, PROJECT_ROOT);
    expect(expectedPath).toContain('.auto-sop/state/metrics/');
    expect(expectedPath).toMatch(/\.json$/);

    // Verify the file actually exists by loading from exact path
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
  });
});
