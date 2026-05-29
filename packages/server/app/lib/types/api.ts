/**
 * TypeScript types for Seeflare API responses.
 */

export interface ApiMeta {
    site: string;
    interval: string;
    timezone: string;
    generated_at: string;
    data_sources: ("wae" | "d1")[];
    cache_hit: boolean;
}

export interface ApiStatsResponse {
    views: number;
    visitors: number;
    bounce_rate: number | null;
}

export interface ApiTimeseriesEntry {
    date: string;
    views: number;
    visitors: number;
    bounce_rate: number;
}

export interface ApiDimensionEntry {
    value: string;
    visitors: number;
    views?: number;
}

export interface ApiUtmData {
    sources: ApiDimensionEntry[];
    mediums: ApiDimensionEntry[];
    campaigns: ApiDimensionEntry[];
    terms: ApiDimensionEntry[];
    contents: ApiDimensionEntry[];
}

export interface ApiAnalyticsResponse {
    meta: ApiMeta;
    stats: ApiStatsResponse;
    timeseries: ApiTimeseriesEntry[];
    paths: ApiDimensionEntry[];
    referrers: ApiDimensionEntry[];
    countries: ApiDimensionEntry[];
    browsers: ApiDimensionEntry[];
    devices: ApiDimensionEntry[];
    utm: ApiUtmData;
}

/** Individual endpoint response wrapper */
export interface ApiResponse<T> {
    meta: ApiMeta;
    data: T;
}
