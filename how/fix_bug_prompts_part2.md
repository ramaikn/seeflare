This file is only a continuation of @fix_bug_prompts.md so the AI agent can read it more easily. All of this context is a continuation of that file, so do not read it separately.
---

#### Change 7 — `getD1SitesOrderedByHits` (around line 312–322)

**FIND this `.prepare(...)` call:**
```typescript
    const result = await db
        .prepare(
            `SELECT site_id, COALESCE(SUM(views), 0) as total_views
             FROM daily_aggregates
             WHERE dimension_type = 'overall'
               AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
             GROUP BY site_id
             ORDER BY total_views DESC
             LIMIT ?`,
        )
        .bind(startDate, startDate, endDate, limit)
```

**REPLACE WITH:**
```typescript
    const result = await db
        .prepare(
            `SELECT site_id, COALESCE(SUM(views), 0) as total_views
             FROM daily_aggregates
             WHERE dimension_type = 'overall'
               AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01')) AND date <= ?
             GROUP BY site_id
             ORDER BY total_views DESC
             LIMIT ?`,
        )
        .bind(startDate, startDate, startDate, endDate, limit)
```

---

### What You Must NOT Touch
- Do not change any SELECT columns, GROUP BY, ORDER BY, or LIMIT clauses.
- Do not change any function signatures or return types.
- Do not change type annotations.
- Only the WHERE clause (the monthly OR branch) and the `.bind()` arguments change.

### Verification
After the change, every WHERE clause in this file that contains `granularity = 'month'` must also contain `AND substr(?, 9, 2) = '01'` as a condition within the same parenthesized OR group.

Every `.bind()` call that previously had the pattern `(..., startDate, startDate, endDate, ...)` must now have `(..., startDate, startDate, startDate, endDate, ...)` — with one extra `startDate` inserted before `endDate`.

Count: there must be exactly **7 places** where the change was applied in this file.

---

## PROMPT #1 — Fix Arrow R2 Backup Cross-Product Explosion

### Context
The Arrow R2 backup calls `getAllCountsByAllColumnsForAllSites()` which groups ALL 15 dimension columns simultaneously in one SQL query (`GROUP BY date, siteId, isVisitor, isBounce, blob1, ...blob15`). This creates a Cartesian cross-product of all dimension values, producing hundreds of thousands of rows per day for any site with moderate traffic. Cloudflare WAE silently truncates results at its row limit, making backups permanently incomplete. The fix rewrites the backup to query each dimension column separately (same approach D1 aggregation already uses correctly), and also corrects the column filter to exclude high-cardinality fields `host`, `userAgent`, and `newSession`.

### File to Modify
`packages/server/workers/lib/arrow.ts`

### Current File Content (lines 1–64, the non-test portion)
```typescript
import { AnalyticsEngineAPI } from "../../app/analytics/query";
import { ColumnMappings } from "../../app/analytics/schema";
import { tableFromJSON, tableToIPC } from "apache-arrow";
import dayjs from "dayjs";

export async function extractAsArrow(
    { accountId, bearerToken }: { accountId: string; bearerToken: string },
    bucket: R2Bucket,
) {
    const api = new AnalyticsEngineAPI(accountId, bearerToken);

    // Get yesterday's date range
    const yesterday = dayjs().subtract(1, "day");
    const startDateTime = yesterday.startOf("day").toDate();
    const endDateTime = yesterday.endOf("day").toDate();

    // Get all columns we want to extract
    const columns = Object.keys(ColumnMappings).filter(
        (key) => key !== "siteId" && key !== "newVisitor" && key !== "bounce",
    ) as (keyof typeof ColumnMappings)[];

    // Fetch data for yesterday
    const data = await api.getAllCountsByAllColumnsForAllSites(
        columns,
        startDateTime,
        endDateTime,
    );

    // Convert Map to array of records for Arrow table creation
    const records: any[] = [];
    data.forEach((counts, key) => {
        const [date, siteId, ...columnValues] = key;
        const record: any = {
            date,
            siteId,
            views: counts.views,
            visitors: counts.visitors,
            bounces: counts.bounces,
        };

        // Add column values
        columns.forEach((column, index) => {
            record[column] = columnValues[index];
        });

        records.push(record);
    });

    // Create Arrow table from JSON records
    const table = tableFromJSON(records);

    // Convert to Arrow IPC buffer
    const arrowBuffer = new Uint8Array(tableToIPC(table, "file"));

    // Generate filename with yesterday's date
    const filename = `analytics-${yesterday.format("YYYY-MM-DD")}.arrow`;

    // Save to R2
    await bucket.put(filename, arrowBuffer);

    console.log(`Saved ${records.length} records to ${filename}`);

    return { filename, recordCount: records.length };
}
```

### Step-by-Step Instructions

Replace ONLY the `extractAsArrow` function body (everything between the first `{` after the parameters and the matching `}` at the end of the function, but keep the function signature and the IIFE test code below intact).

Replace the entire function body content with the following:

```typescript
export async function extractAsArrow(
    { accountId, bearerToken }: { accountId: string; bearerToken: string },
    bucket: R2Bucket,
) {
    const api = new AnalyticsEngineAPI(accountId, bearerToken);

    // Get yesterday's date range
    const yesterday = dayjs().subtract(1, "day");
    const startDateTime = yesterday.startOf("day").toDate();
    const endDateTime = yesterday.endOf("day").toDate();

    // Dimension columns to extract. Excludes high-cardinality fields that would
    // cause cross-product explosion in a single GROUP BY query.
    // Mirrors the filter used in d1-aggregation.ts aggregateDay().
    const columns = Object.keys(ColumnMappings).filter(
        (key) =>
            key !== "siteId" &&
            key !== "newVisitor" &&
            key !== "bounce" &&
            key !== "newSession" &&
            key !== "host" &&
            key !== "userAgent",
    ) as (keyof typeof ColumnMappings)[];

    // Use range interval to discover active sites for yesterday
    const rangeInterval = `range:${startDateTime.toISOString()}|${endDateTime.toISOString()}`;
    const sites = await api.getSitesOrderedByHits(rangeInterval, 100);
    const siteIds = sites.map((s) => s[0]);

    // Query each dimension column per site SEPARATELY to avoid the WAE row-limit
    // cross-product truncation that occurs when grouping all columns simultaneously.
    const records: any[] = [];
    const dateStr = yesterday.format("YYYY-MM-DD");

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
                    date: dateStr,
                    siteId,
                    dimensionType: col,
                    dimensionValue: val,
                    views: counts.views,
                    visitors: counts.visitors,
                    bounces: counts.bounces,
                });
            }
        }
    }

    // Create Arrow table from JSON records
    const table = tableFromJSON(records);

    // Convert to Arrow IPC buffer
    const arrowBuffer = new Uint8Array(tableToIPC(table, "file"));

    // Generate filename with yesterday's date
    const filename = `analytics-${yesterday.format("YYYY-MM-DD")}.arrow`;

    // Save to R2
    await bucket.put(filename, arrowBuffer);

    console.log(`Saved ${records.length} records to ${filename}`);

    return { filename, recordCount: records.length };
}
```

### What You Must NOT Touch
- Do not change the imports at the top of the file.
- Do not change the IIFE test block at the bottom (lines 66–154 in the original).
- Do not remove the `getAllCountsByAllColumnsForAllSites` method from `query.ts` — it is only unused by `arrow.ts` after this fix.

### Verification
1. The `columns` filter must exclude `"newSession"`, `"host"`, and `"userAgent"` in addition to the original exclusions.
2. There must be NO call to `getAllCountsByAllColumnsForAllSites` anywhere in this function.
3. There must be a call to `api.getSitesOrderedByHits(rangeInterval, 100)` to get site IDs.
4. There must be a nested `for (const siteId of siteIds)` and `for (const col of columns)` loop.
5. Each record pushed must have `dimensionType` and `dimensionValue` fields (not an arbitrary column key).

---

## PROMPT #10 + #13 — Fix R2/D1 Race Condition and Add R2 Cleanup (Combined)

### Context
**BUG #13 (Race):** The cron handler dispatches two independent `ctx.waitUntil()` calls — one for the R2 Arrow backup and one for D1 aggregation. They run concurrently. On the first-ever cron run, the D1 aggregation's backfill logic tries to read R2 files that haven't been written yet by the concurrent Arrow backup. The fix serializes them: R2 backup runs first, then D1 aggregation.

**BUG #10 (Cleanup):** R2 Arrow files accumulate indefinitely with no deletion policy. After D1 aggregation captures all historical data, files older than WAE's 90-day retention window serve no purpose. The fix adds R2 cleanup (delete files >95 days old) after each successful aggregation.

Both bugs are fixed together because they modify the same file and the same `scheduled` handler.

### File to Modify
`packages/server/workers/app.ts`

### Current File Content (the `scheduled` handler, lines 22–71)
```typescript
    async scheduled(
        _controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext,
    ) {
        if (env.CF_STORAGE_ENABLED === "false") return
        try {
            // 1. Run existing Arrow R2 backup
            ctx.waitUntil(
                extractAsArrow(
                    {
                        accountId: env.CF_ACCOUNT_ID,
                        bearerToken: env.CF_BEARER_TOKEN,
                    },
                    env.DAILY_ROLLUPS,
                ),
            );

            // 2. Run D1 Aggregation, Compaction, and Cache Purge if D1 is configured
            if ((env as any).ANALYTICS_DB) {
                ctx.waitUntil(
                    (async () => {
                        try {
                            const api = new AnalyticsEngineAPI(
                                env.CF_ACCOUNT_ID,
                                env.CF_BEARER_TOKEN,
                            );

                            // Run aggregation + compaction
                            const compactionDaysStr = (env as any).CF_D1_COMPACTION_DAYS;
                            const compactionDays = compactionDaysStr
                                ? parseInt(compactionDaysStr as string, 10) 
                                : undefined;

                            await runDailyAggregation(
                                (env as any).ANALYTICS_DB,
                                api,
                                env.DAILY_ROLLUPS,
                                compactionDays
                            );

                        } catch (aggError) {
                            console.error("Aggregation error:", aggError);
                        }
                    })()
                );
            }
        } catch (error) {
            console.error(error);
        }
    },
```

### Step-by-Step Instructions

Replace the ENTIRE `scheduled` handler (from `async scheduled(` through the closing `},`) with the following:

```typescript
    async scheduled(
        _controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext,
    ) {
        if (env.CF_STORAGE_ENABLED === "false") return;

        // BUG #13 FIX: Run R2 backup and D1 aggregation sequentially (not concurrently).
        // On first run, D1 backfill reads R2 files — they must exist before aggregation starts.
        ctx.waitUntil(
            (async () => {
                // Step 1: Arrow R2 backup
                try {
                    await extractAsArrow(
                        {
                            accountId: env.CF_ACCOUNT_ID,
                            bearerToken: env.CF_BEARER_TOKEN,
                        },
                        env.DAILY_ROLLUPS,
                    );
                } catch (arrowErr) {
                    // Non-fatal: log and continue to D1 aggregation
                    console.error("Arrow backup error:", arrowErr);
                }

                // Step 2: D1 aggregation + compaction (only if ANALYTICS_DB is configured)
                if ((env as any).ANALYTICS_DB) {
                    try {
                        const api = new AnalyticsEngineAPI(
                            env.CF_ACCOUNT_ID,
                            env.CF_BEARER_TOKEN,
                        );

                        // Run aggregation + compaction
                        const compactionDaysStr = (env as any).CF_D1_COMPACTION_DAYS;
                        const compactionDays = compactionDaysStr
                            ? parseInt(compactionDaysStr as string, 10)
                            : undefined;

                        await runDailyAggregation(
                            (env as any).ANALYTICS_DB,
                            api,
                            env.DAILY_ROLLUPS,
                            compactionDays,
                        );

                        // BUG #10 FIX: Delete R2 Arrow files older than 95 days.
                        // 95 days = 5-day safety buffer beyond WAE's 90-day retention.
                        // After D1 aggregation, older R2 files are permanently redundant.
                        try {
                            const cutoffDate = new Date();
                            cutoffDate.setDate(cutoffDate.getDate() - 95);
                            const objects = await env.DAILY_ROLLUPS.list({ limit: 1000 });
                            for (const obj of objects.objects) {
                                const match = obj.key.match(
                                    /analytics-(\d{4}-\d{2}-\d{2})\.arrow/,
                                );
                                if (match) {
                                    const fileDate = new Date(match[1]);
                                    if (fileDate < cutoffDate) {
                                        await env.DAILY_ROLLUPS.delete(obj.key);
                                        console.log(`Deleted old R2 backup: ${obj.key}`);
                                    }
                                }
                            }
                        } catch (cleanupErr) {
                            // Non-fatal: log and continue
                            console.error("R2 cleanup error:", cleanupErr);
                        }

                    } catch (aggError) {
                        console.error("Aggregation error:", aggError);
                    }
                }
            })(),
        );
    },
```

### What You Must NOT Touch
- Do not change the `fetch` handler below the `scheduled` handler.
- Do not change imports at the top of the file.
- Do not change the `requestHandler` declaration.

### Verification
1. There must be exactly ONE `ctx.waitUntil(...)` call in the `scheduled` handler (not two).
2. The single `ctx.waitUntil` must wrap an immediately-invoked async IIFE `(async () => { ... })()`.
3. Inside the IIFE: `extractAsArrow` is awaited first (in its own try-catch), then the `if (ANALYTICS_DB)` block runs.
4. Inside the `if (ANALYTICS_DB)` block: after `runDailyAggregation` succeeds, the R2 cleanup loop runs (in its own try-catch).
5. The R2 cleanup deletes files matching `/analytics-(\d{4}-\d{2}-\d{2})\.arrow/` that are older than 95 days.
6. The outer `try { ... } catch (error)` wrapper from the original code is replaced by the individual try-catch blocks inside the IIFE.
