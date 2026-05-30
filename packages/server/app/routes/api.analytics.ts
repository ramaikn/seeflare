import { type LoaderFunctionArgs } from "react-router";
import { requireAuth } from "~/lib/auth";
import { getFiltersFromSearchParams, getIntervalType, getDateTimeRange } from "~/lib/utils";
import { isExtendedInterval } from "~/analytics/unified-query";
import { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";
import type { ApiAnalyticsResponse, ApiDimensionEntry } from "~/lib/types/api";
import type { ViewsGroupedByInterval } from "~/analytics/query";

function mapToDimensionEntry(data: [string, number][] | [string, number, number][]): ApiDimensionEntry[] {
    return data.map((item) => {
        if (item.length === 3) {
            return { value: item[0], visitors: item[1] as number, views: item[2] as number };
        }
        return { value: item[0], visitors: item[1] as number };
    });
}

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
    
    const pageStr = url.searchParams.get("page");
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    const isExtended = isExtendedInterval(interval);

    const fetchCombinedData = async () => {
        const intervalType = getIntervalType(interval);
        const { startDate, endDate } = getDateTimeRange(interval, tz);

        // Fetch all data in parallel
        const [
            earliestEvents,
            counts,
            viewsGrouped,
            paths,
            referrers,
            countries,
            browsers,
            browserVersions,
            devices,
            deviceModels,
            utmSources,
            utmMediums,
            utmCampaigns,
            utmTerms,
            utmContents
        ] = await Promise.all([
            unifiedQuery.getEarliestEvents(site),
            unifiedQuery.getCounts(site, interval, tz, filters),
            unifiedQuery.getViewsGroupedByInterval(site, intervalType, startDate, endDate, tz, filters, interval),
            unifiedQuery.getCountByPath(site, interval, tz, filters, page),
            unifiedQuery.getCountByReferrer(site, interval, tz, filters, page),
            unifiedQuery.getCountByCountry(site, interval, tz, filters, page),
            unifiedQuery.getCountByBrowser(site, interval, tz, filters, page),
            unifiedQuery.getCountByBrowserVersion(site, interval, tz, filters, page),
            unifiedQuery.getCountByDeviceType(site, interval, tz, filters, page),
            unifiedQuery.getCountByDeviceModel(site, interval, tz, filters, page),
            unifiedQuery.getCountByUtmSource(site, interval, tz, filters, page),
            unifiedQuery.getCountByUtmMedium(site, interval, tz, filters, page),
            unifiedQuery.getCountByUtmCampaign(site, interval, tz, filters, page),
            unifiedQuery.getCountByUtmTerm(site, interval, tz, filters, page),
            unifiedQuery.getCountByUtmContent(site, interval, tz, filters, page),
        ]);

        const { earliestEvent, earliestBounce } = earliestEvents;
        const hasSufficientBounceData =
            earliestBounce !== null &&
            earliestEvent !== null &&
            (earliestEvent.getTime() == earliestBounce.getTime() ||
                earliestBounce < startDate);

        const bounceRate =
            hasSufficientBounceData && counts.visitors > 0
                ? counts.bounces / counts.visitors
                : null;

        const timeseries = (viewsGrouped as ViewsGroupedByInterval).map((row) => ({
            date: row[0],
            views: row[1].views,
            visitors: row[1].visitors,
            bounce_rate: row[1].visitors > 0 ? row[1].bounces / row[1].visitors : 0,
        }));

        const responseData: Omit<ApiAnalyticsResponse, "meta"> = {
            stats: {
                views: counts.views,
                visitors: counts.visitors,
                bounce_rate: bounceRate,
            },
            timeseries,
            paths: mapToDimensionEntry(paths),
            referrers: mapToDimensionEntry(referrers),
            countries: mapToDimensionEntry(countries),
            browsers: mapToDimensionEntry(browsers),
            browser_versions: mapToDimensionEntry(browserVersions),
            devices: mapToDimensionEntry(devices),
            device_models: mapToDimensionEntry(deviceModels),
            utm: {
                sources: mapToDimensionEntry(utmSources),
                mediums: mapToDimensionEntry(utmMediums),
                campaigns: mapToDimensionEntry(utmCampaigns),
                terms: mapToDimensionEntry(utmTerms),
                contents: mapToDimensionEntry(utmContents),
            }
        };

        return responseData;
    };

    let responseData: Omit<ApiAnalyticsResponse, "meta">;
    let cacheHit = false;

    if (isExtended) {
        const filtersHash = hashFilters(filters as Record<string, string | undefined>);
        const cacheKey = buildCacheKey("api-analytics", {
            site,
            interval,
            tz,
            page,
            filters: filtersHash,
        });

        const cacheResult = await getCachedOrFetch(cacheKey, fetchCombinedData);
        responseData = cacheResult.data;
        cacheHit = cacheResult.cacheHit;
    } else {
        responseData = await fetchCombinedData();
    }

    const fullResponse: ApiAnalyticsResponse = {
        meta: {
            site,
            interval,
            timezone: tz,
            generated_at: new Date().toISOString(),
            data_sources: isExtended ? ["wae", "d1"] : ["wae"],
            cache_hit: cacheHit,
        },
        ...responseData
    };

    return fullResponse;
}
