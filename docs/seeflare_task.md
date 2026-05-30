# Seeflare: Smart Aggregation + API Implementation Tasks
## Phase 1: D1 Database Foundation
- [x] 1.1 Create D1 schema SQL file (`d1-schema.sql`)
- [x] 1.2 Create D1 aggregation module (`d1-aggregation.ts`)
- [x] 1.3 Create D1 query module (`d1-query.ts`)
## Phase 2: Unified Query & Cache
- [x] 2.1 Create unified query layer (`unified-query.ts`)
- [x] 2.2 Create cache layer (`cache-layer.ts`)
## Phase 3: Infrastructure & Config
- [x] 3.1 Update wrangler.json with D1 binding
- [x] 3.2 Update load-context.ts to expose D1
- [x] 3.3 Update utils.ts (interval handling, helpers)
- [x] 3.4 Update query.ts intervalToSql for extended ranges
## Phase 4: Enhanced Cron Job
- [x] 4.1 Update app.ts scheduled handler (aggregation + compaction + cache purge)
## Phase 5: Dashboard Route Updates
- [x] 5.1 Update resources.stats.tsx
- [x] 5.2 Update resources.timeseries.tsx
- [x] 5.3 Update resources.paths.tsx
- [x] 5.4 Update resources.referrer.tsx
- [x] 5.5 Update resources.country.tsx
- [x] 5.6 Update resources.browser.tsx
- [x] 5.7 Update resources.browserversion.tsx
- [x] 5.8 Update resources.device.tsx
- [x] 5.9 Update resources.utm-source.tsx
- [x] 5.10 Update resources.utm-medium.tsx
- [x] 5.11 Update resources.utm-campaign.tsx
- [x] 5.12 Update resources.utm-term.tsx
- [x] 5.13 Update resources.utm-content.tsx
- [x] 5.14 Update dashboard.tsx (MAX_RETENTION_DAYS, etc.)
## Phase 6: API Routes
- [x] 6.1 Create API types (`lib/types/api.ts`)
- [x] 6.2 Create combined API route (`api.analytics.ts`)
- [x] 6.3 Create individual API routes (stats, timeseries, dimension)
## Phase 7: Verification
- [x] 7.1 TypeScript type checking passes
- [x] 7.2 Build succeeds
- [x] 7.3 Create walkthrough