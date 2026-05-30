import { type LoaderFunctionArgs } from "react-router";
import { requireAuth } from "~/lib/auth";
import { getFiltersFromSearchParams } from "~/lib/utils";
import { isExtendedInterval } from "~/analytics/unified-query";
import { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";
import type { ApiDimensionEntry, ApiResponse } from "~/lib/types/api";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
    await requireAuth(request, context.cloudflare.env);
    const { unifiedQuery } = context;
    
    const dimension = params.dimension;
    
    const url = new URL(request.url);
    const site = url.searchParams.get("site");
    if (!site) {
        throw new Response("Missing site parameter", { status: 400 });
    }
    const interval = url.searchParams.get("interval") || "7d";
    const tz = url.searchParams.get("timezone") || "UTC";
    const pageStr = url.searchParams.get("page");
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    const filters = getFiltersFromSearchParams(url.searchParams);
    
    const isExtended = isExtendedInterval(interval);

    const fetchDimensionData = async () => {
        let data: [string, number][] | [string, number, number][];

        switch (dimension) {
            case "paths":
                data = await unifiedQuery.getCountByPath(site, interval, tz, filters, page);
                break;
            case "referrers":
                data = await unifiedQuery.getCountByReferrer(site, interval, tz, filters, page);
                break;
            case "countries":
                data = await unifiedQuery.getCountByCountry(site, interval, tz, filters, page);
                break;
            case "browsers":
                data = await unifiedQuery.getCountByBrowser(site, interval, tz, filters, page);
                break;
            case "browser_versions":
                data = await unifiedQuery.getCountByBrowserVersion(site, interval, tz, filters, page);
                break;
            case "devices":
                data = await unifiedQuery.getCountByDeviceType(site, interval, tz, filters, page);
                break;
            case "device_models":
                data = await unifiedQuery.getCountByDeviceModel(site, interval, tz, filters, page);
                break;
            case "utm_sources":
                data = await unifiedQuery.getCountByUtmSource(site, interval, tz, filters, page);
                break;
            case "utm_mediums":
                data = await unifiedQuery.getCountByUtmMedium(site, interval, tz, filters, page);
                break;
            case "utm_campaigns":
                data = await unifiedQuery.getCountByUtmCampaign(site, interval, tz, filters, page);
                break;
            case "utm_terms":
                data = await unifiedQuery.getCountByUtmTerm(site, interval, tz, filters, page);
                break;
            case "utm_contents":
                data = await unifiedQuery.getCountByUtmContent(site, interval, tz, filters, page);
                break;
            default:
                throw new Response(`Unsupported dimension: ${dimension}`, { status: 400 });
        }

        return data.map((item) => {
            if (item.length === 3) {
                return { value: item[0], visitors: item[1] as number, views: item[2] as number };
            }
            return { value: item[0], visitors: item[1] as number };
        });
    };

    let dimensionData;
    let cacheHit = false;

    if (isExtended) {
        const filtersHash = hashFilters(filters as Record<string, string | undefined>);
        const cacheKey = buildCacheKey(`api-analytics-${dimension}`, {
            site,
            interval,
            tz,
            page,
            filters: filtersHash,
        });

        const cacheResult = await getCachedOrFetch(cacheKey, fetchDimensionData);
        dimensionData = cacheResult.data;
        cacheHit = cacheResult.cacheHit;
    } else {
        dimensionData = await fetchDimensionData();
    }

    const fullResponse: ApiResponse<ApiDimensionEntry[]> = {
        meta: {
            site,
            interval,
            timezone: tz,
            generated_at: new Date().toISOString(),
            data_sources: isExtended ? ["wae", "d1"] : ["wae"],
            cache_hit: cacheHit,
        },
        data: dimensionData,
    };

    return fullResponse;
}
