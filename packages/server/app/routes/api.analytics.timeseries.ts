import { type LoaderFunctionArgs } from "react-router";
import { requireAuth } from "~/lib/auth";
import { getFiltersFromSearchParams, getIntervalType, getDateTimeRange } from "~/lib/utils";
import { isExtendedInterval } from "~/analytics/unified-query";
import { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";
import type { ApiTimeseriesEntry, ApiResponse } from "~/lib/types/api";
import type { ViewsGroupedByInterval } from "~/analytics/query";

export async function loader({ context, request }: LoaderFunctionArgs) {
    await requireAuth(request, context.cloudflare.env);
    const { unifiedQuery } = context;
    
    const url = new URL(request.url);
    const site = url.searchParams.get("site");
    if (!site) {
        throw new Response("Missing site parameter", { status: 400 });
    }
    const interval = url.searchParams.get("interval") || "7d";
    const tz = url.searchParams.get("timezone") || "UTC";
    const filters = getFiltersFromSearchParams(url.searchParams);
    
    const isExtended = isExtendedInterval(interval);

    const fetchTimeseriesData = async () => {
        const intervalType = getIntervalType(interval);
        const { startDate, endDate } = getDateTimeRange(interval, tz);

        const viewsGrouped = (await unifiedQuery.getViewsGroupedByInterval(
            site, intervalType, startDate, endDate, tz, filters, interval
        )) as ViewsGroupedByInterval;

        return viewsGrouped.map((row) => ({
            date: row[0],
            views: row[1].views,
            visitors: row[1].visitors,
            bounce_rate: row[1].visitors > 0 ? row[1].bounces / row[1].visitors : 0,
        }));
    };

    let timeseriesData;
    let cacheHit = false;

    if (isExtended) {
        const filtersHash = hashFilters(filters as Record<string, string | undefined>);
        const cacheKey = buildCacheKey("api-analytics-timeseries", {
            site,
            interval,
            tz,
            filters: filtersHash,
        });

        const cacheResult = await getCachedOrFetch(cacheKey, fetchTimeseriesData);
        timeseriesData = cacheResult.data;
        cacheHit = cacheResult.cacheHit;
    } else {
        timeseriesData = await fetchTimeseriesData();
    }

    const fullResponse: ApiResponse<ApiTimeseriesEntry[]> = {
        meta: {
            site,
            interval,
            timezone: tz,
            generated_at: new Date().toISOString(),
            data_sources: isExtended ? ["wae", "d1"] : ["wae"],
            cache_hit: cacheHit,
        },
        data: timeseriesData,
    };

    return fullResponse;
}
