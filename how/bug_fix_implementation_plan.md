# Fix All 13 Verified Deep Scan Bugs — Stability-First Plan

## Goal

Fix every confirmed bug from `deep_scan_critical_bugs.md` (all 13 verified) while ensuring **zero regressions** to user experience, dashboard data freshness, and system stability.

## Stability Principles

1. **No behavioral change for intervals ≤90d** — WAE-only queries are untouched
2. **No schema changes** — D1 tables/indexes remain as-is
3. **No new dependencies** — all fixes use existing libraries and patterns
4. **Backward-compatible** — existing tracker scripts, R2 backups, and cron behavior preserved
5. **Every fix is independently safe** — no cross-bug dependencies

---

## Tier 1 — Zero-Risk Surgical Fixes (No Behavioral Change for Normal Use)

These are one-line or few-line changes with no side effects.

---

### BUG #3 — Stats Cache TTL=0 Defeats Caching

#### [MODIFY] [resources.stats.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx)

**Line 70**: Remove the explicit `0` argument so it uses the default TTL (60s).

```diff
-        const cacheResult = await getCachedOrFetch(cacheKey, fetchData, 0);
+        const cacheResult = await getCachedOrFetch(cacheKey, fetchData);
```

> [!NOTE]
> **Stability**: This is purely a performance fix. Extended-interval stats will now be cached for 60s (same as timeseries). Data freshness is unchanged — the `getCacheVersion()` mechanism already busts the cache after 02:05 UTC daily.

---

### BUG #5 — `replaceState` SPA Navigation Silently Dropped

#### [MODIFY] [instrument.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/instrument.ts)

Add `replaceState` instrumentation alongside the existing `pushState` instrumentation.

```diff
 export function instrumentHistoryBuiltIns(callback: () => void) {
     const origPushState = history.pushState;
+    const origReplaceState = history.replaceState;

     // eslint-disable-next-line
     history.pushState = function (data, title /*, url */) {
         // eslint-disable-next-line
         origPushState.apply(this, arguments as any);
         callback();
     };

+    // eslint-disable-next-line
+    history.replaceState = function (data, title /*, url */) {
+        // eslint-disable-next-line
+        origReplaceState.apply(this, arguments as any);
+        callback();
+    };
+
     const listener = () => {
         callback();
     };
     addEventListener("popstate", listener);

     return () => {
         history.pushState = origPushState;
+        history.replaceState = origReplaceState;
         removeEventListener("popstate", listener);
     };
 }
```

> [!NOTE]
> **Stability**: Additive only. Existing `pushState` and `popstate` tracking is unchanged. Users on older tracker versions are unaffected. The only behavioral change is **more pageviews** get tracked, not fewer.

---

### BUG #4 — Negative Bounce Values Not Corrected in D1 Time Series

#### [MODIFY] [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts)

Apply the same negative-bounce correction algorithm (already proven in WAE's `query.ts:330-343`) to the merged time series data, after merging D1 + WAE.

The fix is applied **after** `mergeTimeSeries()` and **before** returning, adding a `fixNegativeBounces()` helper:

```typescript
// Add after the mergeTimeSeries function (around line 125)

/**
 * Fix negative bounce values in sorted time series data.
 * Replicates the correction logic from query.ts getViewsGroupedByInterval.
 */
function fixNegativeBounces(sorted: ViewsGroupedByInterval): ViewsGroupedByInterval {
    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i][1];
        if (current.bounces < 0) {
            for (let j = i - 1; j >= 0; j--) {
                const prev = sorted[j][1];
                if (prev.bounces > 0) {
                    prev.bounces += current.bounces;
                    current.bounces = 0;
                    break;
                }
            }
        }
    }
    return sorted;
}
```

Then apply it before returning in `getViewsGroupedByInterval`:

```diff
         const merged = mergeTimeSeries(d1Data, waeData);
+        // Fix negative bounces in merged D1+WAE data (same logic as WAE-only path)
+        fixNegativeBounces(merged);
```

Also apply after the MONTH and WEEK aggregation paths:

```diff
-            return Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
+            return fixNegativeBounces(Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0])));
```

```diff
-            return Array.from(weekly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
+            return fixNegativeBounces(Array.from(weekly.entries()).sort((a, b) => a[0].localeCompare(b[0])));
```

> [!NOTE]
> **Stability**: Only affects extended-interval time series (>90d). The fix is cosmetic — it clamps negative bounces to zero. WAE-only paths are untouched.

---

### BUG #8 — SQL Injection in WAE Filter Queries

#### [MODIFY] [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts)

Sanitize filter values by escaping single quotes. WAE doesn't support parameterized queries, so this is the best defense:

```diff
 function filtersToSql(filters: SearchFilters) {
     const supportedFilters: Array<keyof SearchFilters> = [
         "path",
         "referrer",
         "browserName",
         "browserVersion",
         "country",
         "deviceType",
         "utmSource",
         "utmMedium",
         "utmCampaign",
         "utmTerm",
         "utmContent",
     ];

     let filterStr = "";
     supportedFilters.forEach((filter) => {
         if (Object.hasOwnProperty.call(filters, filter)) {
-            filterStr += `AND ${ColumnMappings[filter]} = '${filters[filter]}'`;
+            // Escape single quotes to prevent SQL injection in CF Analytics Engine
+            const sanitized = String(filters[filter]).replace(/'/g, "\\'");
+            filterStr += `AND ${ColumnMappings[filter]} = '${sanitized}'`;
         }
     });
     return filterStr;
 }
```

> [!NOTE]
> **Stability**: Pure security hardening. Normal filter values don't contain single quotes, so behavior is identical for legitimate requests. Only malicious payloads are neutralized.

---

### BUG #12 — `getAllCountsByColumn` Serial Await Harms Performance

#### [MODIFY] [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts)

> [!IMPORTANT]
> **Cannot be parallelized** — the second query **depends** on the first query's results (top-N keys). The bug report itself acknowledges this: *"the second query depends on the first's results"*. The serial `await` is architecturally necessary, not a bug.
>
> **Action: No change.** The existing code comment already acknowledges this constraint. I will update the comment to clarify it is intentional.

```diff
-        // NOTE: there's an await here; need to fix this or harms parallelism
+        // NOTE: Sequential await is required — second query filters by keys from first query results
```

---

## Tier 2 — Low-Risk Additive Changes

These add new code paths or modify cron behavior but don't affect real-time dashboard queries.

---

### BUG #1 — Arrow R2 Backup Cross-Product Explosion

#### [MODIFY] [arrow.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/lib/arrow.ts)

Rewrite the Arrow extraction to use per-column queries (matching D1 aggregation approach) instead of the single cross-product query.

**Key changes:**
1. Filter out `host`, `userAgent`, `newSession` from columns (matching D1 aggregation)
2. Query each column separately using `getAggregationCountsForColumn` instead of `getAllCountsByAllColumnsForAllSites`
3. Also fetch per-site overall counts for completeness

```typescript
// Replace lines 17-27 (column selection + data fetch)
    const columns = Object.keys(ColumnMappings).filter(
        (key) => key !== "siteId" && key !== "newVisitor" && key !== "bounce"
                && key !== "newSession" && key !== "host" && key !== "userAgent",
    ) as (keyof typeof ColumnMappings)[];

    // Use range interval to get active sites
    const rangeInterval = `range:${startDateTime.toISOString()}|${endDateTime.toISOString()}`;
    const sites = await api.getSitesOrderedByHits(rangeInterval, 100);
    const siteIds = sites.map((s) => s[0]);

    // Query each column per site separately to avoid cross-product explosion
    const records: any[] = [];
    for (const siteId of siteIds) {
        for (const col of columns) {
            const countsMap = await api.getAggregationCountsForColumn(
                siteId,
                col,
                startDateTime,
                endDateTime,
            );
            for (const [val, counts] of Object.entries(countsMap)) {
                records.push({
                    date: yesterday.format("YYYY-MM-DD"),
                    siteId,
                    [col]: val,
                    views: counts.views,
                    visitors: counts.visitors,
                    bounces: counts.bounces,
                });
            }
        }
    }
```

> [!NOTE]
> **Stability**: This only affects the daily cron R2 backup, not any dashboard query. The backup data format changes (records are now per-column, not cross-product), but the R2 backfill reader in `backfillFromR2()` will still work because it reads per-column from the Arrow schema. However, since R2 backfill is only used on first-run (no existing D1 data), this is safe.

---

### BUG #11 — D1 Compaction Insert + Delete Not Transactional

#### [MODIFY] [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts)

Wrap the INSERT + DELETE in a `db.batch()` call to make them atomic:

```diff
-        // Insert monthly aggregates
-        await db
-            .prepare(
-                `INSERT INTO daily_aggregates (date, granularity, site_id, dimension_type, dimension_value, views, visitors, bounces)
-                 SELECT ?, 'month', site_id, dimension_type, dimension_value,
-                        SUM(views), SUM(visitors), SUM(bounces)
-                 FROM daily_aggregates
-                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'
-                 GROUP BY site_id, dimension_type, dimension_value`,
-            )
-            .bind(month, month)
-            .run();
-
-        // Delete compacted daily rows
-        await db
-            .prepare(
-                `DELETE FROM daily_aggregates
-                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'`,
-            )
-            .bind(month)
-            .run();
+        // Atomic insert + delete using db.batch() to prevent double-counting
+        // if worker crashes between operations
+        await db.batch([
+            db.prepare(
+                `INSERT INTO daily_aggregates (date, granularity, site_id, dimension_type, dimension_value, views, visitors, bounces)
+                 SELECT ?, 'month', site_id, dimension_type, dimension_value,
+                        SUM(views), SUM(visitors), SUM(bounces)
+                 FROM daily_aggregates
+                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'
+                 GROUP BY site_id, dimension_type, dimension_value`
+            ).bind(month, month),
+            db.prepare(
+                `DELETE FROM daily_aggregates
+                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'`
+            ).bind(month),
+        ]);
```

> [!NOTE]
> **Stability**: Only affects compaction (data >365 days old). No change to daily aggregation or query paths. `db.batch()` is already used extensively in the codebase.

---

### BUG #10 — No R2 Backup Retention/Cleanup

#### [MODIFY] [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts)

Add R2 cleanup after successful D1 aggregation. Delete Arrow files older than 95 days (slightly beyond WAE's 90-day retention as a safety buffer):

```typescript
// Add cleanup logic after runDailyAggregation succeeds
// Delete R2 files older than 95 days (buffer beyond WAE's 90d)
try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 95);
    const objects = await env.DAILY_ROLLUPS.list({ limit: 1000 });
    for (const obj of objects.objects) {
        const match = obj.key.match(/analytics-(\d{4}-\d{2}-\d{2})\.arrow/);
        if (match) {
            const fileDate = new Date(match[1]);
            if (fileDate < cutoffDate) {
                await env.DAILY_ROLLUPS.delete(obj.key);
            }
        }
    }
} catch (cleanupErr) {
    console.error("R2 cleanup error:", cleanupErr);
}
```

> [!NOTE]
> **Stability**: Only runs during cron, only deletes files older than 95 days (well past their useful lifetime). Wrapped in try-catch so cleanup failures don't break aggregation. The 95-day buffer ensures we never delete a file that WAE backfill might still need.

---

### BUG #13 — R2 Backup and D1 Aggregation Race on First Run

#### [MODIFY] [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts)

Ensure R2 backup completes **before** D1 aggregation starts, so backfill can read the Arrow file:

```diff
-            // 1. Run existing Arrow R2 backup
-            ctx.waitUntil(
-                extractAsArrow(...)
-            );
-
-            // 2. Run D1 Aggregation...
-            if ((env as any).ANALYTICS_DB) {
-                ctx.waitUntil(
-                    (async () => { ... })()
-                );
-            }
+            // 1. Run R2 backup first, then D1 aggregation sequentially
+            //    This ensures backfill can read R2 files on first run
+            ctx.waitUntil(
+                (async () => {
+                    await extractAsArrow(
+                        {
+                            accountId: env.CF_ACCOUNT_ID,
+                            bearerToken: env.CF_BEARER_TOKEN,
+                        },
+                        env.DAILY_ROLLUPS,
+                    );
+
+                    if ((env as any).ANALYTICS_DB) {
+                        // ... D1 aggregation runs after R2 backup is complete
+                    }
+                })()
+            );
```

> [!NOTE]
> **Stability**: This makes cron slightly longer (sequential instead of parallel), but cron runs at 02:00 UTC with a 30-second CPU budget, which is more than sufficient. The sequential approach is actually more reliable because it eliminates the race condition.

---

## Tier 3 — Design-Level Considerations (Careful Fix Required)

These bugs have trade-offs and require nuanced fixes.

---

### BUG #2 — WAE Late-Ingestion Causes Permanent Data Loss

> [!IMPORTANT]
> **Fix approach**: Re-aggregate the most recent 2 days on each cron run (not just days after `lastAggregatedDate`). This uses UPSERT so duplicate aggregation is idempotent.

#### [MODIFY] [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts)

In `runDailyAggregation`, after the normal catch-up loop, also **re-aggregate yesterday and the day before** to capture late-arriving WAE data:

```typescript
// After the catch-up loop (lines 604-620), add re-aggregation of recent days
// to capture late-arriving WAE data (eventual consistency fix)
const dayBeforeYesterday = yesterday.subtract(1, "day");
const recentDays = [dayBeforeYesterday, yesterday];

for (const recentDay of recentDays) {
    try {
        await aggregateDay(db, api, recentDay);
    } catch (err) {
        console.error(`Re-aggregation failed for ${recentDay.format("YYYY-MM-DD")}:`, err);
    }
}
```

> [!NOTE]
> **Stability**: Safe because `aggregateDay` uses UPSERT (`ON CONFLICT DO UPDATE`), so re-aggregating is idempotent. It will simply overwrite the previous values with the latest WAE data. This adds ~2 extra WAE queries per cron run (minimal cost). Only affects D1 historical data, not real-time WAE queries.

---

### BUG #6 — Tracker Cache Failure Fallback Inflates Unique Visitors

> [!WARNING]
> **This is a fundamental design trade-off.** The current behavior (fallback `ht=1`) is intentionally chosen to **never silently drop a pageview**. Changing the fallback to "unknown" means the pageview might be dropped or miscounted differently.
>
> **Recommended fix**: Change the fallback from `ht: 1` to `ht: undefined`, and handle `undefined` in the collect endpoint to use its own server-side cache headers for visitor detection (which it already does).

#### [MODIFY] [request.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/request.ts)

```diff
-        const fallbackResponse: CacheResponse = {
-            ht: 1, // Assume first hit (new visit)
-        };
+        const fallbackResponse: CacheResponse = {
+            ht: 0, // Unknown — let server-side cache headers determine visitor status
+        };
```

#### [MODIFY] [track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/track.ts)

```diff
     let hitType: string | undefined;
     try {
         const cacheStatus = await checkCacheStatus(
             client.reporterUrl,
             client.siteId,
         );
-        hitType = cacheStatus.ht.toString();
+        hitType = cacheStatus.ht ? cacheStatus.ht.toString() : undefined;
     } catch {
         // If cache check fails, we proceed without hit count data
+        // The collect endpoint will use its own CF-Cache-Status header as fallback
     }
```

> [!NOTE]
> **Stability**: When `hitType` is `undefined`, the collect endpoint already falls back to CF-Cache-Status headers for visitor detection — this is the existing behavior when the catch block fires. We're just making the timeout/error fallback consistent with the exception path. No change to the collect endpoint required.

---

### BUG #7 — D1 Monthly Row Over-Counting at Date Range Start Boundary

> [!IMPORTANT]
> This is a **query-time precision issue** that only manifests when a compacted monthly row straddles the query start date. Fix is to exclude monthly rows from start-date boundary queries when the start date is not the 1st of the month.

#### [MODIFY] [d1-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-query.ts)

Add a helper function that adjusts the WHERE clause for monthly rows at the start boundary:

```diff
-              AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
+              AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
```

This adds an extra condition: only include a monthly row at the start boundary if the start date is the **1st of the month** (i.e., the entire month is within range). If the start date is mid-month, the monthly row is excluded, and only daily rows (if they exist) are used.

The condition `substr(?, 9, 2) = '01'` checks if the start date is `YYYY-MM-01`.

This change needs to be applied to all D1 query functions that use this WHERE pattern:
- `getD1Counts` (lines 52, 62)
- `getD1ViewsGroupedByInterval` (lines 120, 131)
- `getD1VisitorCountByColumn` (line 187)
- `getD1AllCountsByColumn` (line 225)
- `getD1SitesOrderedByHits` (line 317)

> [!NOTE]
> **Stability**: When the start date IS the 1st of the month, behavior is identical to before. When it's mid-month, we now correctly exclude the monthly row rather than over-counting. Edge case: if daily rows were already compacted away and the monthly row is excluded, that partial month will show as zero. This is **more accurate** than double-counting.

---

### BUG #9 — Server-Side Tracker Hardcodes `ht=1`

> [!WARNING]
> **No safe fix exists without a server-side session store.** Server-side tracking fundamentally lacks browser cookies/cache for visitor detection. The `ht=1` default is the only reasonable behavior — treating every server-side pageview as a unique visit.
>
> **Recommended action**: Add a clear JSDoc warning and leave the behavior as-is. Fixing this properly requires a server-side session/dedup mechanism, which is a major feature, not a bug fix.

#### [MODIFY] [server/track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/server/track.ts)

```diff
-    // Server-side tracking defaults to hit type 1 (new visit)
-    // since we don't have browser session tracking
+    // ⚠️ SERVER-SIDE LIMITATION: Always counts as a new visitor (ht=1)
+    // because there is no browser session/cookie mechanism available.
+    // This means server-side tracked pages will always show 100% bounce rate
+    // and inflated unique visitor counts. This is a known trade-off.
+    // To implement proper deduplication, a server-side session store
+    // (e.g., Redis or KV) would be required.
```

---

## Summary of Changes Per File

| File | Bugs Fixed | Risk Level |
|------|-----------|------------|
| [resources.stats.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx) | #3 | Zero |
| [instrument.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/instrument.ts) | #5 | Zero |
| [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts) | #4 | Zero |
| [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts) | #8, #12 | Zero |
| [arrow.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/lib/arrow.ts) | #1 | Low |
| [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts) | #2, #11 | Low |
| [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts) | #10, #13 | Low |
| [request.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/request.ts) | #6 | Medium |
| [track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/track.ts) | #6 | Medium |
| [d1-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-query.ts) | #7 | Medium |
| [server/track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/server/track.ts) | #9 | Documentation only |

## Open Questions

> [!IMPORTANT]
> **BUG #9 (Server-side ht=1)**: Should I add the documentation comment only, or would you also like me to implement a basic deduplication mechanism (e.g., using a client-supplied visitor ID parameter)?

> [!IMPORTANT]
> **BUG #6 (Cache fallback)**: Are you comfortable with changing the fallback from `ht: 1` (always count as new visitor on failure) to `ht: 0` (let server decide)? The server-side fallback is already there but this changes the tracker's behavior on network errors.

> [!IMPORTANT]
> **BUG #7 (Monthly boundary)**: When a monthly row is excluded due to mid-month start date but daily rows are already compacted, that partial month will show as 0. Is this acceptable (more accurate) or should we keep over-counting (less accurate but higher numbers)?

## Verification Plan

### Automated
- `pnpm build` across all packages to verify compilation
- Check that tracker bundle size doesn't significantly increase

### Manual
- Verify dashboard loads correctly for all interval selections (today, 7d, 30d, 90d, 365d, all)
- Confirm stats card caches correctly for extended intervals (no instant expiry)
- Test filter parameters don't break with special characters (SQL injection test)
