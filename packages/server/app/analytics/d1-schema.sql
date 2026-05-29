-- Seeflare D1 Analytics Aggregation Schema
-- This schema stores daily and monthly aggregated analytics data
-- extracted from Cloudflare Workers Analytics Engine (WAE).
--
-- Design: Dimension-based EAV pattern
-- Each row stores (date, site, dimension_type, dimension_value, counts)
-- This supports all dashboard dimensions: path, referrer, country, browser, etc.

CREATE TABLE IF NOT EXISTS daily_aggregates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                          -- 'YYYY-MM-DD' for daily, 'YYYY-MM' for monthly
    granularity TEXT NOT NULL DEFAULT 'day',     -- 'day' or 'month'
    site_id TEXT NOT NULL,
    dimension_type TEXT NOT NULL,                -- 'overall', 'path', 'referrer', 'country',
                                                -- 'browserName', 'deviceType', 'browserVersion',
                                                -- 'deviceModel', 'utmSource', 'utmMedium',
                                                -- 'utmCampaign', 'utmTerm', 'utmContent'
    dimension_value TEXT NOT NULL DEFAULT '',    -- e.g. '/about', 'google.com', 'US'
    views INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(date, site_id, dimension_type, dimension_value, granularity)
);

-- Primary lookup index: site + dimension queries within date range
CREATE INDEX IF NOT EXISTS idx_daily_agg_lookup
    ON daily_aggregates(site_id, dimension_type, date, granularity);

-- Date-based queries for compaction and time series
CREATE INDEX IF NOT EXISTS idx_daily_agg_date
    ON daily_aggregates(date, granularity);

-- Compaction queries: find old daily rows
CREATE INDEX IF NOT EXISTS idx_daily_agg_compact
    ON daily_aggregates(granularity, date);

-- Metadata table for tracking aggregation state
CREATE TABLE IF NOT EXISTS aggregation_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
