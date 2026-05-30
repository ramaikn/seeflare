const fs = require('fs');
const path = require('path');

const routes = [
    { file: 'resources.browserversion.tsx', method: 'getCountByBrowserVersion', cacheKey: 'browserversion' },
    { file: 'resources.device.tsx', method: 'getCountByDevice', cacheKey: 'device' },
    { file: 'resources.utm-source.tsx', method: 'getCountByUtmSource', cacheKey: 'utm-source' },
    { file: 'resources.utm-medium.tsx', method: 'getCountByUtmMedium', cacheKey: 'utm-medium' },
    { file: 'resources.utm-campaign.tsx', method: 'getCountByUtmCampaign', cacheKey: 'utm-campaign' },
    { file: 'resources.utm-term.tsx', method: 'getCountByUtmTerm', cacheKey: 'utm-term' },
    { file: 'resources.utm-content.tsx', method: 'getCountByUtmContent', cacheKey: 'utm-content' }
];

const dir = 'c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes';

routes.forEach(({ file, method, cacheKey }) => {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return;
    }
    
    let content = fs.readFileSync(filePath, 'utf8');

    // Make sure we have the necessary imports
    if (!content.includes('requireAuth')) {
        content = content.replace(
            /import { SearchFilters } from "~\/lib\/types";/,
            `import { SearchFilters } from "~/lib/types";\nimport { requireAuth } from "~/lib/auth";\nimport { isExtendedInterval } from "~/analytics/unified-query";\nimport { buildCacheKey, getCachedOrFetch, hashFilters } from "~/analytics/cache-layer";`
        );
    }
    
    // Replace the loader function
    const loaderRegex = /export async function loader\(\{ context, request \}: LoaderFunctionArgs\) \{[\s\S]*?    \};\n\}/;
    
    const newLoader = `export async function loader({ context, request }: LoaderFunctionArgs) {
    await requireAuth(request, context.cloudflare.env);
    const { unifiedQuery } = context;

    const { interval, site, page = 1 } = paramsFromUrl(request.url);
    const url = new URL(request.url);
    const tz = url.searchParams.get("timezone") || "UTC";
    const filters = getFiltersFromSearchParams(url.searchParams);

    const isExtended = isExtendedInterval(interval);
    const pageNum = Number(page);

    const fetchData = async () => {
        const countsByProperty = await unifiedQuery.${method}(
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
        const cacheKey = buildCacheKey("${cacheKey}", {
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
}`;

    content = content.replace(loaderRegex, newLoader);
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${file}`);
});
