import { loadMetricsState } from './src/metrics/state.js';
import { syncStats } from './src/license/stats-sync.js';
import os from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';

const home = os.homedir();
const data = JSON.parse(readFileSync(join(home, '.auto-sop', 'projects.json'), 'utf8'));
const projects = data.projects;
console.log('Projects:', projects.length);

const allStats: any[] = [];
for (const p of projects) {
  try {
    const metrics = loadMetricsState(home, p.project_root);
    if (metrics !== null) {
      console.log(`✓ ${metrics.project_slug}: tokens=${metrics.total_tokens_saved}, errors=${metrics.total_errors_prevented}, time=${metrics.total_time_saved_minutes}min, directives=${metrics.per_directive_attribution.length}`);
      allStats.push({
        project_slug: metrics.project_slug,
        total_tokens_saved: metrics.total_tokens_saved,
        total_errors_prevented: metrics.total_errors_prevented,
        total_time_saved_minutes: metrics.total_time_saved_minutes,
        directive_count: metrics.per_directive_attribution.length,
      });
    } else {
      console.log(`✗ ${p.slug}: no metrics`);
    }
  } catch (e: any) {
    console.log(`✗ ${p.slug}: error - ${e.message}`);
  }
}

console.log(`\nTotal projects with stats: ${allStats.length}`);

if (allStats.length > 0) {
  console.log('\nSending stats sync...');
  const result = await syncStats({
    key: '01753a6a69f27e7cb9d8ba5195b2ca502ef3ff95d559659c',
    machineId: '34735575-ce0e-50be-9ec5-ca1c5c431a8a',
    projects: allStats,
  });
  console.log('Result:', JSON.stringify(result, null, 2));
}
