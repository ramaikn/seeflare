/**
 * Workers Cache API layer for Seeflare analytics.
 *
 * Caches analytics query results using Cloudflare's edge cache.
 * - Zero cost (no read/write charges)
 * - Sub-millisecond latency for cache hits
 * - Default TTL: 24 hours (data changes daily via cron)
 * - Per-colo caching (first request per PoP is uncached)
 */

const CACHE_NAMESPACE = "https://seeflare-cache.internal";
const DEFAULT_TTL_SECONDS = 86400; // 24 hours

/**
 * Generate a deterministic cache key URL from route + params.
 */
export function buildCacheKey(
    route: string,
    params: Record<string, string | number | undefined>,
): string {
    const url = new URL(`${CACHE_NAMESPACE}/${route}`);

    // Sort params for deterministic keys
    const sortedKeys = Object.keys(params).sort();
    for (const key of sortedKeys) {
        const value = params[key];
        if (value !== undefined && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    return url.toString();
}

/**
 * Hash filter params into a short string for cache key inclusion.
 */
export function hashFilters(
    filters: Record<string, string | undefined>,
): string {
    const parts: string[] = [];
    const sortedKeys = Object.keys(filters).sort();
    for (const key of sortedKeys) {
        if (filters[key]) {
            parts.push(`${key}=${filters[key]}`);
        }
    }
    return parts.join("&") || "none";
}

/**
 * Try to get a cached response. Returns null on cache miss.
 */
export async function getCached<T>(cacheKey: string): Promise<T | null> {
    try {
        const cache = caches.default;
        const request = new Request(cacheKey);
        const response = await cache.match(request);

        if (response) {
            return (await response.json()) as T;
        }
    } catch (err) {
        // Cache miss or error — fall through
        console.error("Cache read error:", err);
    }

    return null;
}

/**
 * Store a value in the cache with a TTL.
 */
export async function setCache<T>(
    cacheKey: string,
    data: T,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
    try {
        const cache = caches.default;
        const request = new Request(cacheKey);
        const response = new Response(JSON.stringify(data), {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": `s-maxage=${ttlSeconds}`,
            },
        });
        await cache.put(request, response);
    } catch (err) {
        console.error("Cache write error:", err);
    }
}

/**
 * Generic cache-through: return cached data if available,
 * otherwise call fetcher, cache the result, and return it.
 */
export async function getCachedOrFetch<T>(
    cacheKey: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<{ data: T; cacheHit: boolean }> {
    const cached = await getCached<T>(cacheKey);
    if (cached !== null) {
        return { data: cached, cacheHit: true };
    }

    const data = await fetcher();
    // Fire-and-forget cache write — don't block the response
    setCache(cacheKey, data, ttlSeconds).catch(() => {});
    return { data, cacheHit: false };
}

/**
 * Delete a specific cache entry.
 */
export async function deleteCache(cacheKey: string): Promise<boolean> {
    try {
        const cache = caches.default;
        const request = new Request(cacheKey);
        return await cache.delete(request);
    } catch (err) {
        console.error("Cache delete error:", err);
        return false;
    }
}

/**
 * Purge all cached analytics data for the given site and intervals.
 * Called by the cron job after daily aggregation to invalidate stale data.
 *
 * Since Workers Cache API doesn't support wildcard deletion, we build
 * known cache keys for common intervals and delete them.
 */
export async function purgeSiteCache(
    siteId: string,
    routes: string[] = [
        "stats",
        "timeseries",
        "paths",
        "referrer",
        "country",
        "browser",
        "browserversion",
        "device",
        "utm-source",
        "utm-medium",
        "utm-campaign",
        "utm-term",
        "utm-content",
    ],
    intervals: string[] = [
        "120d",
        "365d",
        "1095d",
        "1825d",
        "all",
    ],
): Promise<number> {
    let purged = 0;

    for (const route of routes) {
        for (const interval of intervals) {
            // Purge with common page numbers (1-5)
            for (let page = 1; page <= 5; page++) {
                const cacheKey = buildCacheKey(route, {
                    site: siteId,
                    interval,
                    page,
                    filters: "none",
                });

                const deleted = await deleteCache(cacheKey);
                if (deleted) purged++;
            }
        }
    }

    return purged;
}

/**
 * Purge all cached data for all known sites after daily aggregation.
 * Accepts a list of site IDs to purge.
 */
export async function purgeAllSitesCache(
    siteIds: string[],
): Promise<number> {
    let totalPurged = 0;
    for (const siteId of siteIds) {
        totalPurged += await purgeSiteCache(siteId);
    }
    return totalPurged;
}
