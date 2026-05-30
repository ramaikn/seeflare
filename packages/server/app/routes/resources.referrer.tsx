import { useFetcher } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import PaginatedTableCard from "~/components/PaginatedTableCard";
import { paramsFromUrl, getFiltersFromSearchParams } from "~/lib/utils";
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
        const countsByProperty = await unifiedQuery.getCountByReferrer(
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

    if (isExtended) {
        const filtersHash = hashFilters(filters as Record<string, string | undefined>);
        const cacheKey = buildCacheKey("referrer", {
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
}

export const ReferrerCard = ({
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
            columnHeaders={["Referrer", "Visitors", "Views"]}
            dataFetcher={useFetcher<typeof loader>()}
            loaderUrl="/resources/referrer"
            filters={filters}
            onClick={(referrer) => onFilterChange({ ...filters, referrer })}
            timezone={timezone}
        />
    );
};
