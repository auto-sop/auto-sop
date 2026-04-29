# PLAN-v41: Encrypted Stats Sync (CLI + Server)

## Overview
Wire hourly stats upload from CLI to server using the same X25519 encrypted channel as license validation. Server stores every stats call as an append-only log AND maintains a rolling summary per project+account. Dashboard reads from the summary table for real-time display.

## Cross-Repo Plan
- **auto-sop** (CLI): stats sync client module + tick integration
- **auto-sop-site** (Server): stats endpoint + migration + dashboard update

## Architecture Decisions
- **Same security model as validate**: X25519 encrypted body, `Content-Type: application/x-asop-encrypted`, license key inside encrypted payload for user identification. No Clerk JWT needed (CLI has no browser auth).
- **Reuse `maybeDecryptRequest()`** on server — same middleware handles both validate and stats endpoints.
- **Two server tables**: `asop_stats_log` (append-only, every call) + `asop_stats_summary` (upsert, one row per user+project, always latest totals).
- **Non-blocking**: Stats sync failure never blocks the tick. Fail-open, log warning, continue.
- **No cache/grace complexity**: Stats are best-effort. If server unreachable, skip silently. Next tick will send updated totals anyway (totals are cumulative, not deltas).
- **Per-project stats in payload**: CLI iterates all projects during tick, collects each project's MetricsState, sends them all in one POST.
- **Account-level aggregation**: Server computes account totals by SUM over `asop_stats_summary` WHERE user_id.

## Implementation Tasks

### Wave 1: Server (no CLI dependency — can be deployed first)

#### Task 1: ARCHITECT — Supabase migration for stats tables
Repo: **auto-sop-site**
Files: `supabase/migrations/004_stats_tables.sql`
Requirements:
```sql
-- Append-only log: every stats POST is recorded
CREATE TABLE IF NOT EXISTS asop_stats_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES asop_users(id) ON DELETE CASCADE,
  machine_id       text NOT NULL,
  projects_data    jsonb NOT NULL,      -- array of per-project stats snapshots
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- Rolling summary: one row per user+project, always latest totals
CREATE TABLE IF NOT EXISTS asop_stats_summary (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES asop_users(id) ON DELETE CASCADE,
  project_slug            text NOT NULL,
  machine_id              text NOT NULL,
  total_tokens_saved      bigint NOT NULL DEFAULT 0,
  total_errors_prevented  bigint NOT NULL DEFAULT 0,
  total_time_saved_minutes numeric(10,2) NOT NULL DEFAULT 0,
  directive_count         int NOT NULL DEFAULT 0,
  last_synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, project_slug, machine_id)
);

ALTER TABLE asop_stats_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE asop_stats_summary ENABLE ROW LEVEL SECURITY;

-- RLS policies (admin client bypasses, but define for completeness)
CREATE POLICY asop_stats_log_select ON asop_stats_log
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY asop_stats_log_insert ON asop_stats_log
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY asop_stats_summary_select ON asop_stats_summary
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY asop_stats_summary_insert ON asop_stats_summary
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY asop_stats_summary_update ON asop_stats_summary
  FOR UPDATE USING (user_id = auth.uid());

-- Indexes
CREATE INDEX IF NOT EXISTS idx_asop_stats_log_user_id ON asop_stats_log(user_id);
CREATE INDEX IF NOT EXISTS idx_asop_stats_log_received_at ON asop_stats_log(received_at);
CREATE INDEX IF NOT EXISTS idx_asop_stats_summary_user_id ON asop_stats_summary(user_id);
```
Apply with: `supabase db query --linked < supabase/migrations/004_stats_tables.sql`
Acceptance: Tables exist in Supabase, RLS enabled, indexes created.

#### Task 2: ARCHITECT — Stats API endpoint
Repo: **auto-sop-site**
Files: `src/app/api/v1/stats/route.ts`
Requirements:
- `POST /api/v1/stats` — public endpoint (no Clerk auth, like validate)
- Use `maybeDecryptRequest(req)` to handle X25519 encrypted body transparently
- Request body (after decryption):
  ```typescript
  {
    key: string;              // license key for user identification
    machine_id: string;
    projects: Array<{
      project_slug: string;
      total_tokens_saved: number;
      total_errors_prevented: number;
      total_time_saved_minutes: number;
      directive_count: number;
    }>;
  }
  ```
- Look up user by `key` in `asop_users` (same pattern as validate: `select("id, plan, deleted_at").eq("license_key", key).single()`)
- Reject if user not found (401) or deleted (403)
- Rate limit: 100 calls per user per hour (same as validate)
- **Step 1**: Insert into `asop_stats_log`: `{ user_id, machine_id, projects_data: body.projects, received_at: now() }`
- **Step 2**: For each project in `body.projects`, UPSERT into `asop_stats_summary`:
  ```sql
  INSERT INTO asop_stats_summary (user_id, project_slug, machine_id, total_tokens_saved, total_errors_prevented, total_time_saved_minutes, directive_count, last_synced_at)
  VALUES (...)
  ON CONFLICT (user_id, project_slug, machine_id) DO UPDATE SET
    total_tokens_saved = EXCLUDED.total_tokens_saved,
    total_errors_prevented = EXCLUDED.total_errors_prevented,
    total_time_saved_minutes = EXCLUDED.total_time_saved_minutes,
    directive_count = EXCLUDED.directive_count,
    last_synced_at = EXCLUDED.last_synced_at;
  ```
- Response: `{ ok: true, synced_projects: N }`
- Stats log insert failure is non-fatal — log error but still attempt summary upsert
Acceptance: Endpoint accepts encrypted POST, stores log + upserts summary, returns 200.

### Wave 2: CLI (depends on server endpoint being live)

#### Task 3: ARCHITECT — Stats sync client module
Repo: **auto-sop**
Files: `src/license/stats-sync.ts` (new), `test/license/stats-sync.test.ts` (new)
Requirements:
- New function:
  ```typescript
  export async function syncStats(opts: {
    key: string;
    machineId: string;
    projects: Array<{
      project_slug: string;
      total_tokens_saved: number;
      total_errors_prevented: number;
      total_time_saved_minutes: number;
      directive_count: number;
    }>;
  }): Promise<{ success: boolean; error?: string }>
  ```
- Encrypt the payload with `encryptRequest(JSON.stringify(body), SERVER_X25519_PUBLIC_KEY_B64)` — same as `server-client.ts` does for validate
- POST to `${API_BASE_URL}/stats` with `Content-Type: application/x-asop-encrypted`
- Timeout: 10 seconds (AbortController, same as validate)
- On 200: return `{ success: true }`
- On 401/403/4xx/5xx/network error: return `{ success: false, error: 'reason' }` — never throw
- Tests: mock fetch, verify encrypted payload structure, verify error handling
Acceptance: Function encrypts and POSTs stats, handles all error codes gracefully.

#### Task 4: ARCHITECT — Wire stats sync into hourly tick
Repo: **auto-sop**
Files: `src/learner/main.ts`
Requirements:
- After the per-project loop ends (after line ~976, before tick summary), add stats sync block:
  ```typescript
  // ── Stats sync (non-blocking) ──────────────────────────
  try {
    const allProjectStats = [];
    for (const project of sortedProjects) {
      const metrics = loadMetricsState(home, project.project_root);
      if (metrics) {
        allProjectStats.push({
          project_slug: metrics.project_slug,
          total_tokens_saved: metrics.total_tokens_saved,
          total_errors_prevented: metrics.total_errors_prevented,
          total_time_saved_minutes: metrics.total_time_saved_minutes,
          directive_count: metrics.per_directive_attribution.length,
        });
      }
    }
    if (allProjectStats.length > 0 && licenseKey && machineId) {
      const syncResult = await syncStats({
        key: licenseKey,
        machineId,
        projects: allProjectStats,
      });
      if (!syncResult.success) {
        logError('stats_sync_failed', syncResult.error ?? 'unknown', home);
      }
    }
  } catch (err) {
    logError('stats_sync_error', err, home);
  }
  ```
- Import `syncStats` from `../license/stats-sync.js`
- Import `loadMetricsState` from `../metrics/state.js`
- The `licenseKey` and `machineId` are already available in the tick scope from the enforcement check
- This MUST be inside try/catch — stats sync failure never aborts the tick
Acceptance: After each hourly tick, stats are sent to server. Verify by checking `asop_stats_log` table.

### Wave 3: Dashboard (depends on server tables being populated)

#### Task 5: ARCHITECT — Update dashboard to show real stats
Repo: **auto-sop-site**
Files: `src/lib/dashboard.ts`, `src/components/dashboard/StatsGrid.tsx`
Requirements:
- In `getDashboardData()`, replace the fake `directiveFires` (validation_log count) with real data from `asop_stats_summary`:
  ```typescript
  // Fetch aggregate stats from stats_summary
  const { data: statsSummary } = await db
    .from("asop_stats_summary")
    .select("total_tokens_saved, total_errors_prevented, total_time_saved_minutes, directive_count")
    .eq("user_id", user.id);

  const aggregateStats = (statsSummary ?? []).reduce(
    (acc, row) => ({
      tokensSaved: acc.tokensSaved + (row.total_tokens_saved ?? 0),
      errorsPrevented: acc.errorsPrevented + (row.total_errors_prevented ?? 0),
      timeSavedMinutes: acc.timeSavedMinutes + (row.total_time_saved_minutes ?? 0),
      directiveCount: acc.directiveCount + (row.directive_count ?? 0),
    }),
    { tokensSaved: 0, errorsPrevented: 0, timeSavedMinutes: 0, directiveCount: 0 },
  );
  ```
- Update `StatsGrid` component to show:
  - Projects Bound (existing — keep)
  - Active Directives → from `aggregateStats.directiveCount`
  - Errors Prevented → from `aggregateStats.errorsPrevented` (NEW real metric)
  - Tokens Saved → from `aggregateStats.tokensSaved` (NEW real metric)
- Remove the misleading `directiveFires` metric (was validation_log count)
Acceptance: Dashboard shows real per-account aggregated stats from `asop_stats_summary`. No fabricated numbers.

## Quality Gates (MANDATORY)
6. YODA: Code review — all implemented code across both repos
7. APEX: Security review — X25519 encryption on stats, no PII leaks, rate limiting
8. ANALYZER: Code improvement review — must pass C or above

## Finalize
9. ARCHITECT: Commit CLI changes with message "feat(v41): encrypted stats sync — X25519 hourly upload to server"
10. ARCHITECT: Commit site changes with message "feat(v41): stats endpoint + tables + dashboard real metrics"

## Acceptance Criteria
- Every hourly tick sends encrypted stats to `POST /api/v1/stats`
- Server decrypts via X25519 (same key as validate)
- Every call appended to `asop_stats_log` (audit trail)
- Per-project latest totals maintained in `asop_stats_summary` (one row per user+project+machine)
- Dashboard shows real aggregated stats per account (tokens saved, errors prevented, directives)
- Stats sync failure never blocks the tick (fail-open)
- No license key, machine_id, or project paths visible in logs or responses
- All tests pass (100%)
- All quality gates approved
