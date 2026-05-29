import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import type { DimensionType } from "./d1-aggregation";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * D1-specific query functions that return data in the same format
 * as the WAE AnalyticsEngineAPI methods, enabling seamless merging.
 */

// ------------------------------------------------------------------
// Types (matching WAE query output shapes)
// ------------------------------------------------------------------

export interface D1AnalyticsCountResult {
    views: number;
    visitors: number;
    bounces: number;
}

export type D1ViewsGroupedByInterval = [string, D1AnalyticsCountResult][];

// ------------------------------------------------------------------
// Core D1 Query Functions
// ------------------------------------------------------------------

/**
 * Get aggregate counts (views, visitors, bounces) from D1 for a date range.
 * Equivalent to AnalyticsEngineAPI.getCounts() but reads from D1.
 */
export async function getD1Counts(
    db: D1Database,
    siteId: string,
    startDate: string,
    endDate: string,
    dimensionType: DimensionType = "overall",
    dimensionValue?: string,
): Promise<D1AnalyticsCountResult> {
    let query: string;
    let bindings: string[];

    if (dimensionValue !== undefined) {
        query = `
            SELECT COALESCE(SUM(views), 0) as views,
                   COALESCE(SUM(visitors), 0) as visitors,
                   COALESCE(SUM(bounces), 0) as bounces
            FROM daily_aggregates
            WHERE site_id = ? AND dimension_type = ? AND dimension_value = ?
              AND date >= ? AND date <= ?
        `;
        bindings = [siteId, dimensionType, dimensionValue, startDate, endDate];
    } else {
        query = `
            SELECT COALESCE(SUM(views), 0) as views,
                   COALESCE(SUM(visitors), 0) as visitors,
                   COALESCE(SUM(bounces), 0) as bounces
            FROM daily_aggregates
            WHERE site_id = ? AND dimension_type = ?
              AND date >= ? AND date <= ?
        `;
        bindings = [siteId, dimensionType, startDate, endDate];
    }

    const result = await db
        .prepare(query)
        .bind(...bindings)
        .first<{ views: number; visitors: number; bounces: number }>();

    return {
        views: result?.views ?? 0,
        visitors: result?.visitors ?? 0,
        bounces: result?.bounces ?? 0,
    };
}

/**
 * Get views grouped by date interval from D1.
 * Returns data in the same tuple format as WAE getViewsGroupedByInterval.
 *
 * For daily granularity rows, returns per-day data.
 * For monthly granularity rows, returns per-month data.
 */
export async function getD1ViewsGroupedByInterval(
    db: D1Database,
    siteId: string,
    startDate: string,
    endDate: string,
): Promise<D1ViewsGroupedByInterval> {
    const result = await db
        .prepare(
            `SELECT date, granularity,
                    COALESCE(SUM(views), 0) as views,
                    COALESCE(SUM(visitors), 0) as visitors,
                    COALESCE(SUM(bounces), 0) as bounces
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = 'overall'
               AND date >= ? AND date <= ?
             GROUP BY date, granularity
             ORDER BY date ASC`,
        )
        .bind(siteId, startDate, endDate)
        .all<{
            date: string;
            granularity: string;
            views: number;
            visitors: number;
            bounces: number;
        }>();

    return (result.results || []).map((row) => {
        // For daily: date is 'YYYY-MM-DD', convert to 'YYYY-MM-DD 00:00:00' for WAE compat
        // For monthly: date is 'YYYY-MM', convert to 'YYYY-MM-01 00:00:00'
        const dateStr =
            row.granularity === "month"
                ? `${row.date}-01 00:00:00`
                : `${row.date} 00:00:00`;
        return [
            dateStr,
            {
                views: row.views,
                visitors: row.visitors,
                bounces: row.bounces,
            },
        ];
    });
}

/**
 * Get visitor count grouped by a dimension column from D1.
 * Equivalent to AnalyticsEngineAPI.getVisitorCountByColumn().
 * Returns [dimensionValue, visitorCount][] sorted by visitors DESC.
 */
export async function getD1VisitorCountByColumn(
    db: D1Database,
    siteId: string,
    dimensionType: DimensionType,
    startDate: string,
    endDate: string,
    page: number = 1,
    limit: number = 10,
): Promise<[string, number][]> {
    const offset = (page - 1) * limit;

    const result = await db
        .prepare(
            `SELECT dimension_value, COALESCE(SUM(visitors), 0) as visitors
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = ?
               AND date >= ? AND date <= ?
               AND dimension_value != ''
             GROUP BY dimension_value
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
        )
        .bind(siteId, dimensionType, startDate, endDate, limit, offset)
        .all<{ dimension_value: string; visitors: number }>();

    return (result.results || []).map((row) => [
        row.dimension_value,
        row.visitors,
    ]);
}

/**
 * Get all counts (views, visitors, bounces) grouped by a dimension column from D1.
 * Equivalent to AnalyticsEngineAPI.getAllCountsByColumn().
 * Returns Record<dimensionValue, {views, visitors, bounces}>.
 */
export async function getD1AllCountsByColumn(
    db: D1Database,
    siteId: string,
    dimensionType: DimensionType,
    startDate: string,
    endDate: string,
    page: number = 1,
    limit: number = 10,
): Promise<Record<string, D1AnalyticsCountResult>> {
    const offset = (page - 1) * limit;

    const result = await db
        .prepare(
            `SELECT dimension_value,
                    COALESCE(SUM(views), 0) as views,
                    COALESCE(SUM(visitors), 0) as visitors,
                    COALESCE(SUM(bounces), 0) as bounces
             FROM daily_aggregates
             WHERE site_id = ? AND dimension_type = ?
               AND date >= ? AND date <= ?
               AND dimension_value != ''
             GROUP BY dimension_value
             ORDER BY visitors DESC
             LIMIT ? OFFSET ?`,
        )
        .bind(siteId, dimensionType, startDate, endDate, limit, offset)
        .all<{
            dimension_value: string;
            views: number;
            visitors: number;
            bounces: number;
        }>();

    const out: Record<string, D1AnalyticsCountResult> = {};
    for (const row of result.results || []) {
        out[row.dimension_value] = {
            views: row.views,
            visitors: row.visitors,
            bounces: row.bounces,
        };
    }
    return out;
}

/**
 * Get count by path from D1 — returns [path, visitors, views][]
 * matching AnalyticsEngineAPI.getCountByPath() signature.
 */
export async function getD1CountByPath(
    db: D1Database,
    siteId: string,
    startDate: string,
    endDate: string,
    page: number = 1,
    limit: number = 10,
): Promise<[string, number, number][]> {
    const allCounts = await getD1AllCountsByColumn(
        db,
        siteId,
        "path",
        startDate,
        endDate,
        page,
        limit,
    );

    return Object.entries(allCounts)
        .map(([key, val]) => [key, val.visitors, val.views] as [string, number, number])
        .sort((a, b) => b[1] - a[1]);
}

/**
 * Get count by referrer from D1 — returns [referrer, visitors, views][]
 * matching AnalyticsEngineAPI.getCountByReferrer() signature.
 */
export async function getD1CountByReferrer(
    db: D1Database,
    siteId: string,
    startDate: string,
    endDate: string,
    page: number = 1,
    limit: number = 10,
): Promise<[string, number, number][]> {
    const allCounts = await getD1AllCountsByColumn(
        db,
        siteId,
        "referrer",
        startDate,
        endDate,
        page,
        limit,
    );

    return Object.entries(allCounts)
        .map(([key, val]) => [key, val.visitors, val.views] as [string, number, number])
        .sort((a, b) => b[1] - a[1]);
}

/**
 * Get sites ordered by hits from D1. Used for site dropdown.
 */
export async function getD1SitesOrderedByHits(
    db: D1Database,
    startDate: string,
    endDate: string,
    limit: number = 10,
): Promise<[string, number][]> {
    const result = await db
        .prepare(
            `SELECT site_id, COALESCE(SUM(views), 0) as total_views
             FROM daily_aggregates
             WHERE dimension_type = 'overall'
               AND date >= ? AND date <= ?
             GROUP BY site_id
             ORDER BY total_views DESC
             LIMIT ?`,
        )
        .bind(startDate, endDate, limit)
        .all<{ site_id: string; total_views: number }>();

    return (result.results || []).map((row) => [
        row.site_id,
        row.total_views,
    ]);
}
