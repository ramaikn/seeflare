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
 * Generate a cache version string that automatically increments at 01:05 UTC.
 * Since the cron job runs at 01:00 UTC, this ensures all cache keys become stale
 * immediately after daily aggregation finishes.
 */
function getCacheVersion(): string {
    // 01:05 UTC = 3900000 ms after midnight.
    return Math.floor((Date.now() - 3900000) / 86400000).toString();
}

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

    // Add cache version to automatically invalidate all keys daily
    url.searchParams.set("v", getCacheVersion());

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
        const cache = (caches as any).default;
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
        const cache = (caches as any).default;
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
    // Await cache write to prevent Cloudflare Worker runtime from killing the promise prematurely
    await setCache(cacheKey, data, ttlSeconds);
    return { data, cacheHit: false };
}

/**
 * Delete a specific cache entry.
 */
export async function deleteCache(cacheKey: string): Promise<boolean> {
    try {
        const cache = (caches as any).default;
        const request = new Request(cacheKey);
        return await cache.delete(request);
    } catch (err) {
        console.error("Cache delete error:", err);
        return false;
    }
}

/**
 * Purging is now handled automatically via Cache Versioning in buildCacheKey.
 * Kept for backwards compatibility with existing caller.
 */
export async function purgeSiteCache(
    siteId: string,
    routes: string[] = [],
    intervals: string[] = [],
): Promise<number> {
    return 0;
}

/**
 * Purging is now handled automatically via Cache Versioning in buildCacheKey.
 * Kept for backwards compatibility with existing caller.
 */
export async function purgeAllSitesCache(
    siteIds: string[],
): Promise<number> {
    return 0;
}
