import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRecap, recapLogPath, type PerProjectRecap, type TickSummary } from '../../src/learner/recap-log.js';

describe('recap-log', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'recap-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeProjectRecap(overrides?: Partial<PerProjectRecap>): PerProjectRecap {
    return {
      v: 1,
      t: new Date().toISOString(),
      tick_id: 'ck-10h00',
      project_id: 'proj1',
      project_slug: 'test-project',
      turns_new: 3,
      turns_total_seen: 10,
      tool_calls_new: 5,
      scrubber_hits_new: 0,
      files_changed_new: 2,
      finalization_failures_new: 0,
      skipped_poison: 0,
      oldest_new_turn_at: '2026-04-14T10:00:00.000Z',
      newest_new_turn_at: '2026-04-14T12:00:00.000Z',
      duration_ms: 50,
      llm_mode: false,
      ...overrides,
    };
  }

  function makeSummary(overrides?: Partial<TickSummary>): TickSummary {
    return {
      v: 1,
      t: new Date().toISOString(),
      tick_id: 'ck-10h00',
      summary: true,
      projects_processed: 1,
      projects_skipped: 0,
      projects_locked: 0,
      projects_missing: 0,
      total_turns_new: 3,
      total_duration_ms: 100,
      errors: [],
      ...overrides,
    };
  }

  it('appendRecap creates log file and writes JSON line', () => {
    appendRecap(makeProjectRecap(), tmpHome);
    const logPath = recapLogPath(tmpHome);
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.v).toBe(1);
    expect(parsed.project_id).toBe('proj1');
  });

  it('appendRecap appends multiple entries', () => {
    appendRecap(makeProjectRecap(), tmpHome);
    appendRecap(makeSummary(), tmpHome);
    const content = readFileSync(recapLogPath(tmpHome), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).summary).toBe(true);
  });

  it('rotates when file exceeds 10MB', () => {
    const logPath = recapLogPath(tmpHome);
    const logDir = join(tmpHome, '.claude-sop', 'logs');
    mkdirSync(logDir, { recursive: true });

    // Create file > 10MB
    const chunk = 'x'.repeat(1024) + '\n';
    const fd = require('node:fs').openSync(logPath, 'w');
    for (let i = 0; i < 11 * 1024; i++) {
      require('node:fs').writeSync(fd, chunk);
    }
    require('node:fs').closeSync(fd);

    const sizeBefore = statSync(logPath).size;
    expect(sizeBefore).toBeGreaterThan(10_000_000);

    appendRecap(makeProjectRecap(), tmpHome);

    // Original rotated to .1
    expect(existsSync(logPath + '.1')).toBe(true);
    expect(statSync(logPath + '.1').size).toBeGreaterThan(10_000_000);

    // New file is small
    expect(statSync(logPath).size).toBeLessThan(1000);
  });

  it('includes skipped_poison field in PerProjectRecap', () => {
    appendRecap(makeProjectRecap({ skipped_poison: 3 }), tmpHome);
    const content = readFileSync(recapLogPath(tmpHome), 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.skipped_poison).toBe(3);
  });
});
