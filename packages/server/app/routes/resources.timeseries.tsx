import type { LoaderFunctionArgs } from "react-router";
import {
    getFiltersFromSearchParams,
    paramsFromUrl,
    getIntervalType,
    getDateTimeRange,
} from "~/lib/utils";
import { useEffect } from "react";
import { useFetcher } from "react-router";
import { Card, CardContent } from "~/components/ui/card";
import TimeSeriesChart from "~/components/TimeSeriesChart";
import { SearchFilters } from "~/lib/types";
import { requireAuth } from "~/lib/auth";
import type { ViewsGroupedByInterval } from "~/analytics/query";
import { isExtendedInterval } from "~/analytics/unified-query";
import { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";

export async function loader({
    context,
    request,
}: LoaderFunctionArgs) {
    await requireAuth(request, context.cloudflare.env);

    const { unifiedQuery } = context;
    const { interval, site } = paramsFromUrl(request.url);
    const url = new URL(request.url);
    const tz = url.searchParams.get("timezone") || "UTC";
    const filters = getFiltersFromSearchParams(url.searchParams);

    const intervalType = getIntervalType(interval);
    const { startDate, endDate } = getDateTimeRange(interval, tz);
    const isExtended = isExtendedInterval(interval);

    const fetchData = async () => {
        const viewsGroupedByInterval: ViewsGroupedByInterval =
            await unifiedQuery.getViewsGroupedByInterval(
                site,
                intervalType,
                startDate,
                endDate,
                tz,
                filters,
                interval
            );

        const chartData: {
            date: string;
            views: number;
            visitors: number;
            bounceRate: number;
        }[] = [];
        viewsGroupedByInterval.forEach((row) => {
            const { views, visitors, bounces } = row[1];

            chartData.push({
                date: row[0],
                views,
                visitors,
                bounceRate: Math.floor(
                    (visitors > 0 ? bounces / visitors : 0) * 100,
                ),
            });
        });

        return {
            chartData: chartData,
            intervalType: intervalType,
        };
    };

    if (isExtended) {
        const filtersHash = hashFilters(filters as Record<string, string | undefined>);
        const cacheKey = buildCacheKey("timeseries", {
            site,
            interval,
            tz,
            filters: filtersHash,
        });

        const cacheResult = await getCachedOrFetch(cacheKey, fetchData);
        return cacheResult.data;
    } else {
        return await fetchData();
    }
}

export const TimeSeriesCard = ({
    siteId,
    interval,
    filters,
    timezone,
}: {
    siteId: string;
    interval: string;
    filters: SearchFilters;
    timezone: string;
}) => {
    const dataFetcher = useFetcher<typeof loader>();
    const { chartData, intervalType } = dataFetcher.data || {};

    useEffect(() => {
        const params = {
            site: siteId,
            interval,
            timezone,
            ...filters,
        };

        dataFetcher.submit(params, {
            method: "get",
            action: `/resources/timeseries`,
        });
        // NOTE: dataFetcher is intentionally omitted from the useEffect dependency array
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [siteId, interval, filters, timezone]);

    return (
        <Card>
            <CardContent>
                <div className="h-72 pt-6 -m-4 -mr-10 -ml-10 sm:-m-2 sm:-ml-6 sm:-mr-6">
                    {chartData && (
                        <TimeSeriesChart
                            data={chartData}
                            intervalType={intervalType}
                        />
                    )}
                </div>
            </CardContent>
        </Card>
    );
};
