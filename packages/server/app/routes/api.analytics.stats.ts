import { type LoaderFunctionArgs } from "react-router";
import { requireAuth } from "~/lib/auth";
import { getFiltersFromSearchParams, getDateTimeRange, checkHasSufficientBounceData } from "~/lib/utils";
import { isExtendedInterval } from "~/analytics/unified-query";
import { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";
import type { ApiStatsResponse, ApiResponse } from "~/lib/types/api";

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

    const fetchStatsData = async () => {
        const { startDate } = getDateTimeRange(interval, tz);
        
        const [earliestEvents, counts] = await Promise.all([
            unifiedQuery.getEarliestEvents(site),
            unifiedQuery.getCounts(site, interval, tz, filters)
        ]);

        const { earliestEvent, earliestBounce } = earliestEvents;
        const hasSufficientBounceData = checkHasSufficientBounceData(
            earliestEvent,
            earliestBounce,
            startDate
        );

        const bounceRate =
            hasSufficientBounceData && counts.visitors > 0
                ? counts.bounces / counts.visitors
                : null;

        return {
            views: counts.views,
            visitors: counts.visitors,
            bounce_rate: bounceRate,
        };
    };

    let statsData;
    let cacheHit = false;

    if (isExtended) {
        const filtersHash = hashFilters(filters as Record<string, string | undefined>);
        const cacheKey = buildCacheKey("api-analytics-stats", {
            site,
            interval,
            tz,
            filters: filtersHash,
        });

        const cacheResult = await getCachedOrFetch(cacheKey, fetchStatsData);
        statsData = cacheResult.data;
        cacheHit = cacheResult.cacheHit;
    } else {
        statsData = await fetchStatsData();
    }

    const fullResponse: ApiResponse<ApiStatsResponse> = {
        meta: {
            site,
            interval,
            timezone: tz,
            generated_at: new Date().toISOString(),
            data_sources: isExtended ? ["wae", "d1"] : ["wae"],
            cache_hit: cacheHit,
        },
        data: statsData,
    };

    return fullResponse;
}
