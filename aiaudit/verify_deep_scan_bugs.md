# Seeflare Bug Verification & Deep Scan Results

Based on the instructions, a deep scan and line-by-line verification was conducted across the entire codebase to validate the 13 bugs identified in `deep_scan_critical_bugs.md`. 

Each bug was cross-referenced with the codebase structure, specifically `query.ts`, `d1-aggregation.ts`, `unified-query.ts`, `track.ts`, `instrument.ts`, `arrow.ts`, and `app.ts`. 

Here are the detailed findings and scorings:

---

### 🔴 BUG #1 — FATAL: Arrow R2 Backup Cross-Product Explosion
* **Files Scanned:** `packages/server/workers/lib/arrow.ts`, `packages/server/app/analytics/query.ts`
* **Verification:** `arrow.ts` calls `getAllCountsByAllColumnsForAllSites` requesting 15 columns simultaneously. `query.ts` implements this as a single `SELECT ... GROUP BY date, siteId, isVisitor, isBounce, [15 columns]`. This unconditionally triggers a Cartesian cross-product that exceeds the 10,000-row Cloudflare WAE limit, leading to silent truncation.
* **Score:** **VERIFIED BUG (FATAL)**

### 🔴 BUG #2 — FATAL: WAE Late-Ingestion Causes Permanent Data Loss in D1
* **Files Scanned:** `packages/server/app/analytics/d1-aggregation.ts`, `packages/server/workers/app.ts`
* **Verification:** `runDailyAggregation` marks the previous day as aggregated at exactly 02:00 UTC using `setLastAggregatedDate`. The `nextDate` loop only moves forward. If WAE's eventual consistency causes data to arrive after 02:00 UTC, D1 never goes back to re-query that date. 
* **Score:** **VERIFIED BUG (FATAL)**

### 🔴 BUG #3 — FATAL: Stats Cache TTL=0 Defeats Caching for Extended Intervals
* **Files Scanned:** `packages/server/app/routes/resources.stats.tsx`, `packages/server/app/analytics/cache-layer.ts`
* **Verification:** In `resources.stats.tsx` line 70, `getCachedOrFetch(cacheKey, fetchData, 0)` explicitly hardcodes a TTL of 0 seconds. `cache-layer.ts` writes this as `s-maxage=0`, making the Edge Cache immediately expire, forcing expensive D1+WAE queries on every load for interval > 90 days.
* **Score:** **VERIFIED BUG (FATAL)**

### 🔴 BUG #4 — CRITICAL: Negative Bounce Values Not Corrected in D1 Time Series
* **Files Scanned:** `packages/server/app/analytics/query.ts`, `packages/server/app/analytics/unified-query.ts`, `packages/server/app/routes/resources.timeseries.tsx`
* **Verification:** WAE's native `getViewsGroupedByInterval` correctly iterates backwards to fix sparse negative bounces. However, `unified-query.ts` merges D1 historical data via `mergeTimeSeries(d1Data, waeData)` but never applies the negative-bounce correction logic to the merged dataset. The UI then calculates and displays negative percentages.
* **Score:** **VERIFIED BUG (CRITICAL)**

### 🔴 BUG #5 — CRITICAL: `replaceState` SPA Navigation Silently Dropped
* **Files Scanned:** `packages/tracker/src/lib/instrument.ts`
* **Verification:** `instrument.ts` only wraps `history.pushState` and `popstate`. It explicitly misses `history.replaceState`. Thus, modern SPAs (like Next.js router.replace or React Router) will drop pageviews.
* **Score:** **VERIFIED BUG (CRITICAL)**

### 🔴 BUG #6 — CRITICAL: Tracker Cache Failure Fallback Inflates Unique Visitors
* **Files Scanned:** `packages/tracker/src/lib/request.ts`, `packages/tracker/src/lib/track.ts`
* **Verification:** `checkCacheStatus` catches `xhr.onerror` and `xhr.ontimeout` by returning `fallbackResponse` which is `{ ht: 1 }`. `track.ts` uses this returned value as a valid response if network fails, unconditionally assigning a "new visitor" state instead of an undefined/unknown hit type.
* **Score:** **VERIFIED BUG (CRITICAL)**

### 🔴 BUG #7 — CRITICAL: D1 Monthly Row Over-Counting at Date Range Start Boundary
* **Files Scanned:** `packages/server/app/analytics/d1-query.ts`
* **Verification:** The SQL query uses `(date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?`. When querying from the middle of a month (e.g. `2024-05-15`), the `substr(?, 1, 7)` evaluates to `2024-05`. The entire month's compacted row is matched and included, heavily skewing metrics.
* **Score:** **VERIFIED BUG (CRITICAL)**

### 🟠 BUG #8 — MAJOR: SQL Injection in WAE Filter Queries
* **Files Scanned:** `packages/server/app/analytics/query.ts`
* **Verification:** In `filtersToSql`, user-provided filter values from the URL are directly interpolated into the SQL string without parameterized bindings or escaping: `AND ${ColumnMappings[filter]} = '${filters[filter]}'`. While WAE restricts to `SELECT`, this still enables cross-tenant data scraping.
* **Score:** **VERIFIED BUG (MAJOR)**

### 🟠 BUG #9 — MAJOR: Server-Side Tracker Hardcodes `ht=1`, Inflating Visitors
* **Files Scanned:** `packages/tracker/src/server/track.ts`
* **Verification:** In `server/track.ts`, the tracker defaults to `buildCollectRequestParams(..., "1")`. This ensures every server-side pageview creates a unique visitor and a 100% bounce rate since no state is maintained.
* **Score:** **VERIFIED BUG (MAJOR)**

### 🟠 BUG #10 — MAJOR: No R2 Backup Retention/Cleanup — Unbounded Storage Growth
* **Files Scanned:** `packages/server/workers/lib/arrow.ts`, `packages/server/workers/app.ts`
* **Verification:** `arrow.ts` writes a new `.arrow` file using `bucket.put(filename, arrowBuffer)`. There is zero `bucket.delete` logic anywhere in the repository to clean up older files. Storage will grow infinitely.
* **Score:** **VERIFIED BUG (MAJOR)**

### 🟠 BUG #11 — MAJOR: D1 Compaction Insert + Delete Not Transactional
* **Files Scanned:** `packages/server/app/analytics/d1-aggregation.ts`
* **Verification:** `compactOldData` performs an `INSERT INTO daily_aggregates` via `.run()` followed by a separate `DELETE FROM daily_aggregates` via `.run()`. Without using `db.batch()`, a Worker interruption causes double-counted data permanently.
* **Score:** **VERIFIED BUG (MAJOR)**

### 🟠 BUG #12 — MAJOR: `getAllCountsByColumn` Serial Await Harms Performance
* **Files Scanned:** `packages/server/app/analytics/query.ts`
* **Verification:** `getAllCountsByColumn` literally contains a comment `// NOTE: there's an await here; need to fix this or harms parallelism`. It awaits `getVisitorCountByColumn` completely blocking before doing the second query.
* **Score:** **VERIFIED BUG (MAJOR)**

### 🟠 BUG #13 — MAJOR: R2 Backup and D1 Aggregation Race on First Run
* **Files Scanned:** `packages/server/workers/app.ts`
* **Verification:** In the Cron handler, `ctx.waitUntil(extractAsArrow(...))` and `ctx.waitUntil(runDailyAggregation(...))` are dispatched simultaneously. If it's the first run, D1 tries to backfill from R2 while R2 is actively being written. 
* **Score:** **VERIFIED BUG (MAJOR)**

---

## Conclusion

**13 of 13 reported bugs are formally verified and confirmed as true defects.** None of the reported bugs are false positives or ignorable. The instructions provided in `deep_scan_critical_bugs.md` are technically accurate, mapping perfectly to codebase defects.
