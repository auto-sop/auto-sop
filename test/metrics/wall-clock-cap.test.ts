import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  capTimeSaved,
  deriveConfidence,
  saveMetricsState,
  loadMetricsState,
  type MetricsState,
} from '../../src/metrics/state.js';

// ── capTimeSaved ──────────────────────────────────────────

describe('capTimeSaved', () => {
  it('caps computed time at wall-clock elapsed minutes', () => {
    // First directive added 60 minutes ago, computed says 120 min → capped to 60
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = capTimeSaved(120, sixtyMinAgo);
    // Should be roughly 60 (within a second of rounding)
    expect(result).toBeLessThanOrEqual(60.1);
    expect(result).toBeGreaterThanOrEqual(59.9);
  });

  it('returns computed time when under wall-clock limit', () => {
    // First directive added 120 minutes ago, computed says 30 min → 30 (no cap)
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    const result = capTimeSaved(30, twoHoursAgo);
    expect(result).toBe(30);
  });

  it('returns computed time when first_directive_added_at is undefined', () => {
    const result = capTimeSaved(100, undefined);
    expect(result).toBe(100);
  });

  it('returns computed time when first_directive_added_at is invalid', () => {
    const result = capTimeSaved(50, 'not-a-date');
    expect(result).toBe(50);
  });

  it('returns 0 when computed is 0', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = capTimeSaved(0, oneHourAgo);
    expect(result).toBe(0);
  });

  it('handles first_directive_added_at in the future gracefully', () => {
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // Elapsed would be negative → clamped to 0 → caps computed at 0
    const result = capTimeSaved(100, oneHourFromNow);
    expect(result).toBe(0);
  });

  it('uses provided now parameter for testability', () => {
    const first = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T02:00:00Z'); // 120 minutes later
    const result = capTimeSaved(200, first.toISOString(), now);
    expect(result).toBe(120);
  });

  it('caps large computed values correctly', () => {
    // First directive 1 hour ago → max 60 minutes, but computed says 4000
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = capTimeSaved(4000, oneHourAgo);
    expect(result).toBeLessThanOrEqual(60.1);
  });
});

// ── deriveConfidence ──────────────────────────────────────

describe('deriveConfidence', () => {
  it('returns low for 0 sessions', () => {
    expect(deriveConfidence(0)).toBe('low');
  });

  it('returns low for 14 sessions', () => {
    expect(deriveConfidence(14)).toBe('low');
  });

  it('returns medium for 15 sessions', () => {
    expect(deriveConfidence(15)).toBe('medium');
  });

  it('returns medium for 49 sessions', () => {
    expect(deriveConfidence(49)).toBe('medium');
  });

  it('returns high for 50 sessions', () => {
    expect(deriveConfidence(50)).toBe('high');
  });

  it('returns high for 100 sessions', () => {
    expect(deriveConfidence(100)).toBe('high');
  });
});

// ── Round-trip persistence of new V53 fields ─────────────

describe('MetricsState V53 fields round-trip', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'auto-sop-v53-'));
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

  it('preserves first_directive_added_at through round-trip', () => {
    const state = makeState({ first_directive_added_at: '2026-03-15T08:00:00.000Z' });
    saveMetricsState(tempHome, PROJECT_ROOT, state);
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.first_directive_added_at).toBe('2026-03-15T08:00:00.000Z');
  });

  it('preserves confidence through round-trip', () => {
    for (const conf of ['low', 'medium', 'high'] as const) {
      const state = makeState({ confidence: conf });
      saveMetricsState(tempHome, PROJECT_ROOT, state);
      const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
      expect(loaded).not.toBeNull();
      expect(loaded!.confidence).toBe(conf);
    }
  });

  it('preserves baseline_sessions through round-trip', () => {
    const state = makeState({ baseline_sessions: 42 });
    saveMetricsState(tempHome, PROJECT_ROOT, state);
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.baseline_sessions).toBe(42);
  });

  it('loads without V53 fields (backward compat)', () => {
    const state = makeState();
    saveMetricsState(tempHome, PROJECT_ROOT, state);
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.first_directive_added_at).toBeUndefined();
    expect(loaded!.confidence).toBeUndefined();
    expect(loaded!.baseline_sessions).toBeUndefined();
  });

  it('time_saved_minutes reflects wall-clock cap', () => {
    // Simulate: directive added 30 min ago, raw computation would give 100 min
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cappedTime = capTimeSaved(100, thirtyMinAgo);
    const state = makeState({
      total_time_saved_minutes: cappedTime,
      first_directive_added_at: thirtyMinAgo,
    });
    saveMetricsState(tempHome, PROJECT_ROOT, state);
    const loaded = loadMetricsState(tempHome, PROJECT_ROOT);
    expect(loaded).not.toBeNull();
    // Capped time should be approximately 30 minutes (not 100)
    expect(loaded!.total_time_saved_minutes).toBeLessThanOrEqual(30.1);
    expect(loaded!.total_time_saved_minutes).toBeGreaterThanOrEqual(29.9);
  });
});
