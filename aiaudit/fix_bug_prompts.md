# Seeflare Bug Fix Prompts — Individual Agent Instructions

> **Purpose:** Each section below is a standalone, self-contained prompt for a single bug fix.
> An AI agent executing a prompt must ONLY read the specified file, make EXACTLY the described change, and verify using the stated check.
> No other files should be modified unless explicitly listed.
> Do NOT refactor, rename, reformat, or add anything beyond what is described.

---

## PROMPT #3 — Fix Stats Cache TTL=0

### Context
The stats endpoint for extended intervals (>90 days, "All Time") explicitly passes `ttl=0` to `getCachedOrFetch`. This causes the cache to expire immediately upon creation, forcing expensive D1+WAE queries on every single dashboard load. Other route files (timeseries, paths) correctly omit this argument and use the default 60s TTL.

### File to Modify
`packages/server/app/routes/resources.stats.tsx`

### Step-by-Step Instructions

1. Open the file `packages/server/app/routes/resources.stats.tsx`
2. Find the following line (it is inside the `if (isExtended)` block, approximately line 70):
   ```typescript
           const cacheResult = await getCachedOrFetch(cacheKey, fetchData, 0);
   ```
3. Replace it with:
   ```typescript
           const cacheResult = await getCachedOrFetch(cacheKey, fetchData);
   ```
4. Save the file.

### What You Must NOT Touch
- Do not change anything else in this file.
- Do not change the `fetchData` function.
- Do not change the `buildCacheKey` call.
- Do not modify any imports.

### Verification
After making the change, the file at line ~70 must read:
```typescript
        const cacheResult = await getCachedOrFetch(cacheKey, fetchData);
```
The third argument `0` must be completely absent. No other lines should differ from the original.

---

## PROMPT #5 — Fix `replaceState` SPA Navigation Not Tracked

### Context
The tracker instruments `history.pushState` and `popstate` events, but completely misses `history.replaceState`. SPA frameworks (Next.js `router.replace()`, React Router `<Navigate replace />`) use `replaceState` for redirect-after-login, URL normalization, and hash-based routing. These navigations are silently dropped and never recorded as pageviews.

### File to Modify
`packages/tracker/src/lib/instrument.ts`

### Current File Content (entire file for reference)
```typescript
export function instrumentHistoryBuiltIns(callback: () => void) {
    const origPushState = history.pushState;

    // NOTE: Intentionally only declaring 2 parameters for this pushState wrapper,
    //       because that is the arity of the built-in function we're overwriting.

    // See: https://blog.sentry.io/wrap-javascript-functions/#preserve-arity

    // eslint-disable-next-line
    history.pushState = function (data, title /*, url */) {
        // eslint-disable-next-line
        origPushState.apply(this, arguments as any);
        callback();
    };

    const listener = () => {
        callback();
    };
    addEventListener("popstate", listener);

    return () => {
        history.pushState = origPushState;
        removeEventListener("popstate", listener);
    };
}
```

### Step-by-Step Instructions

Replace the ENTIRE content of `packages/tracker/src/lib/instrument.ts` with the following:

```typescript
export function instrumentHistoryBuiltIns(callback: () => void) {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    // NOTE: Intentionally only declaring 2 parameters for these wrappers,
    //       because that is the arity of the built-in functions we're overwriting.

    // See: https://blog.sentry.io/wrap-javascript-functions/#preserve-arity

    // eslint-disable-next-line
    history.pushState = function (data, title /*, url */) {
        // eslint-disable-next-line
        origPushState.apply(this, arguments as any);
        callback();
    };

    // eslint-disable-next-line
    history.replaceState = function (data, title /*, url */) {
        // eslint-disable-next-line
        origReplaceState.apply(this, arguments as any);
        callback();
    };

    const listener = () => {
        callback();
    };
    addEventListener("popstate", listener);

    return () => {
        history.pushState = origPushState;
        history.replaceState = origReplaceState;
        removeEventListener("popstate", listener);
    };
}
```

### What You Must NOT Touch
- Do not change anything outside this function.
- Do not change the `callback` parameter.
- Do not change the `pushState` or `popstate` logic — only ADD the `replaceState` logic.

### Verification
The final file must contain:
1. `const origReplaceState = history.replaceState;` — declared after `origPushState`
2. A `history.replaceState = function (data, title /*, url */) {` wrapper block
3. `history.replaceState = origReplaceState;` — inside the cleanup return function
4. The `origPushState`, `popstate` logic must remain exactly as before.

---

## PROMPT #4 — Fix Negative Bounce Values in D1 Time Series

### Context
WAE's `getViewsGroupedByInterval` has a correction algorithm that backtracks through time buckets when a negative bounce count appears (caused by an anti-bounce event landing in a different time bucket than the original bounce). This correction is NOT applied when D1 historical data is merged with WAE data in `unified-query.ts`, causing the dashboard time series chart to show nonsensical negative bounce rates (e.g., "-50%") for historical data older than 90 days.

### File to Modify
`packages/server/app/analytics/unified-query.ts`

### Step-by-Step Instructions

#### Change 1 — Add the `fixNegativeBounces` helper function

Find the closing brace of the `mergeTimeSeries` function. It ends around line 125 and looks like:
```typescript
    // Sort by date
    return Array.from(merged.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
    );
}
```

Insert the following new function IMMEDIATELY AFTER that closing brace (add a blank line separator):

```typescript

/**
 * Fix negative bounce values in a sorted time series.
 * Replicates the correction logic from query.ts getViewsGroupedByInterval (lines 330-343).
 *
 * When a visitor bounces at 23:55 on Day 1 and clicks again at 00:05 on Day 2,
 * Day 1 gets +1 bounce and Day 2 gets -1 bounce. This function redistributes
 * the negative value backward to the nearest positive bucket.
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

#### Change 2 — Apply fix to the DAY path

Find this line inside `getViewsGroupedByInterval` (around line 319):
```typescript
        const merged = mergeTimeSeries(d1Data, waeData);
```

Insert a new line immediately AFTER it:
```typescript
        // Fix negative bounces in merged D1+WAE data (mirrors WAE-only correction in query.ts)
        fixNegativeBounces(merged);
```

So the result looks like:
```typescript
        const merged = mergeTimeSeries(d1Data, waeData);
        // Fix negative bounces in merged D1+WAE data (mirrors WAE-only correction in query.ts)
        fixNegativeBounces(merged);
```

#### Change 3 — Apply fix to the MONTH path

Find this line inside the `if (intervalType === "MONTH")` block (around line 333):
```typescript
            return Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
```

Replace it with:
```typescript
            return fixNegativeBounces(Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0])));
```

#### Change 4 — Apply fix to the WEEK path

Find this line inside the `if (intervalType === "WEEK")` block (around line 348):
```typescript
            return Array.from(weekly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
```

Replace it with:
```typescript
            return fixNegativeBounces(Array.from(weekly.entries()).sort((a, b) => a[0].localeCompare(b[0])));
```

### What You Must NOT Touch
- Do not touch any existing function signatures.
- Do not touch the WAE-only code path (the `if (!interval || !isExtendedInterval(interval) || !this.db)` block).
- Do not change `mergeTimeSeries`, `mergeVisitorCounts`, `mergeThreeColumnCounts`, or `mergeSiteLists`.
- Do not change any imports.

### Verification
1. The file must contain a new `fixNegativeBounces` function between `mergeTimeSeries` and `mergeVisitorCounts`.
2. After `mergeTimeSeries(d1Data, waeData)`, there must be a `fixNegativeBounces(merged)` call.
3. Both the MONTH and WEEK return statements must wrap their sort result in `fixNegativeBounces(...)`.
4. No other lines should differ from the original.

---

## PROMPT #8 — Fix SQL Injection in WAE Filter Queries

### Context
The `filtersToSql` function in `query.ts` directly interpolates user-supplied URL parameter values into SQL strings without any escaping. A malicious actor can inject SQL via filter parameters (e.g., `?path=' OR 1=1 --`) to exfiltrate other sites' analytics data. Cloudflare Analytics Engine does not support parameterized queries, so the fix is to escape single quotes in filter values before interpolation.

### File to Modify
`packages/server/app/analytics/query.ts`

### Step-by-Step Instructions

Find the `filtersToSql` function (around lines 150–172). The current implementation of the `forEach` body looks like:

```typescript
    let filterStr = "";
    supportedFilters.forEach((filter) => {
        if (Object.hasOwnProperty.call(filters, filter)) {
            filterStr += `AND ${ColumnMappings[filter]} = '${filters[filter]}'`;
        }
    });
    return filterStr;
```

Replace ONLY the `forEach` body (the lines inside the `forEach` callback) with:

```typescript
    let filterStr = "";
    supportedFilters.forEach((filter) => {
        if (Object.hasOwnProperty.call(filters, filter)) {
            // Escape single quotes to prevent SQL injection via CF Analytics Engine API.
            // Parameterized queries are not supported by WAE; escaping is the only defense.
            const sanitized = String(filters[filter]).replace(/'/g, "\\'");
            filterStr += `AND ${ColumnMappings[filter]} = '${sanitized}'`;
        }
    });
    return filterStr;
```

### What You Must NOT Touch
- Do not change the `supportedFilters` array — leave all 11 filter keys as-is.
- Do not change the function signature or return type.
- Do not change any other function in this file.

### Verification
The modified `filtersToSql` function must:
1. Declare `const sanitized = String(filters[filter]).replace(/'/g, "\\'");` before building the filter string.
2. Use `'${sanitized}'` (not `'${filters[filter]}'`) in the template literal.
3. Contain the escaping comment.
4. The `supportedFilters` array must be unchanged.

---

## PROMPT #12 — Fix Misleading Comment in `getAllCountsByColumn`

### Context
The `getAllCountsByColumn` function in `query.ts` contains a comment that says the sequential `await` is a bug that "needs to be fixed." In reality, the sequential order is architecturally REQUIRED — the second query must filter by the top-N keys returned from the first query. The comment is misleading and should be corrected so future developers don't accidentally break the function trying to "fix" it.

### File to Modify
`packages/server/app/analytics/query.ts`

### Step-by-Step Instructions

Find this comment inside the `getAllCountsByColumn` function (around line 548):
```typescript
        // NOTE: there's an await here; need to fix this or harms parallelism
```

Replace it with:
```typescript
        // NOTE: Sequential await is architecturally required here.
        // The second query must filter by the top-N dimension values returned by this first query.
        // Parallelization is not possible because Query 2 depends on Query 1's results.
```

### What You Must NOT Touch
- Do not change any code — only the comment text changes.
- Do not change the `await` itself or the function call.
- Do not touch any other part of the file.

### Verification
The comment on the line before `const visitorCountByColumn = await this.getVisitorCountByColumn(` must now read the new 3-line comment. The `await` keyword must still be present.

---

## PROMPT #9 — Add Warning Comment to Server-Side Tracker

### Context
The server-side tracker always hardcodes `ht=1` (new visitor) because there is no browser session/cookie mechanism available server-side. This is a known and unavoidable limitation. The current comment is too brief and does not warn developers about the data quality implications. This prompt only adds a more detailed warning comment — no code is changed.

### File to Modify
`packages/tracker/src/server/track.ts`

### Step-by-Step Instructions

Find this comment block (around lines 84–85):
```typescript
    // Server-side tracking defaults to hit type 1 (new visit)
    // since we don't have browser session tracking
    const requestParams = buildCollectRequestParams(
```

Replace ONLY the comment lines with:
```typescript
    // ⚠️ SERVER-SIDE LIMITATION: Always sends ht=1 (new visitor) because
    // there is no browser session or cookie mechanism available server-side.
    // This means server-side tracked pages will always report 100% bounce rate
    // and inflate unique visitor counts. This is a known, unavoidable trade-off
    // of server-side tracking without a session store (e.g., KV or Redis).
    const requestParams = buildCollectRequestParams(
```

### What You Must NOT Touch
- Do NOT change the `"1"` string argument on line 92.
- Do NOT change any function logic.
- Only the comment text changes.

### Verification
The two original comment lines must be replaced with the five-line warning comment. The `const requestParams = buildCollectRequestParams(` line immediately follows the comment. No code is altered.

---

## PROMPT #11 — Make D1 Compaction Atomic (INSERT + DELETE)

### Context
The monthly compaction in `d1-aggregation.ts` performs an INSERT of aggregated monthly data followed by a separate DELETE of the daily rows. These are two separate database operations. If the Cloudflare Worker crashes or hits a CPU limit between the INSERT and DELETE, both the monthly aggregate and the daily rows exist simultaneously. On the next query, BOTH are returned, causing double-counted data permanently. The fix wraps them in `db.batch()` which D1 executes atomically.

### File to Modify
`packages/server/app/analytics/d1-aggregation.ts`

### Step-by-Step Instructions

Find the following block inside the `compactOldData` function (around lines 483–503). You will see two separate `await db.prepare(...)` chains:

```typescript
        // Insert monthly aggregates
        await db
            .prepare(
                `INSERT INTO daily_aggregates (date, granularity, site_id, dimension_type, dimension_value, views, visitors, bounces)
                 SELECT ?, 'month', site_id, dimension_type, dimension_value,
                        SUM(views), SUM(visitors), SUM(bounces)
                 FROM daily_aggregates
                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'
                 GROUP BY site_id, dimension_type, dimension_value`,
            )
            .bind(month, month)
            .run();

        // Delete compacted daily rows
        await db
            .prepare(
                `DELETE FROM daily_aggregates
                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'`,
            )
            .bind(month)
            .run();
```

Replace that entire block with:

```typescript
        // Atomic INSERT + DELETE via db.batch() — prevents double-counting if worker
        // crashes between operations. D1 batch executes all statements atomically.
        await db.batch([
            db.prepare(
                `INSERT INTO daily_aggregates (date, granularity, site_id, dimension_type, dimension_value, views, visitors, bounces)
                 SELECT ?, 'month', site_id, dimension_type, dimension_value,
                        SUM(views), SUM(visitors), SUM(bounces)
                 FROM daily_aggregates
                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'
                 GROUP BY site_id, dimension_type, dimension_value`,
            ).bind(month, month),
            db.prepare(
                `DELETE FROM daily_aggregates
                 WHERE substr(date, 1, 7) = ? AND granularity = 'day'`,
            ).bind(month),
        ]);
```

### What You Must NOT Touch
- Do not change the SQL strings — they must remain character-for-character identical.
- Do not change the `existingMonthly` guard block above this (the `if (existingMonthly && existingMonthly.cnt > 0)` block).
- Do not change the `compactedMonths++` line below.
- Do not change any other part of the file.

### Verification
1. There must be NO standalone `await db.prepare(...).bind(month, month).run()` for the INSERT.
2. There must be NO standalone `await db.prepare(...).bind(month).run()` for the DELETE.
3. Both statements must be inside a single `await db.batch([...])` call.
4. The SQL strings inside `db.batch` must be identical to the originals.
5. Bindings: first statement binds `(month, month)`, second binds `(month)`.

---

## PROMPT #2 — Fix WAE Late-Ingestion Data Loss (Re-aggregate Recent Days)

### Context
WAE (Cloudflare Analytics Engine) is an eventually-consistent system. Events from 23:50 UTC on Day N may still be ingested into WAE at 02:00 UTC on Day N+1 when the cron aggregates Day N into D1. Once Day N is marked as `lastAggregatedDate`, it is never re-queried, so late-arriving events are permanently lost from D1 historical data. The fix adds a re-aggregation of the 2 most recent days on EVERY cron run using idempotent UPSERT semantics.

### File to Modify
`packages/server/app/analytics/d1-aggregation.ts`

### Step-by-Step Instructions

Find the `} else {` branch inside `runDailyAggregation` that handles the normal (non-first-run) case. It looks like this (around lines 604–621):

```typescript
    } else {
        // Normal run — aggregate any missing days between last and yesterday
        let nextDate = dayjs(lastAggregated).add(1, "day");

        while (
            nextDate.isBefore(yesterday) ||
            nextDate.isSame(yesterday, "day")
        ) {
            totalAggregated += await aggregateDay(db, api, nextDate);
            // Update after EACH successful day so that if a later day fails,
            // we don't re-aggregate already-completed days on the next cron run
            await setLastAggregatedDate(
                db,
                nextDate.format("YYYY-MM-DD"),
            );
            nextDate = nextDate.add(1, "day");
        }
    }
```

Add the following block IMMEDIATELY AFTER the closing `}` of that `else` block and BEFORE the `// 3. Run compaction` comment:

```typescript

    // Re-aggregate the 2 most recent days on every run to capture late-arriving WAE data.
    // WAE has eventual consistency — events from Day N may arrive hours after 02:00 UTC.
    // aggregateDay() uses ON CONFLICT DO UPDATE (UPSERT), so this is safe to run repeatedly.
    const dayBeforeYesterday = yesterday.subtract(1, "day");
    for (const recentDay of [dayBeforeYesterday, yesterday]) {
        try {
            await aggregateDay(db, api, recentDay);
        } catch (recentErr) {
            // Non-fatal: log and continue. lastAggregatedDate is not updated here
            // because re-aggregation does not extend the catch-up window.
            console.error(
                `Re-aggregation failed for ${recentDay.format("YYYY-MM-DD")}:`,
                recentErr,
            );
        }
    }

```

### What You Must NOT Touch
- Do not change the `lastAggregated` catch-up `while` loop.
- Do not call `setLastAggregatedDate` inside the new re-aggregation loop.
- Do not change the first-run `if (!lastAggregated)` block.
- The `// 3. Run compaction` line and `await compactOldData(...)` must remain directly after the new block.

### Verification
After the change, the code flow in `runDailyAggregation` must be:
1. `if (!lastAggregated)` first-run block
2. `else` normal catch-up loop
3. **NEW:** Re-aggregation loop for `[dayBeforeYesterday, yesterday]`
4. `// 3. Run compaction` → `await compactOldData(...)`

The re-aggregation loop uses `for...of` over a 2-element array, calls `aggregateDay` for each, and wraps each in individual `try/catch`. It must NOT call `setLastAggregatedDate`.

---

## PROMPT #6 — Fix Tracker Cache Fallback Inflating Unique Visitors

### Context
When the `/cache` endpoint XHR times out (1s timeout) or fails (network error, ad blocker, CORS), `checkCacheStatus` returns `fallbackResponse = { ht: 1 }`. This makes the tracker treat every failure as a new unique visitor. On mobile networks with high latency, this systematically over-reports unique visitor counts. The fix changes the fallback to `ht: 0`, which the collect endpoint treats as an unknown hit type and applies server-side CF-Cache-Status header logic to determine visitor status — a more accurate fallback.

### Files to Modify
1. `packages/tracker/src/lib/request.ts`
2. `packages/tracker/src/lib/track.ts`

### Step-by-Step Instructions

#### File 1: `packages/tracker/src/lib/request.ts`

Find this block (around lines 17–20):
```typescript
        // Default fallback response for any error case
        const fallbackResponse: CacheResponse = {
            ht: 1, // Assume first hit (new visit)
        };
```

Replace it with:
```typescript
        // Default fallback response for any error case (timeout, network error, ad blocker).
        // Use ht: 0 (unknown) so the collect endpoint applies its own CF-Cache-Status
        // header logic to determine visitor status — more accurate than always assuming new.
        const fallbackResponse: CacheResponse = {
            ht: 0, // Unknown — let server-side cache headers determine visitor status
        };
```

#### File 2: `packages/tracker/src/lib/track.ts`

Find this block (around lines 97–107):
```typescript
    let hitType: string | undefined;
    try {
        const cacheStatus = await checkCacheStatus(
            client.reporterUrl,
            client.siteId,
        );
        hitType = cacheStatus.ht.toString();
    } catch {
        // If cache check fails, we proceed without hit count data
        // The collect endpoint will handle the missing parameters
    }
```

Replace it with:
```typescript
    let hitType: string | undefined;
    try {
        const cacheStatus = await checkCacheStatus(
            client.reporterUrl,
            client.siteId,
        );
        // Only pass hitType if ht is a truthy value (1 or 2).
        // ht: 0 means the fallback fired (timeout/error) — treat as unknown,
        // letting the collect endpoint use CF-Cache-Status headers instead.
        hitType = cacheStatus.ht ? cacheStatus.ht.toString() : undefined;
    } catch {
        // If cache check throws, proceed without hit count data.
        // The collect endpoint will use its own CF-Cache-Status header as fallback.
    }
```

### What You Must NOT Touch
- Do not change the `REQUEST_TIMEOUT` constant in `request.ts`.
- Do not change `xhr.onerror` or `xhr.ontimeout` assignments.
- Do not change `makeRequest` in either file.
- Do not change the collect endpoint — only these two files.

### Verification
**request.ts**: The fallback must have `ht: 0` (number zero, not string "0", not `null`, not `undefined`).
**track.ts**: The assignment must be `hitType = cacheStatus.ht ? cacheStatus.ht.toString() : undefined;` using the ternary. The old `hitType = cacheStatus.ht.toString()` must be gone.

---

## PROMPT #7 — Fix D1 Monthly Row Over-Counting at Date Boundary

### Context
D1 queries use this SQL pattern to include monthly compacted rows: `(date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7)))`. The OR branch includes a monthly row (e.g., `'2024-06'`) even when `startDate` is `'2024-06-15'` — because `'2024-06' < '2024-06-15'` fails `date >= ?`, but the OR branch matches anyway. This means June 1–30 data is included when only June 15–30 should be counted. The fix adds `AND substr(?, 9, 2) = '01'` to the monthly OR branch, ensuring a monthly row is only included when startDate is the 1st of a month (meaning the full month is in range).

### File to Modify
`packages/server/app/analytics/d1-query.ts`

### Step-by-Step Instructions

This fix must be applied to **5 query functions** in the file. In each case:
- The SQL template literal changes (one WHERE clause condition is extended)
- The `.bind(...)` call gets one extra `startDate` argument

---

#### Change 1 — `getD1Counts` with `dimensionValue` (around line 46–54)

**FIND this SQL block:**
```typescript
        query = `
            SELECT COALESCE(SUM(views), 0) as views,
                   COALESCE(SUM(visitors), 0) as visitors,
                   COALESCE(SUM(bounces), 0) as bounces
            FROM daily_aggregates
            WHERE site_id = ? AND dimension_type = ? AND dimension_value = ?
              AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
        `;
        bindings = [siteId, dimensionType, dimensionValue, startDate, startDate, endDate];
```

**REPLACE WITH:**
```typescript
        query = `
            SELECT COALESCE(SUM(views), 0) as views,
                   COALESCE(SUM(visitors), 0) as visitors,
                   COALESCE(SUM(bounces), 0) as bounces
            FROM daily_aggregates
            WHERE site_id = ? AND dimension_type = ? AND dimension_value = ?
              AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
        `;
        bindings = [siteId, dimensionType, dimensionValue, startDate, startDate, startDate, endDate];
```

---

#### Change 2 — `getD1Counts` without `dimensionValue` (around line 56–64)

**FIND this SQL block:**
```typescript
        query = `
            SELECT COALESCE(SUM(views), 0) as views,
                   COALESCE(SUM(visitors), 0) as visitors,
                   COALESCE(SUM(bounces), 0) as bounces
            FROM daily_aggregates
            WHERE site_id = ? AND dimension_type = ?
              AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
        `;
        bindings = [siteId, dimensionType, startDate, startDate, endDate];
```

**REPLACE WITH:**
```typescript
        query = `
            SELECT COALESCE(SUM(views), 0) as views,
                   COALESCE(SUM(visitors), 0) as visitors,
                   COALESCE(SUM(bounces), 0) as bounces
            FROM daily_aggregates
            WHERE site_id = ? AND dimension_type = ?
              AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
        `;
        bindings = [siteId, dimensionType, startDate, startDate, startDate, endDate];
```

---

#### Change 3 — `getD1ViewsGroupedByInterval` with dimension filter (around line 113–123)

**FIND this SQL block:**
```typescript
        query = `SELECT date, granularity,
                        COALESCE(SUM(views), 0) as views,
                        COALESCE(SUM(visitors), 0) as visitors,
                        COALESCE(SUM(bounces), 0) as bounces
                 FROM daily_aggregates
                 WHERE site_id = ? AND dimension_type = ? AND dimension_value = ?
                   AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
                 GROUP BY date, granularity
                 ORDER BY date ASC`;
        bindings = [siteId, dimensionType, dimensionValue, startDate, startDate, endDate];
```

**REPLACE WITH:**
```typescript
        query = `SELECT date, granularity,
                        COALESCE(SUM(views), 0) as views,
                        COALESCE(SUM(visitors), 0) as visitors,
                        COALESCE(SUM(bounces), 0) as bounces
                 FROM daily_aggregates
                 WHERE site_id = ? AND dimension_type = ? AND dimension_value = ?
                   AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
                 GROUP BY date, granularity
                 ORDER BY date ASC`;
        bindings = [siteId, dimensionType, dimensionValue, startDate, startDate, startDate, endDate];
```

---

#### Change 4 — `getD1ViewsGroupedByInterval` for `overall` dimension (around line 124–134)

**FIND this SQL block:**
```typescript
        query = `SELECT date, granularity,
                        COALESCE(SUM(views), 0) as views,
                        COALESCE(SUM(visitors), 0) as visitors,
                        COALESCE(SUM(bounces), 0) as bounces
                 FROM daily_aggregates
                 WHERE site_id = ? AND dimension_type = 'overall'
                   AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
                 GROUP BY date, granularity
                 ORDER BY date ASC`;
        bindings = [siteId, startDate, startDate, endDate];
```

**REPLACE WITH:**
```typescript
        query = `SELECT date, granularity,
                        COALESCE(SUM(views), 0) as views,
                        COALESCE(SUM(visitors), 0) as visitors,
                        COALESCE(SUM(bounces), 0) as bounces
                 FROM daily_aggregates
                 WHERE site_id = ? AND dimension_type = 'overall'
                   AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
                 GROUP BY date, granularity
                 ORDER BY date ASC`;
        bindings = [siteId, startDate, startDate, startDate, endDate];
```

---

#### Change 5 — `getD1VisitorCountByColumn` (around line 182–193)

**FIND this `.prepare(...)` call:**
```typescript
    const result = await db
        .prepare(
            `SELECT dimension_value, COALESCE(SUM(visitors), 0) as visitors
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = ?
               AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
             GROUP BY dimension_value
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
        )
        .bind(siteId, dimensionType, startDate, startDate, endDate, limit, offset)
```

**REPLACE WITH:**
```typescript
    const result = await db
        .prepare(
            `SELECT dimension_value, COALESCE(SUM(visitors), 0) as visitors
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = ?
               AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
             GROUP BY dimension_value
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
        )
        .bind(siteId, dimensionType, startDate, startDate, startDate, endDate, limit, offset)
```

---

#### Change 6 — `getD1AllCountsByColumn` (around line 217–230)

**FIND this `.prepare(...)` call:**
```typescript
    const result = await db
        .prepare(
            `SELECT dimension_value,
                    COALESCE(SUM(views), 0) as views,
                    COALESCE(SUM(visitors), 0) as visitors,
                    COALESCE(SUM(bounces), 0) as bounces
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = ?
               AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
             GROUP BY dimension_value
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
        )
        .bind(siteId, dimensionType, startDate, startDate, endDate, limit, offset)
```

**REPLACE WITH:**
```typescript
    const result = await db
        .prepare(
            `SELECT dimension_value,
                    COALESCE(SUM(views), 0) as views,
                    COALESCE(SUM(visitors), 0) as visitors,
                    COALESCE(SUM(bounces), 0) as bounces
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = ?
               AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
             GROUP BY dimension_value
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
        )
        .bind(siteId, dimensionType, startDate, startDate, startDate, endDate, limit, offset)
```
This file will be continued by @fix_bug_prompts_part2.md as part of the complete context.