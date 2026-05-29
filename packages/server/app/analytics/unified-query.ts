import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { AnalyticsEngineAPI, type ViewsGroupedByInterval } from "./query";
import {
    getD1Counts,
    getD1ViewsGroupedByInterval,
    getD1VisitorCountByColumn,
    getD1AllCountsByColumn,
    getD1CountByPath,
    getD1CountByReferrer,
    getD1SitesOrderedByHits,
    type D1AnalyticsCountResult,
} from "./d1-query";
import { getEarliestDataDate } from "./d1-aggregation";
import type { DimensionType } from "./d1-aggregation";
import { SearchFilters } from "~/lib/types";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Maximum number of days WAE retains data.
 */
const WAE_RETENTION_DAYS = 90;

/**
 * Returns true if the given interval requires D1 data (>90 days).
 */
export function isExtendedInterval(interval: string): boolean {
    if (interval === "all") return true;
    const match = interval.match(/^(\d+)d$/);
    if (!match) return false;
    return parseInt(match[1], 10) > WAE_RETENTION_DAYS;
}

/**
 * For extended intervals, compute the D1 date range (the portion beyond WAE retention).
 * WAE covers the most recent 90 days; D1 covers everything before that.
 *
 * Returns { d1Start, d1End, waeInterval } where:
 *  - d1Start/d1End define the date range to query from D1
 *  - waeInterval is the interval string to pass to WAE (always ≤90d)
 */
export function computeDateRangeSplit(
    interval: string,
    tz: string,
    earliestDate?: string | null,
): {
    d1StartDate: string;
    d1EndDate: string;
    waeInterval: string;
    totalDays: number;
} {
    const now = dayjs().tz(tz);
    // WAE covers the recent 90 days. We query from the start of the 89th day ago,
    // ensuring WAE has the complete day available.
    const waeStart = now.subtract(WAE_RETENTION_DAYS - 1, "day").startOf("day");
    
    // We pass absolute date strings to WAE instead of rolling intervals
    const waeInterval = `range:${waeStart.toISOString()}|${now.toISOString()}`;

    let totalDays: number;
    let requestedStart: dayjs.Dayjs;

    if (interval === "all") {
        if (earliestDate) {
            requestedStart = dayjs(earliestDate).tz(tz);
        } else {
            requestedStart = waeStart;
        }
        totalDays = now.diff(requestedStart, "day");
    } else {
        const match = interval.match(/^(\d+)d$/);
        totalDays = match ? parseInt(match[1], 10) : WAE_RETENTION_DAYS;
        requestedStart = now.subtract(totalDays, "day");
    }

    // D1 covers from requested start up to the point where WAE takes over
    const d1StartDate = requestedStart.format("YYYY-MM-DD");
    // D1 covers exactly up to the day before WAE starts
    const d1EndDate = waeStart.subtract(1, "day").format("YYYY-MM-DD");

    return {
        d1StartDate,
        d1EndDate,
        waeInterval,
        totalDays,
    };
}

// ------------------------------------------------------------------
// Merge Helpers
// ------------------------------------------------------------------

/**
 * Merge D1 time series with WAE time series. WAE data takes priority
 * for overlapping dates.
 */
function mergeTimeSeries(
    d1Data: [string, D1AnalyticsCountResult][],
    waeData: ViewsGroupedByInterval,
): ViewsGroupedByInterval {
    const merged = new Map<
        string,
        { views: number; visitors: number; bounces: number }
    >();

    // Insert D1 data first
    for (const [dateStr, counts] of d1Data) {
        merged.set(dateStr, { ...counts });
    }

    // WAE data overwrites any overlapping dates
    for (const [dateStr, counts] of waeData) {
        merged.set(dateStr, { ...counts });
    }

    // Sort by date
    return Array.from(merged.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
    );
}

/**
 * Merge D1 visitor-count tuples with WAE visitor-count tuples.
 * Combines counts for the same dimension values.
 */
function mergeVisitorCounts(
    d1Data: [string, number][],
    waeData: [string, number][],
): [string, number][] {
    const merged = new Map<string, number>();

    for (const [key, count] of d1Data) {
        merged.set(key, (merged.get(key) || 0) + count);
    }
    for (const [key, count] of waeData) {
        merged.set(key, (merged.get(key) || 0) + count);
    }

    return Array.from(merged.entries()).sort((a, b) => b[1] - a[1]);
}

/**
 * Merge D1 path/referrer tuples [key, visitors, views] with WAE data.
 */
function mergeThreeColumnCounts(
    d1Data: [string, number, number][],
    waeData: [string, number, number][],
): [string, number, number][] {
    const merged = new Map<string, { visitors: number; views: number }>();

    for (const [key, visitors, views] of d1Data) {
        const existing = merged.get(key) || { visitors: 0, views: 0 };
        existing.visitors += visitors;
        existing.views += views;
        merged.set(key, existing);
    }
    for (const [key, visitors, views] of waeData) {
        const existing = merged.get(key) || { visitors: 0, views: 0 };
        existing.visitors += visitors;
        existing.views += views;
        merged.set(key, existing);
    }

    return Array.from(merged.entries())
        .map(
            ([key, val]) =>
                [key, val.visitors, val.views] as [string, number, number],
        )
        .sort((a, b) => b[1] - a[1]);
}

/**
 * Merge site lists from D1 and WAE, deduplicating and summing hits.
 */
function mergeSiteLists(
    d1Sites: [string, number][],
    waeSites: [string, number][],
): [string, number][] {
    const merged = new Map<string, number>();

    for (const [site, count] of d1Sites) {
        merged.set(site, (merged.get(site) || 0) + count);
    }
    for (const [site, count] of waeSites) {
        merged.set(site, (merged.get(site) || 0) + count);
    }

    return Array.from(merged.entries()).sort((a, b) => b[1] - a[1]);
}

// ------------------------------------------------------------------
// Unified Query Class
// ------------------------------------------------------------------

/**
 * UnifiedAnalyticsQuery transparently queries WAE for recent data
 * and D1 for historical data, merging results seamlessly.
 *
 * For intervals ≤90d: delegates entirely to WAE (unchanged behavior).
 * For intervals >90d: queries both WAE and D1, merges results.
 */
export class UnifiedAnalyticsQuery {
    private analyticsEngine: AnalyticsEngineAPI;
    private db: D1Database | null;

    constructor(analyticsEngine: AnalyticsEngineAPI, db: D1Database | null) {
        this.analyticsEngine = analyticsEngine;
        this.db = db;
    }

    /**
     * Get aggregate counts. For extended intervals, merges D1 + WAE data.
     */
    async getCounts(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
    ): Promise<{ views: number; visitors: number; bounces: number }> {
        if (!isExtendedInterval(interval) || !this.db) {
            return this.analyticsEngine.getCounts(siteId, interval, tz, filters);
        }

        const earliestDate = await getEarliestDataDate(this.db);
        const { d1StartDate, d1EndDate, waeInterval } =
            computeDateRangeSplit(interval, tz || "UTC", earliestDate);

        let dimensionType = "overall";
        let dimensionValue = "";

        const supportedFilters: Array<keyof SearchFilters> = [
            "path", "referrer", "browserName", "browserVersion", "country",
            "deviceType", "utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent"
        ];

        for (const filter of supportedFilters) {
            if (filters[filter]) {
                dimensionType = filter;
                dimensionValue = filters[filter] as string;
                break; // Only use the first found filter
            }
        }

        // Parallel fetch from D1 and WAE
        const [d1Counts, waeCounts] = await Promise.all([
            getD1Counts(this.db, siteId, d1StartDate, d1EndDate, dimensionType as any, dimensionValue),
            this.analyticsEngine.getCounts(siteId, waeInterval, tz, filters),
        ]);

        return {
            views: d1Counts.views + waeCounts.views,
            visitors: d1Counts.visitors + waeCounts.visitors,
            bounces: d1Counts.bounces + waeCounts.bounces,
        };
    }

    /**
     * Get views grouped by interval (for time series chart).
     */
    async getViewsGroupedByInterval(
        siteId: string,
        intervalType: string,
        startDateTime: Date,
        endDateTime: Date,
        tz?: string,
        filters: SearchFilters = {},
        interval?: string,
    ): Promise<ViewsGroupedByInterval> {
        if (
            !interval ||
            !isExtendedInterval(interval) ||
            !this.db
        ) {
            return this.analyticsEngine.getViewsGroupedByInterval(
                siteId,
                intervalType as "DAY" | "HOUR",
                startDateTime,
                endDateTime,
                tz,
                filters,
            );
        }

        const earliestDate = await getEarliestDataDate(this.db);
        const { d1StartDate, d1EndDate, waeInterval } = computeDateRangeSplit(
            interval,
            tz || "UTC",
            earliestDate,
        );

        // D1 data for historical period
        const d1Data = await getD1ViewsGroupedByInterval(
            this.db,
            siteId,
            d1StartDate,
            d1EndDate,
            filters,
        );

        // WAE data for the recent period
        const waeStartStr = waeInterval.substring(6).split("|")[0];
        const waeStartObj = dayjs(waeStartStr).toDate();
        const waeEndObj = endDateTime;

        const waeData = await this.analyticsEngine.getViewsGroupedByInterval(
            siteId,
            "DAY", // Always use DAY for extended ranges
            waeStartObj,
            waeEndObj,
            tz,
            filters,
        );

        const merged = mergeTimeSeries(d1Data, waeData);

        if (intervalType === "MONTH") {
            const monthly = new Map<string, { views: number; visitors: number; bounces: number }>();
            for (const [date, counts] of merged) {
                const monthDate = dayjs(date).startOf("month").format("YYYY-MM-DD 00:00:00");
                if (!monthly.has(monthDate)) {
                    monthly.set(monthDate, { views: 0, visitors: 0, bounces: 0 });
                }
                const accum = monthly.get(monthDate)!;
                accum.views += counts.views;
                accum.visitors += counts.visitors;
                accum.bounces += counts.bounces;
            }
            return Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        }

        if (intervalType === "WEEK") {
            const weekly = new Map<string, { views: number; visitors: number; bounces: number }>();
            for (const [date, counts] of merged) {
                const weekDate = dayjs(date).startOf("week").format("YYYY-MM-DD 00:00:00");
                if (!weekly.has(weekDate)) {
                    weekly.set(weekDate, { views: 0, visitors: 0, bounces: 0 });
                }
                const accum = weekly.get(weekDate)!;
                accum.views += counts.views;
                accum.visitors += counts.visitors;
                accum.bounces += counts.bounces;
            }
            return Array.from(weekly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        }

        return merged;
    }

    /**
     * Get visitor count by a dimension column (browser, country, device, etc.)
     */
    async getVisitorCountByColumn(
        siteId: string,
        dimensionType: DimensionType,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
        limit: number = 10,
    ): Promise<[string, number][]> {
        if (!isExtendedInterval(interval) || !this.db) {
            return this.analyticsEngine.getVisitorCountByColumn(
                siteId,
                dimensionType as any,
                interval,
                tz,
                filters,
                page,
                limit
            ) as Promise<[string, number][]>;
        }

        const earliestDate = await getEarliestDataDate(this.db);
        const { d1StartDate, d1EndDate, waeInterval } =
            computeDateRangeSplit(interval, tz || "UTC", earliestDate);

        const activeFilters = Object.keys(filters).filter((k) => filters[k as keyof SearchFilters]);
        const canUseD1 =
            activeFilters.length === 0 ||
            (activeFilters.length === 1 && activeFilters[0] === dimensionType);

        const [d1Data, waeData] = await Promise.all([
            canUseD1 ? getD1VisitorCountByColumn(
                this.db,
                siteId,
                dimensionType,
                d1StartDate,
                d1EndDate,
                1, // Get all from D1, paginate after merge
                1000,
            ) : Promise.resolve([] as [string, number][]),
            this.analyticsEngine.getVisitorCountByColumn(
                siteId,
                dimensionType as any,
                waeInterval,
                tz,
                filters,
                1,
                1000,
            ) as Promise<[string, number][]>,
        ]);

        const merged = mergeVisitorCounts(d1Data, waeData);

        // Paginate merged results
        const startIdx = (page - 1) * limit;
        return merged.slice(startIdx, startIdx + limit);
    }

    /**
     * Get count by path (visitors + views).
     */
    async getCountByPath(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number, number][]> {
        if (!isExtendedInterval(interval) || !this.db) {
            return this.analyticsEngine.getCountByPath(
                siteId,
                interval,
                tz,
                filters,
                page,
            );
        }

        const earliestDate = await getEarliestDataDate(this.db);
        const { d1StartDate, d1EndDate, waeInterval } =
            computeDateRangeSplit(interval, tz || "UTC", earliestDate);

        const activeFilters = Object.keys(filters).filter((k) => filters[k as keyof SearchFilters]);
        const canUseD1 =
            activeFilters.length === 0 ||
            (activeFilters.length === 1 && activeFilters[0] === "path");

        const [d1Data, waeDataObj] = await Promise.all([
            canUseD1 ? getD1CountByPath(this.db, siteId, d1StartDate, d1EndDate, 1, 1000) : Promise.resolve([] as [string, number, number][]),
            this.analyticsEngine.getAllCountsByColumn(
                siteId,
                "path",
                waeInterval,
                tz,
                filters,
                1,
                1000,
            ),
        ]);

        const waeData = Object.entries(waeDataObj).map(([key, val]) => [key, val.visitors, val.views] as [string, number, number]);
        const merged = mergeThreeColumnCounts(d1Data, waeData);
        const startIdx = (page - 1) * 10;
        return merged.slice(startIdx, startIdx + 10);
    }

    /**
     * Get count by referrer (visitors + views).
     */
    async getCountByReferrer(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number, number][]> {
        if (!isExtendedInterval(interval) || !this.db) {
            return this.analyticsEngine.getCountByReferrer(
                siteId,
                interval,
                tz,
                filters,
                page,
            );
        }

        const earliestDate = await getEarliestDataDate(this.db);
        const { d1StartDate, d1EndDate, waeInterval } =
            computeDateRangeSplit(interval, tz || "UTC", earliestDate);

        const activeFilters = Object.keys(filters).filter((k) => filters[k as keyof SearchFilters]);
        const canUseD1 =
            activeFilters.length === 0 ||
            (activeFilters.length === 1 && activeFilters[0] === "referrer");

        const [d1Data, waeDataObj] = await Promise.all([
            canUseD1 ? getD1CountByReferrer(
                this.db,
                siteId,
                d1StartDate,
                d1EndDate,
                1,
                1000,
            ) : Promise.resolve([] as [string, number, number][]),
            this.analyticsEngine.getAllCountsByColumn(
                siteId,
                "referrer",
                waeInterval,
                tz,
                filters,
                1,
                1000,
            ),
        ]);

        const waeData = Object.entries(waeDataObj).map(([key, val]) => [key, val.visitors, val.views] as [string, number, number]);
        const merged = mergeThreeColumnCounts(d1Data, waeData);
        const startIdx = (page - 1) * 10;
        return merged.slice(startIdx, startIdx + 10);
    }

    /**
     * Get count by country.
     */
    async getCountByCountry(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number][]> {
        return this.getVisitorCountByColumn(
            siteId,
            "country",
            interval,
            tz,
            filters,
            page,
        );
    }

    /**
     * Get count by browser.
     */
    async getCountByBrowser(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number][]> {
        return this.getVisitorCountByColumn(
            siteId,
            "browserName",
            interval,
            tz,
            filters,
            page,
        );
    }

    /**
     * Get count by browser version.
     */
    async getCountByBrowserVersion(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number][]> {
        return this.getVisitorCountByColumn(
            siteId,
            "browserVersion",
            interval,
            tz,
            filters,
            page,
        );
    }

    /**
     * Get count by device model.
     */
    async getCountByDeviceModel(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number][]> {
        return this.getVisitorCountByColumn(
            siteId,
            "deviceModel",
            interval,
            tz,
            filters,
            page,
        );
    }

    /**
     * Get count by device type.
     */
    async getCountByDeviceType(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[string, number][]> {
        return this.getVisitorCountByColumn(
            siteId,
            "deviceType",
            interval,
            tz,
            filters,
            page,
        );
    }

    // UTM methods
    async getCountByUtmSource(siteId: string, interval: string, tz?: string, filters: SearchFilters = {}, page: number = 1) {
        return this.getVisitorCountByColumn(siteId, "utmSource", interval, tz, filters, page);
    }
    async getCountByUtmMedium(siteId: string, interval: string, tz?: string, filters: SearchFilters = {}, page: number = 1) {
        return this.getVisitorCountByColumn(siteId, "utmMedium", interval, tz, filters, page);
    }
    async getCountByUtmCampaign(siteId: string, interval: string, tz?: string, filters: SearchFilters = {}, page: number = 1) {
        return this.getVisitorCountByColumn(siteId, "utmCampaign", interval, tz, filters, page);
    }
    async getCountByUtmTerm(siteId: string, interval: string, tz?: string, filters: SearchFilters = {}, page: number = 1) {
        return this.getVisitorCountByColumn(siteId, "utmTerm", interval, tz, filters, page);
    }
    async getCountByUtmContent(siteId: string, interval: string, tz?: string, filters: SearchFilters = {}, page: number = 1) {
        return this.getVisitorCountByColumn(siteId, "utmContent", interval, tz, filters, page);
    }

    /**
     * Get sites ordered by hits. For extended intervals, merges D1 + WAE.
     */
    async getSitesOrderedByHits(
        interval: string,
        limit?: number,
    ): Promise<[string, number][]> {
        if (!isExtendedInterval(interval) || !this.db) {
            return this.analyticsEngine.getSitesOrderedByHits(interval, limit);
        }

        const earliestDate = await getEarliestDataDate(this.db);
        const { d1StartDate, d1EndDate, waeInterval } =
            computeDateRangeSplit(interval, "UTC", earliestDate);

        const fetchLimit = Math.max(limit || 10, 100);
        const [d1Sites, waeSites] = await Promise.all([
            getD1SitesOrderedByHits(this.db, d1StartDate, d1EndDate, fetchLimit),
            this.analyticsEngine.getSitesOrderedByHits(waeInterval, fetchLimit),
        ]);

        return mergeSiteLists(d1Sites, waeSites).slice(0, limit || 10);
    }

    /**
     * Get earliest events — delegates to WAE (this is used for bounce rate validation).
     */
    async getEarliestEvents(siteId: string) {
        return this.analyticsEngine.getEarliestEvents(siteId);
    }

    // ------------------------------------------------------------------
    // (End of UnifiedAnalyticsQuery)
    // ------------------------------------------------------------------
}
