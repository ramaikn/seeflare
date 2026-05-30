import { useFetcher } from "react-router";

import type { LoaderFunctionArgs } from "react-router";

import { getFiltersFromSearchParams, paramsFromUrl } from "~/lib/utils";
import PaginatedTableCard from "~/components/PaginatedTableCard";
import { SearchFilters } from "~/lib/types";
import { requireAuth } from "~/lib/auth";
import { isExtendedInterval } from "~/analytics/unified-query";
import { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";

export async function loader({ context, request }: LoaderFunctionArgs) {
    await requireAuth(request, context.cloudflare.env);
    const { unifiedQuery } = context;

    const { interval, site, page = 1 } = paramsFromUrl(request.url);
    const url = new URL(request.url);
    const tz = url.searchParams.get("timezone") || "UTC";
    const filters = getFiltersFromSearchParams(url.searchParams);

    const isExtended = isExtendedInterval(interval);
    const pageNum = Number(page);

    const fetchData = async () => {
        const countsByProperty = await unifiedQuery.getCountByDeviceType(
            site,
            interval,
            tz,
            filters,
            pageNum,
        );
        return {
            countsByProperty,
            page: pageNum,
        };
    };

    try {
        if (isExtended) {
            const filtersHash = hashFilters(filters as Record<string, string | undefined>);
            const cacheKey = buildCacheKey("device", {
                site,
                interval,
                tz,
                page: pageNum,
                filters: filtersHash,
            });

            const cacheResult = await getCachedOrFetch(cacheKey, fetchData);
            return cacheResult.data;
        } else {
            return await fetchData();
        }
    } catch (error) {
        console.error("device loader error:", error);
        return { countsByProperty: [], page: pageNum };
    }
}

export const DeviceCard = ({
    siteId,
    interval,
    filters,
    onFilterChange,
    timezone,
}: {
    siteId: string;
    interval: string;
    filters: SearchFilters;
    onFilterChange: (filters: SearchFilters) => void;
    timezone: string;
}) => {
    return (
        <PaginatedTableCard
            siteId={siteId}
            interval={interval}
            columnHeaders={["Device", "Visitors"]}
            dataFetcher={useFetcher<typeof loader>()}
            loaderUrl="/resources/device"
            filters={filters}
            onClick={(deviceType) => onFilterChange({ ...filters, deviceType })}
            timezone={timezone}
            labelFormatter={(label) =>
                label.charAt(0).toUpperCase() + label.slice(1)
            }
        />
    );
};
