# 🔴 Seeflare Deep Scan — Critical Bug Audit

> **Scan Scope:** Every source file in the codebase — Tracker, Server, WAE Query, D1 Aggregation, Unified Query, Cache Layer, Arrow R2 Backup, Worker Cron, Dashboard Routes.
>
> **Reference Document:** [en-how-it-work.md](file:///c:/Users/Admin/Desktop/see-flare/seeflare/how/en-how-it-work.md)
>
> **Methodology:** Line-by-line code analysis cross-referenced against documented architecture and data flow.

---

## Summary Table

| # | Severity | Component | Bug Title | Impact Domain |
|---|----------|-----------|-----------|---------------|
| 1 | 🔴 FATAL | Arrow R2 Backup | Cross-product explosion truncates backup data | Database Backup |
| 2 | 🔴 FATAL | D1 Aggregation | WAE late-ingestion causes permanent data loss | Data Accuracy |
| 3 | 🔴 FATAL | Stats Route | Cache TTL=0 defeats caching for extended intervals | User Experience |
| 4 | 🔴 CRITICAL | Unified Query | Negative bounce values not corrected in D1 time series | Data Presentation |
| 5 | 🔴 CRITICAL | Tracker | `replaceState` SPA navigation silently dropped | Data Accuracy |
| 6 | 🔴 CRITICAL | Tracker | Cache failure fallback inflates unique visitors | Data Accuracy |
| 7 | 🔴 CRITICAL | D1 Query | Monthly row over-counting at date range start boundary | Data Presentation |
| 8 | 🟠 MAJOR | WAE Query | SQL injection in filter values | Security |
| 9 | 🟠 MAJOR | Server Tracker | `ht=1` hardcoded inflates server-side visitor counts | Data Accuracy |
| 10 | 🟠 MAJOR | Arrow R2 | No backup retention/cleanup — unbounded R2 growth | Operations |
| 11 | 🟠 MAJOR | D1 Compaction | Insert + Delete not transactional — double-counting window | Database Integrity |
| 12 | 🟠 MAJOR | WAE Query | `getAllCountsByColumn` serial await harms performance | User Experience |
| 13 | 🟠 MAJOR | Cron Worker | R2 backup and D1 aggregation race on first run | Database Backup |

---

## 🔴 BUG #1 — FATAL: Arrow R2 Backup Cross-Product Explosion

> [!CAUTION]
> R2 backup data may be silently truncated, making historical backfill incomplete and permanently inaccurate.

**Files:**
- [arrow.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/lib/arrow.ts) — Lines 18–27
- [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts) — Lines 974–1034
- [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts) — Lines 204–225

### Root Cause

The Arrow R2 backup uses [`getAllCountsByAllColumnsForAllSites()`](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts#L974-L1034) which groups by **ALL dimension columns simultaneously** in a single WAE SQL query:

```sql
GROUP BY date, siteId, isVisitor, isBounce, blob1, blob2, blob3, blob4, ...blob15
```

This creates a **Cartesian cross-product** of all dimension values. For a site with 100 paths × 50 countries × 20 browsers × 3 device types = **300,000+ unique combinations per day**. The WAE query has no explicit `LIMIT` in the outer query, but the internal row limit of WAE will **silently truncate** results.

### Contrast with D1 Aggregation (Correct Approach)

The D1 aggregation ([d1-aggregation.ts:204-225](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts#L204-L225)) correctly avoids this by querying **each dimension separately**:

```typescript
// ✅ D1 Aggregation: One query per dimension
for (const col of columns) {
    const countsMap = await api.getAggregationCountsForColumn(siteId, col, ...);
}
```

```typescript
// ❌ Arrow Backup: ALL columns in ONE query
const data = await api.getAllCountsByAllColumnsForAllSites(columns, ...);
```

### Additional Issue: Column Mismatch

The Arrow extraction in [arrow.ts:18-20](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/lib/arrow.ts#L18-L20) includes `newSession`, `host`, and `userAgent` (high-cardinality fields), further exploding the cross-product:

```typescript
// arrow.ts — includes host, userAgent, newSession
const columns = Object.keys(ColumnMappings).filter(
    (key) => key !== "siteId" && key !== "newVisitor" && key !== "bounce",
);
// Result: host, userAgent, path, country, referrer, browserName, deviceModel,
//         browserVersion, deviceType, utmSource, utmMedium, utmCampaign,
//         utmTerm, utmContent, newSession — 15 columns!
```

Compare with D1 aggregation which **correctly excludes** `host`, `userAgent`, and `newSession`:

```typescript
// d1-aggregation.ts — excludes host, userAgent, newSession
const columns = Object.keys(ColumnMappings).filter(
    (key) => key !== "siteId" && key !== "newVisitor" && key !== "bounce"
            && key !== "newSession" && key !== "host" && key !== "userAgent",
);
```

### Impact
- R2 backups contain **truncated, incomplete data** for any day with significant traffic
- D1 backfill from R2 (first-run scenario) will restore **incomplete historical data**
- Data loss is **permanent** — once WAE's 90-day retention expires, the truncated R2 backup is the only remaining copy

---

## 🔴 BUG #2 — FATAL: WAE Late-Ingestion Causes Permanent Data Loss in D1

> [!CAUTION]
> If WAE hasn't finished ingesting yesterday's events by 02:00 UTC, the aggregation captures incomplete data that is never re-aggregated.

**Files:**
- [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts) — Lines 604–620
- [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts) — Lines 30–67

### Root Cause

The cron job runs at **02:00 UTC** and aggregates yesterday's data:

```typescript
// d1-aggregation.ts:546
const yesterday = dayjs().subtract(1, "day");
```

After successful aggregation, the date is marked as done:

```typescript
// d1-aggregation.ts:615-618
await setLastAggregatedDate(db, nextDate.format("YYYY-MM-DD"));
nextDate = nextDate.add(1, "day");
```

The catch-up logic only aggregates days **AFTER** `lastAggregatedDate`:

```typescript
// d1-aggregation.ts:606
let nextDate = dayjs(lastAggregated).add(1, "day");
```

### The Problem

WAE is a distributed system with **eventual consistency**. If events from 23:50 UTC on May 29th are still being ingested into WAE at 02:00 UTC on May 30th, the aggregation query will miss those events. Once May 29th is marked as aggregated, it is **never re-queried**. The missing events are permanently lost from D1.

### Impact
- Late-night traffic (UTC 23:00–23:59) is systematically undercounted in D1 historical data
- For sites in UTC+N timezones, this affects a larger portion of their "afternoon" traffic
- The discrepancy is invisible — users see lower numbers in "All Time" view vs what they remember from the "Last 7 Days" view when the data was still in WAE

---

## 🔴 BUG #3 — FATAL: Stats Cache TTL=0 Defeats Caching for Extended Intervals

> [!WARNING]
> The stats endpoint for extended intervals (>90d, All Time) passes `ttl=0`, making every request a cache miss and triggering expensive D1+WAE queries on every page load.

**File:** [resources.stats.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx) — Line 70

### Root Cause

```typescript
// resources.stats.tsx:70
const cacheResult = await getCachedOrFetch(cacheKey, fetchData, 0); // ← TTL = 0
```

The `setCache` function stores this as:

```typescript
// cache-layer.ts:100
"Cache-Control": `s-maxage=${ttlSeconds}`, // → "s-maxage=0"
```

This creates a cache entry that **expires immediately**. Every dashboard load with "All Time" or ">90 Days" selected triggers:
1. A `getCached()` call → **always misses** (entry expired at creation)
2. Full `fetchData()` → parallel D1 + WAE queries
3. A `setCache()` call → stores result that immediately expires

### Contrast with Other Routes

Other resource routes use the **correct default TTL**:

```typescript
// resources.timeseries.tsx:80
const cacheResult = await getCachedOrFetch(cacheKey, fetchData); // ← uses DEFAULT_TTL_SECONDS (60)

// resources.paths.tsx:50
const cacheResult = await getCachedOrFetch(cacheKey, fetchData); // ← uses DEFAULT_TTL_SECONDS (60)
```

### Impact
- **Severe performance degradation** for "All Time" and extended interval stats
- Every dashboard load triggers expensive cross-database queries instead of serving cached results
- Users experience slow loading times for the top-level stats card (Visitors, Views, Bounce Rate)
- Increased Cloudflare Worker CPU time and D1 read units, raising operational costs

### Fix

```diff
- const cacheResult = await getCachedOrFetch(cacheKey, fetchData, 0);
+ const cacheResult = await getCachedOrFetch(cacheKey, fetchData);
```

---

## 🔴 BUG #4 — CRITICAL: Negative Bounce Values Not Corrected in D1 Time Series

> [!IMPORTANT]
> The dashboard time series chart can display negative bounce rates (e.g., "-50%") for historical data sourced from D1, confusing users.

**Files:**
- [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts) — Lines 324–343 (WAE correction logic)
- [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts) — Lines 319–351 (missing correction)
- [resources.timeseries.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.timeseries.tsx) — Lines 59–61 (bounce rate calculation)

### Root Cause

WAE's [`getViewsGroupedByInterval`](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts#L324-L343) has sophisticated negative-bounce correction:

```typescript
// query.ts:330-343 — WAE fixes negative bounces by backtracking through time
for (let i = 1; i < sortedRows.length; i++) {
    const current = sortedRows[i][1];
    if (current.bounces < 0) {
        for (let j = i - 1; j >= 0; j--) {
            const prev = sortedRows[j][1];
            if (prev.bounces > 0) {
                prev.bounces += current.bounces;
                current.bounces = 0; // zero-out
                break;
            }
        }
    }
}
```

**This correction is NOT applied** to the merged D1+WAE data in [`unified-query.ts`](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L319-L351):

```typescript
// unified-query.ts:319 — D1 data merged raw, no bounce correction
const merged = mergeTimeSeries(d1Data, waeData);
// ← No negative bounce fix applied to merged result!
```

### Why D1 Data Has Negative Bounces

A visitor who lands on the site at 23:55 UTC (Day 1) and clicks a second page at 00:05 UTC (Day 2):
- **Day 1** in D1: `bounces = +1` (initial bounce recorded)
- **Day 2** in D1: `bounces = -1` (anti-bounce correction)

When displayed as a daily time series, Day 2 shows a **negative bounce count**, which the UI renders as:

```typescript
// resources.timeseries.tsx:59-61
bounceRate: Math.floor(
    (visitors > 0 ? bounces / visitors : 0) * 100,
),
// → If bounces=-5, visitors=10 → bounceRate = -50 → displays "-50%"
```

### Impact
- Dashboard chart shows **nonsensical negative bounce rates** for historical days
- Users lose trust in the analytics data
- The bug specifically affects the D1 data zone (>90 days old), making historical data look broken

---

## 🔴 BUG #5 — CRITICAL: `replaceState` SPA Navigation Silently Dropped

> [!WARNING]
> SPA frameworks that use `history.replaceState()` for navigation will have those pageviews silently untracked.

**File:** [instrument.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/instrument.ts) — Lines 1–25

### Root Cause

The tracker only instruments `pushState` and `popstate`:

```typescript
// instrument.ts:2,10 — Only pushState is patched
const origPushState = history.pushState;
history.pushState = function (data, title) {
    origPushState.apply(this, arguments as any);
    callback(); // ← triggers trackPageview
};

// instrument.ts:19 — Only popstate is listened to
addEventListener("popstate", listener);
```

**`history.replaceState` is NOT instrumented.** Many SPA frameworks use `replaceState` for:
- Redirect-after-login flows
- URL normalization (e.g., removing trailing slashes)
- Hash-based routing fallbacks
- Query parameter updates that represent new "pages"
- Next.js `router.replace()`, React Router `<Navigate replace />`

### Impact
- Pageviews triggered via `replaceState` are **never recorded**
- Visitor counts, path analytics, and referrer data are **undercounted**
- Affects any site using React Router's `replace` navigation, Next.js redirects, or similar patterns

### Fix

```diff
export function instrumentHistoryBuiltIns(callback: () => void) {
    const origPushState = history.pushState;
+   const origReplaceState = history.replaceState;

    history.pushState = function (data, title) {
        origPushState.apply(this, arguments as any);
        callback();
    };

+   history.replaceState = function (data, title) {
+       origReplaceState.apply(this, arguments as any);
+       callback();
+   };

    const listener = () => { callback(); };
    addEventListener("popstate", listener);

    return () => {
        history.pushState = origPushState;
+       history.replaceState = origReplaceState;
        removeEventListener("popstate", listener);
    };
}
```

---

## 🔴 BUG #6 — CRITICAL: Tracker Cache Failure Fallback Inflates Unique Visitors

> [!IMPORTANT]
> Any network failure during the Phase 1 cache check causes the visitor to be counted as a **new unique visitor**, creating phantom bounces and inflating visitor counts.

**Files:**
- [request.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/request.ts) — Lines 16–54
- [track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/track.ts) — Lines 97–107

### Root Cause

The `/cache` endpoint XHR has a **1-second timeout** and a **fallback of `ht: 1`**:

```typescript
// request.ts:4,18-19
const REQUEST_TIMEOUT = 1000; // 1 second

const fallbackResponse: CacheResponse = {
    ht: 1, // ← Assume first hit (new visit)
};

xhr.onerror = () => resolve(fallbackResponse);   // ← fallback on network error
xhr.ontimeout = () => resolve(fallbackResponse);  // ← fallback on timeout
```

In the tracker, if the cache check throws, the code proceeds **without hit type data**:

```typescript
// track.ts:97-107
let hitType: string | undefined;
try {
    const cacheStatus = await checkCacheStatus(...);
    hitType = cacheStatus.ht.toString();
} catch {
    // If cache check fails, we proceed without hit count data
}
```

If `hitType` is `undefined`, the collect endpoint falls back to its own cache header logic (which also defaults to `ht=1` for first-time requests).

### Scenarios That Trigger False `ht=1`

1. **Mobile networks** — high latency, frequent timeouts within 1 second
2. **Ad blockers** — may block the `/cache` XHR
3. **CORS misconfiguration** — cross-origin requests fail silently
4. **Server overload** — `/cache` route responds slowly
5. **DNS resolution delays** — first request to a new domain

### Impact
- **Inflated unique visitor counts** — the same returning visitor is counted as new
- **Inflated bounce rate** — each false `ht=1` creates a bounce that may never get an anti-bounce
- On high-latency networks (e.g., mobile in developing countries), this systematically over-reports visitors

---

## 🔴 BUG #7 — CRITICAL: D1 Monthly Row Over-Counting at Date Range Start Boundary

> [!IMPORTANT]
> When a query's start date falls within a compacted monthly period, the **full month's data** is included instead of only the portion within the date range.

**File:** [d1-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-query.ts) — Lines 46–65

### Root Cause

D1 queries use this WHERE clause pattern to include monthly rows:

```sql
WHERE site_id = ? AND dimension_type = ?
  AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7)))
  AND date <= ?
```

The `OR` clause ensures a monthly row whose date format is `YYYY-MM` (e.g., `'2024-06'`) is included even when `date >= '2024-06-15'` would normally exclude it (because `'2024-06' < '2024-06-15'` in string comparison).

**The problem:** The OR clause includes **ALL data for that month**, not just the portion from `startDate` onwards. If startDate is `2024-06-15` and there's a compacted monthly row for `2024-06`, it includes June 1–30 data, but only June 15–30 should be counted.

### When This Occurs

- User selects "365d" interval → `startDate` ≈ 365 days ago
- Compaction threshold is also 365 days
- If a month right at the boundary has been compacted, partial month over-counting occurs

### Impact
- Visitors, views, and bounces for the start month are **over-reported** in extended interval queries
- The discrepancy grows larger when the start date is in the middle of a month
- Most visible in the "365d" interval selection

---

## 🟠 BUG #8 — MAJOR: SQL Injection in WAE Filter Queries

> [!WARNING]
> Filter values from URL parameters are directly interpolated into SQL strings without sanitization. While CF Analytics Engine only supports SELECT, attackers can exfiltrate other sites' data.

**File:** [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts) — Lines 150–172

### Root Cause

```typescript
// query.ts:166-170
function filtersToSql(filters: SearchFilters) {
    supportedFilters.forEach((filter) => {
        if (Object.hasOwnProperty.call(filters, filter)) {
            filterStr += `AND ${ColumnMappings[filter]} = '${filters[filter]}'`;
            //                                             ^^^^^^^^^^^^^^^^
            //                                             Unsanitized user input!
        }
    });
}
```

Filter values originate from URL search parameters:

```typescript
// utils.ts:28-29
if (searchParams.has("path")) {
    filters.path = searchParams.get("path") || ""; // ← direct from URL
}
```

### Attack Example

```
/resources/paths?site=mysite&interval=7d&path=' OR 1=1 UNION SELECT blob8, COUNT(*), 0 FROM metricsDataset GROUP BY blob8 --
```

This would expose **all site IDs** in the analytics engine, allowing an attacker to enumerate and then query other users' analytics data.

### Impact
- **Cross-tenant data leakage** — attacker can read any site's analytics
- **Denial of Service** — crafted expensive queries consume Worker CPU limits
- The existing comment in the code (line 174-183) acknowledges this risk but incorrectly dismisses it

---

## 🟠 BUG #9 — MAJOR: Server-Side Tracker Hardcodes `ht=1`, Inflating Visitors

> [!NOTE]
> Every server-side tracked pageview is counted as a unique visitor, regardless of whether the same user has visited before.

**File:** [server/track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/server/track.ts) — Line 92

### Root Cause

```typescript
// server/track.ts:84-92
// Server-side tracking defaults to hit type 1 (new visit)
// since we don't have browser session tracking
const requestParams = buildCollectRequestParams(
    client.siteId,
    hostname,
    path,
    referrer,
    utmParams,
    "1", // ← Always ht=1 (new visitor)
);
```

### Impact
- Sites using server-side tracking (e.g., API endpoints, webhooks, SSR pages) will have **massively inflated** visitor counts
- Every server-side pageview creates a bounce that is never corrected (no `ht=2` anti-bounce)
- Bounce rate is always **100%** for server-side tracked pages
- Mixing client-side and server-side tracking produces inconsistent data

---

## 🟠 BUG #10 — MAJOR: No R2 Backup Retention/Cleanup — Unbounded Storage Growth

> [!NOTE]
> Arrow backup files accumulate in R2 indefinitely with no deletion policy, leading to unbounded storage costs.

**Files:**
- [arrow.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/lib/arrow.ts) — Line 59
- [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts) — Lines 30–38

### Root Cause

The daily cron creates a new Arrow file every day:

```typescript
// arrow.ts:59
await bucket.put(filename, arrowBuffer); // → analytics-2025-05-30.arrow
```

But there is **no cleanup logic** anywhere in the codebase. Files accumulate at approximately:
- ~1-5 MB per day per site (depending on traffic)
- ~365-1825 MB per year per site

### Impact
- R2 storage costs grow linearly forever
- After D1 aggregation has captured the data, the R2 files are redundant (used only for first-run backfill)
- No lifecycle policy is configured in `wrangler.json`

### Fix Suggestion

Add cleanup to the cron job after successful D1 aggregation:

```typescript
// Delete R2 files older than 90 days (WAE retention matches)
const cutoff = dayjs().subtract(90, "day");
const objects = await bucket.list({ limit: 1000 });
for (const obj of objects.objects) {
    const match = obj.key.match(/analytics-(\d{4}-\d{2}-\d{2})\.arrow/);
    if (match && dayjs(match[1]).isBefore(cutoff)) {
        await bucket.delete(obj.key);
    }
}
```

---

## 🟠 BUG #11 — MAJOR: D1 Compaction Insert + Delete Not Transactional

> [!NOTE]
> The monthly compaction performs INSERT and DELETE as separate non-batched operations, creating a window for double-counting.

**File:** [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts) — Lines 484–503

### Root Cause

```typescript
// Step 1: INSERT monthly aggregate (line 484-494)
await db.prepare(`INSERT INTO daily_aggregates ...`).run();

// Step 2: DELETE daily rows (line 497-503) — SEPARATE operation!
await db.prepare(`DELETE FROM daily_aggregates ...`).run();
```

If the Worker hits a CPU limit or crashes between Step 1 and Step 2:
- Monthly aggregate exists ✅
- Daily rows also still exist ❌
- Next query returns **both** → **double-counted data**

The `existingMonthly` guard (lines 463-480) prevents re-inserting the monthly row, and will attempt to delete dailies. But if the delete also fails, double-counting persists.

### Fix

Use `db.batch()` to make it atomic:

```typescript
await db.batch([
    db.prepare(`INSERT INTO daily_aggregates ... SELECT ...`).bind(month, month),
    db.prepare(`DELETE FROM daily_aggregates WHERE ...`).bind(month),
]);
```

---

## 🟠 BUG #12 — MAJOR: `getAllCountsByColumn` Serial Await Harms Performance

> [!NOTE]
> The WAE query for dimension breakdowns (paths, referrers, etc.) makes two sequential API calls when they could be parallelized.

**File:** [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts) — Lines 548–557

### Root Cause

```typescript
// query.ts:548-557 — Comment acknowledges the issue
// NOTE: there's an await here; need to fix this or harms parallelism
const visitorCountByColumn = await this.getVisitorCountByColumn(
    siteId, column, interval, tz, filters, page, limit,
);
// ... then a second query uses the results
```

The first query fetches top-N dimension values by visitor count. The second query fetches non-visitor counts for those same values. These are **serialized** because the second query depends on the first's results.

### Impact
- Each dimension tab (Paths, Referrers, Countries, etc.) takes **~2x longer** than necessary
- With 15 dimensions queried in the combined API endpoint, this adds significant latency
- Most visible on the dashboard initial load where all dimensions are fetched simultaneously

---

## 🟠 BUG #13 — MAJOR: R2 Backup and D1 Aggregation Race on First Run

> [!NOTE]
> On the very first cron execution, R2 backup and D1 aggregation run concurrently. The D1 backfill reads R2 files that may not yet be written.

**File:** [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts) — Lines 30–67

### Root Cause

Both operations are launched independently via `ctx.waitUntil`:

```typescript
// app.ts:30-38 — R2 backup starts
ctx.waitUntil(extractAsArrow(...));

// app.ts:42-67 — D1 aggregation starts CONCURRENTLY
ctx.waitUntil((async () => {
    await runDailyAggregation(env.ANALYTICS_DB, api, env.DAILY_ROLLUPS, ...);
    // ↑ On first run, this calls backfillFromR2() which reads R2 files
})());
```

On the **first-ever cron run**, there are no previous R2 files. The Arrow backup is creating **yesterday's** file, while the D1 backfill is also looking for files. These operations run simultaneously with no coordination.

### Mitigating Factor

In practice, the backfill reads previously-created files (from past cron runs), not the file being written concurrently. Since this is the first-ever run, there are no past files, so the backfill finds nothing and proceeds to aggregate only yesterday from WAE. This is more of a design concern than an active bug, but it means the first-run R2 backfill is effectively a no-op, wasting the R2 backup from the same cron execution.

---

## Architecture-Level Observations

### 1. No Monitoring or Alerting for Aggregation Failures

The cron job catches errors and logs them (`console.error`), but there is no external alerting mechanism. If D1 aggregation silently fails for multiple days, the only symptom is missing historical data in the dashboard, which users might not notice until months later.

### 2. No Data Integrity Verification

There is no mechanism to verify that D1 aggregated data matches WAE data for the same period. During the 90-day overlap window, the system could validate D1 against WAE to detect aggregation errors, but this is not implemented.

### 3. Single-Filter Limitation in D1 Queries

The unified query's `canUseD1` check ([unified-query.ts:382-385](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L382-L385)) only supports a single filter for D1 queries. If the dashboard sends multiple simultaneous filters with an extended interval, D1 data is silently excluded:

```typescript
const canUseD1 =
    activeFilters.length === 0 ||
    (activeFilters.length === 1 && activeFilters[0] === dimensionType);
```

This means multi-filter combinations for extended intervals show **only WAE data** (last 90 days), silently dropping historical data.
