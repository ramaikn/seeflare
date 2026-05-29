import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { ColumnMappings } from "./schema";
import { AnalyticsEngineAPI } from "./query";
import { tableFromIPC } from "apache-arrow";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Default compaction threshold in days. Data older than this
 * will be compacted from daily to monthly granularity.
 * Can be overridden via CF_D1_COMPACTION_DAYS env variable.
 */
export const DEFAULT_COMPACTION_DAYS = 365;

/**
 * All dimension types that we aggregate. 'overall' stores the
 * site-wide totals; the rest match dashboard dimension columns.
 */
export const DIMENSION_TYPES = [
    "overall",
    "path",
    "referrer",
    "country",
    "browserName",
    "browserVersion",
    "deviceModel",
    "deviceType",
    "utmSource",
    "utmMedium",
    "utmCampaign",
    "utmTerm",
    "utmContent",
] as const;

export type DimensionType = (typeof DIMENSION_TYPES)[number];

// ------------------------------------------------------------------
// Schema Initialization
// ------------------------------------------------------------------

/**
 * Ensures D1 tables and indexes exist. Safe to call on every cron run
 * because it uses IF NOT EXISTS.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
    await db.batch([
        db.prepare(`
            CREATE TABLE IF NOT EXISTS daily_aggregates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                granularity TEXT NOT NULL DEFAULT 'day',
                site_id TEXT NOT NULL,
                dimension_type TEXT NOT NULL,
                dimension_value TEXT NOT NULL DEFAULT '',
                views INTEGER NOT NULL DEFAULT 0,
                visitors INTEGER NOT NULL DEFAULT 0,
                bounces INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(date, site_id, dimension_type, dimension_value, granularity)
            )
        `),
        db.prepare(`
            CREATE TABLE IF NOT EXISTS aggregation_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `),
        db.prepare(`
            CREATE INDEX IF NOT EXISTS idx_daily_agg_lookup
                ON daily_aggregates(site_id, dimension_type, date, granularity)
        `),
        db.prepare(`
            CREATE INDEX IF NOT EXISTS idx_daily_agg_date
                ON daily_aggregates(date, granularity)
        `),
        db.prepare(`
            CREATE INDEX IF NOT EXISTS idx_daily_agg_compact
                ON daily_aggregates(granularity, date)
        `),
    ]);
}

// ------------------------------------------------------------------
// Metadata Helpers
// ------------------------------------------------------------------

export async function getMetadata(
    db: D1Database,
    key: string,
): Promise<string | null> {
    const result = await db
        .prepare("SELECT value FROM aggregation_metadata WHERE key = ?")
        .bind(key)
        .first<{ value: string }>();
    return result?.value ?? null;
}

export async function setMetadata(
    db: D1Database,
    key: string,
    value: string,
): Promise<void> {
    await db
        .prepare(
            `INSERT INTO aggregation_metadata (key, value, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        )
        .bind(key, value)
        .run();
}

export async function getLastAggregatedDate(
    db: D1Database,
): Promise<string | null> {
    return getMetadata(db, "last_aggregated_date");
}

export async function setLastAggregatedDate(
    db: D1Database,
    date: string,
): Promise<void> {
    return setMetadata(db, "last_aggregated_date", date);
}

export async function getEarliestDataDate(
    db: D1Database,
): Promise<string | null> {
    const result = await db
        .prepare(
            "SELECT MIN(date) as earliest FROM daily_aggregates WHERE granularity = 'day'",
        )
        .first<{ earliest: string | null }>();

    if (result?.earliest) return result.earliest;

    // Check monthly data too
    const monthResult = await db
        .prepare(
            "SELECT MIN(date) as earliest FROM daily_aggregates WHERE granularity = 'month'",
        )
        .first<{ earliest: string | null }>();

    return monthResult?.earliest ?? null;
}

// ------------------------------------------------------------------
// Daily Aggregation (WAE → D1)
// ------------------------------------------------------------------

interface AggregationRow {
    date: string;
    site_id: string;
    dimension_type: DimensionType;
    dimension_value: string;
    views: number;
    visitors: number;
    bounces: number;
}

/**
 * Aggregates a single day's data from WAE into D1.
 * Extracts overall counts + per-dimension breakdowns for every site.
 */
export async function aggregateDay(
    db: D1Database,
    api: AnalyticsEngineAPI,
    date: dayjs.Dayjs,
    tz?: string,
): Promise<number> {
    const startDateTime = date.startOf("day").toDate();
    const endDateTime = date.endOf("day").toDate();

    // Dimension columns to extract (excludes siteId, newVisitor, bounce — those are meta)
    const columns = Object.keys(ColumnMappings).filter(
        (key) => key !== "siteId" && key !== "newVisitor" && key !== "bounce" && key !== "newSession",
    ) as (keyof typeof ColumnMappings)[];

    // Fetch all data for this day from WAE
    const data = await api.getAllCountsByAllColumnsForAllSites(
        columns,
        startDateTime,
        endDateTime,
        tz,
    );

    if (data.size === 0) {
        console.log(`No data found for ${date.format("YYYY-MM-DD")}`);
        return 0;
    }

    // Build aggregation rows
    const rows: AggregationRow[] = [];
    const dateStr = date.format("YYYY-MM-DD");

    // Accumulators for per-site overall totals and per-dimension breakdowns
    const overallBySite = new Map<
        string,
        { views: number; visitors: number; bounces: number }
    >();
    const dimensionAccum = new Map<
        string,
        { views: number; visitors: number; bounces: number }
    >();

    data.forEach((counts, key) => {
        const [, siteId, ...columnValues] = key;

        // Accumulate overall per-site totals
        if (!overallBySite.has(siteId)) {
            overallBySite.set(siteId, { views: 0, visitors: 0, bounces: 0 });
        }
        const overall = overallBySite.get(siteId)!;
        overall.views += counts.views;
        overall.visitors += counts.visitors;
        overall.bounces += counts.bounces;

        // Accumulate per-dimension breakdowns
        columns.forEach((column, index) => {
            const value = columnValues[index]?.trim() || "";
            if (!value) return; // skip empty dimension values

            const dimKey = `${siteId}:${column}:${value}`;
            if (!dimensionAccum.has(dimKey)) {
                dimensionAccum.set(dimKey, {
                    views: 0,
                    visitors: 0,
                    bounces: 0,
                });
            }
            const accum = dimensionAccum.get(dimKey)!;
            accum.views += counts.views;
            accum.visitors += counts.visitors;
            accum.bounces += counts.bounces;
        });
    });

    // Build overall rows
    overallBySite.forEach((counts, siteId) => {
        rows.push({
            date: dateStr,
            site_id: siteId,
            dimension_type: "overall",
            dimension_value: "",
            views: counts.views,
            visitors: counts.visitors,
            bounces: counts.bounces,
        });
    });

    // Build dimension rows
    dimensionAccum.forEach((counts, dimKey) => {
        const [siteId, dimensionType, dimensionValue] = dimKey.split(":");
        rows.push({
            date: dateStr,
            site_id: siteId,
            dimension_type: dimensionType as DimensionType,
            dimension_value: dimensionValue,
            views: counts.views,
            visitors: counts.visitors,
            bounces: counts.bounces,
        });
    });

    // Write to D1 in batches (D1 supports max 100 statements per batch)
    const BATCH_SIZE = 50; // conservative to stay within limits
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const statements = batch.map((row) =>
            db
                .prepare(
                    `INSERT INTO daily_aggregates (date, granularity, site_id, dimension_type, dimension_value, views, visitors, bounces)
                     VALUES (?, 'day', ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(date, site_id, dimension_type, dimension_value, granularity)
                     DO UPDATE SET views = excluded.views, visitors = excluded.visitors, bounces = excluded.bounces`,
                )
                .bind(
                    row.date,
                    row.site_id,
                    row.dimension_type,
                    row.dimension_value,
                    row.views,
                    row.visitors,
                    row.bounces,
                ),
        );
        await db.batch(statements);
    }

    console.log(
        `Aggregated ${rows.length} rows for ${dateStr}`,
    );
    return rows.length;
}

// ------------------------------------------------------------------
// Backfill from R2 Arrow Files
// ------------------------------------------------------------------

/**
 * Backfills D1 from R2 Arrow IPC files. Used for initial setup
 * or filling gaps. Processes one file at a time to stay within
 * Worker CPU limits.
 */
export async function backfillFromR2(
    db: D1Database,
    bucket: R2Bucket,
    startDate: dayjs.Dayjs,
    endDate: dayjs.Dayjs,
): Promise<{ processedDays: number; totalRows: number }> {
    let processedDays = 0;
    let totalRows = 0;
    let currentDate = startDate;

    while (
        currentDate.isBefore(endDate) ||
        currentDate.isSame(endDate, "day")
    ) {
        const filename = `analytics-${currentDate.format("YYYY-MM-DD")}.arrow`;
        const object = await bucket.get(filename);

        if (object) {
            try {
                const buffer = await object.arrayBuffer();
                const table = tableFromIPC(new Uint8Array(buffer));
                const rows: AggregationRow[] = [];
                const dateStr = currentDate.format("YYYY-MM-DD");

                // Accumulators for this day
                const overallBySite = new Map<
                    string,
                    { views: number; visitors: number; bounces: number }
                >();
                const dimensionAccum = new Map<
                    string,
                    { views: number; visitors: number; bounces: number }
                >();

                // Read each row from the Arrow table
                for (let i = 0; i < table.numRows; i++) {
                    const siteId =
                        (table.getChild("siteId")?.get(i) as string) ?? "";
                    const views =
                        (table.getChild("views")?.get(i) as number) ?? 0;
                    const visitors =
                        (table.getChild("visitors")?.get(i) as number) ?? 0;
                    const bounces =
                        (table.getChild("bounces")?.get(i) as number) ?? 0;

                    // Overall accumulation
                    if (!overallBySite.has(siteId)) {
                        overallBySite.set(siteId, {
                            views: 0,
                            visitors: 0,
                            bounces: 0,
                        });
                    }
                    const overall = overallBySite.get(siteId)!;
                    overall.views += views;
                    overall.visitors += visitors;
                    overall.bounces += bounces;

                    // Per-dimension accumulation
                    const dimensionColumns = Object.keys(
                        ColumnMappings,
                    ).filter(
                        (k) =>
                            k !== "siteId" &&
                            k !== "newVisitor" &&
                            k !== "bounce" &&
                            k !== "newSession" &&
                            k !== "host" &&
                            k !== "userAgent",
                    );

                    for (const col of dimensionColumns) {
                        const value =
                            (
                                table.getChild(col)?.get(i) as string
                            )?.trim() ?? "";
                        if (!value) continue;

                        const dimKey = `${siteId}:${col}:${value}`;
                        if (!dimensionAccum.has(dimKey)) {
                            dimensionAccum.set(dimKey, {
                                views: 0,
                                visitors: 0,
                                bounces: 0,
                            });
                        }
                        const accum = dimensionAccum.get(dimKey)!;
                        accum.views += views;
                        accum.visitors += visitors;
                        accum.bounces += bounces;
                    }
                }

                // Build rows
                overallBySite.forEach((counts, siteId) => {
                    rows.push({
                        date: dateStr,
                        site_id: siteId,
                        dimension_type: "overall",
                        dimension_value: "",
                        ...counts,
                    });
                });

                dimensionAccum.forEach((counts, dimKey) => {
                    const parts = dimKey.split(":");
                    rows.push({
                        date: dateStr,
                        site_id: parts[0],
                        dimension_type: parts[1] as DimensionType,
                        dimension_value: parts.slice(2).join(":"), // Handle values containing ':'
                        ...counts,
                    });
                });

                // Write to D1
                const BATCH_SIZE = 50;
                for (let j = 0; j < rows.length; j += BATCH_SIZE) {
                    const batch = rows.slice(j, j + BATCH_SIZE);
                    const statements = batch.map((row) =>
                        db
                            .prepare(
                                `INSERT INTO daily_aggregates (date, granularity, site_id, dimension_type, dimension_value, views, visitors, bounces)
                                 VALUES (?, 'day', ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(date, site_id, dimension_type, dimension_value, granularity)
                                 DO UPDATE SET views = excluded.views, visitors = excluded.visitors, bounces = excluded.bounces`,
                            )
                            .bind(
                                row.date,
                                row.site_id,
                                row.dimension_type,
                                row.dimension_value,
                                row.views,
                                row.visitors,
                                row.bounces,
                            ),
                    );
                    await db.batch(statements);
                }

                totalRows += rows.length;
                processedDays++;
                console.log(
                    `Backfilled ${rows.length} rows from ${filename}`,
                );
            } catch (err) {
                console.error(`Error processing ${filename}:`, err);
            }
        }

        currentDate = currentDate.add(1, "day");
    }

    return { processedDays, totalRows };
}

// ------------------------------------------------------------------
// Monthly Compaction
// ------------------------------------------------------------------

/**
 * Compacts daily rows older than `compactionDays` into monthly aggregates.
 * Only compacts complete months (all days of the month must be older than cutoff).
 */
export async function compactOldData(
    db: D1Database,
    compactionDays: number = DEFAULT_COMPACTION_DAYS,
): Promise<number> {
    const cutoffDate = dayjs().subtract(compactionDays, "day").format("YYYY-MM-DD");

    // Find months that have daily data entirely older than the cutoff
    const monthsResult = await db
        .prepare(
            `SELECT DISTINCT substr(date, 1, 7) as month
             FROM daily_aggregates
             WHERE granularity = 'day' AND date < ?
             ORDER BY month ASC`,
        )
        .bind(cutoffDate)
        .all<{ month: string }>();

    if (!monthsResult.results || monthsResult.results.length === 0) {
        return 0;
    }

    let compactedMonths = 0;

    for (const { month } of monthsResult.results) {
        // Verify entire month is before cutoff
        const monthEnd = dayjs(`${month}-01`)
            .endOf("month")
            .format("YYYY-MM-DD");
        if (monthEnd >= cutoffDate) continue; // Month not fully past cutoff

        // Check if monthly aggregate already exists for this month
        const existingMonthly = await db
            .prepare(
                `SELECT COUNT(*) as cnt FROM daily_aggregates
                 WHERE date = ? AND granularity = 'month'`,
            )
            .bind(month)
            .first<{ cnt: number }>();

        if (existingMonthly && existingMonthly.cnt > 0) {
            // Already compacted, just delete the daily rows
            await db
                .prepare(
                    `DELETE FROM daily_aggregates
                     WHERE substr(date, 1, 7) = ? AND granularity = 'day'`,
                )
                .bind(month)
                .run();
            continue;
        }

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

        compactedMonths++;
        console.log(`Compacted month ${month} into monthly aggregate`);
    }

    if (compactedMonths > 0) {
        await setMetadata(
            db,
            "last_compaction_date",
            dayjs().format("YYYY-MM-DD"),
        );
    }

    return compactedMonths;
}

// ------------------------------------------------------------------
// Run Full Daily Aggregation Pipeline
// ------------------------------------------------------------------

/**
 * Main entry point called from the cron handler.
 * 1. Ensures schema exists
 * 2. Determines which dates need aggregation
 * 3. Aggregates missing dates from WAE
 * 4. Runs compaction on old data
 *
 * On first run, it backfills from R2 if available.
 */
export async function runDailyAggregation(
    db: D1Database,
    api: AnalyticsEngineAPI,
    bucket: R2Bucket,
    compactionDays: number = DEFAULT_COMPACTION_DAYS,
): Promise<{
    aggregated: number;
    backfilled: number;
    compacted: number;
}> {
    // 1. Ensure schema
    await ensureSchema(db);

    const yesterday = dayjs().subtract(1, "day");
    const lastAggregated = await getLastAggregatedDate(db);

    let totalAggregated = 0;
    let totalBackfilled = 0;

    if (!lastAggregated) {
        // First run — try backfill from R2
        console.log("First run detected, attempting R2 backfill...");

        // List R2 files to find the earliest available backup
        const listResult = await bucket.list({ limit: 1 });
        if (listResult.objects.length > 0) {
            // Find date range from R2
            const allObjects = await bucket.list({ limit: 1000 });
            const dates = allObjects.objects
                .map((obj) => {
                    const match = obj.key.match(
                        /analytics-(\d{4}-\d{2}-\d{2})\.arrow/,
                    );
                    return match ? match[1] : null;
                })
                .filter(Boolean)
                .sort() as string[];

            if (dates.length > 0) {
                const earliestR2 = dayjs(dates[0]);
                const latestR2 = dayjs(dates[dates.length - 1]);

                console.log(
                    `Found R2 backups from ${earliestR2.format("YYYY-MM-DD")} to ${latestR2.format("YYYY-MM-DD")}`,
                );

                const result = await backfillFromR2(
                    db,
                    bucket,
                    earliestR2,
                    latestR2,
                );
                totalBackfilled = result.totalRows;

                // Set last aggregated date to the latest R2 backup date
                await setLastAggregatedDate(db, latestR2.format("YYYY-MM-DD"));
            }
        }

        // Now aggregate yesterday from WAE (if not already covered by R2)
        const currentLast = await getLastAggregatedDate(db);
        if (
            !currentLast ||
            dayjs(currentLast).isBefore(yesterday, "day")
        ) {
            totalAggregated += await aggregateDay(db, api, yesterday);
            await setLastAggregatedDate(
                db,
                yesterday.format("YYYY-MM-DD"),
            );
        }
    } else {
        // Normal run — aggregate any missing days between last and yesterday
        let nextDate = dayjs(lastAggregated).add(1, "day");

        while (
            nextDate.isBefore(yesterday) ||
            nextDate.isSame(yesterday, "day")
        ) {
            totalAggregated += await aggregateDay(db, api, nextDate);
            nextDate = nextDate.add(1, "day");
        }

        await setLastAggregatedDate(
            db,
            yesterday.format("YYYY-MM-DD"),
        );
    }

    // 3. Run compaction
    const compacted = await compactOldData(db, compactionDays);

    return {
        aggregated: totalAggregated,
        backfilled: totalBackfilled,
        compacted,
    };
}
