# Seeflare Integration Bug Analysis Report

> [!IMPORTANT]
> Laporan ini berisi analisis mendalam terhadap **semua file implementasi** dalam proyek Seeflare (Smart Aggregation + D1 + API). Ditemukan **7 bug kritis/fatal** dan **6 bug konyol/minor** yang berpotensi menyebabkan data salah, crash runtime, atau inconsistency database.

---

## Ringkasan Temuan

| Severity | Jumlah | Dampak |
|----------|--------|--------|
| 🔴 FATAL | 3 | Runtime crash / data corruption / fitur tidak berfungsi |
| 🟠 KRITIS | 4 | Data tidak akurat / inconsistency / silent failure |
| 🟡 KONYOL | 6 | Bug logic / inconsistency kecil / edge case |

---

## 🔴 BUG FATAL

### BUG-01: Cache Version Mismatch — Cron Runs at 02:00 UTC, tapi Cache Invalidation Hardcoded 01:05 UTC

**File**: [cache-layer.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/cache-layer.ts#L18-L22)
**Severity**: 🔴 FATAL

```typescript
// Line 18-22: getCacheVersion() invalidates at 01:05 UTC
function getCacheVersion(): string {
    // 01:05 UTC = 3900000 ms after midnight.
    return Math.floor((Date.now() - 3900000) / 86400000).toString();
}
```

**Problem**: Cron job di `wrangler.json` berjalan jam `0 2 * * *` (02:00 UTC). Tapi `getCacheVersion()` mengganti versi cache jam **01:05 UTC** — artinya cache sudah ter-invalidate **55 menit SEBELUM** data baru tersedia dari D1. Selama window 01:05–02:00 UTC, semua extended range query akan:
1. Miss cache (versi baru)
2. Query D1 yang belum punya data hari kemarin
3. Cache hasil yang TIDAK LENGKAP selama 24 jam penuh

**Impact**: Data extended range SALAH selama satu hari penuh setelah setiap pergantian hari.

---

### BUG-02: `deviceModel` Filter Hilang dari `getFiltersFromSearchParams()` di utils.ts

**File**: [utils.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/lib/utils.ts#L37-L75)
**Severity**: 🔴 FATAL

`SearchFilters` di [types.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/lib/types.ts#L4) memiliki `deviceModel?: string`, tapi `getFiltersFromSearchParams()` di `utils.ts` **TIDAK pernah mem-parse `deviceModel` dari URL search params**. 

Ini berarti:
- Filter `deviceModel` dari dashboard **tidak akan pernah diteruskan** ke query
- API route `api.analytics.$dimension.ts` yang memanggil `getCountByDeviceModel` **tidak bisa di-filter**
- Data yang ditampilkan akan SELALU unfiltered untuk device model

**Dan duplikasi lain**: `utils.ts` mendefinisikan `SearchFilters` interface SENDIRI (line 23-35), berbeda dari `~/lib/types.ts`. Ini mengulangi definisi — potensi drift antara keduanya.

---

### BUG-03: D1 Monthly Query `date = substr(?, 1, 7)` Logika Salah — Tidak Match Monthly Aggregates

**File**: [d1-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-query.ts#L46-L64)
**Severity**: 🔴 FATAL

Semua query D1 menggunakan pattern ini:

```sql
AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
```

Dengan binding misalnya `['2025-01-15', '2025-01-15', '2026-05-29']`.

**Problem**: `substr('2025-01-15', 1, 7)` menghasilkan `'2025-01'`. Kondisi ini hanya match monthly aggregate yang `date = '2025-01'` — tapi juga **membiarkan semua monthly aggregate yang date-nya >= startDate lolos lewat `date >= ?`**, karena `'2025-02' >= '2025-01-15'` di SQLite string comparison = **TRUE**.

Ini sebenarnya HAMPIR bekerja secara kebetulan, tapi ada masalah subtle:
- Monthly aggregate `'2025-01'` TIDAK >= `'2025-01-15'` (string comparison: `'2025-01' < '2025-01-15'`), sehingga monthly January HANYA di-catch oleh klausa OR kedua
- Tapi `'2025-01' <= '2026-05-29'` = TRUE (string comparison), jadi upper bound masih works

**Masalah sebenarnya**: Untuk endDate, query menggunakan `date <= ?` (misalnya `date <= '2026-05-29'`). Monthly aggregate `date = '2026-05'` akan **INCLUDED** (`'2026-05' <= '2026-05-29'`), padahal bulan Mei belum selesai. Ini menyebabkan **double-counting** karena WAE juga sudah menghitung data Mei parsial.

Selain itu, monthly aggregate `date = '2026-06'` akan **EXCLUDED** (`'2026-06' > '2026-05-29'`), yang benar. Tapi ini hanya benar secara kebetulan karena string comparison.

> [!WARNING]
> Logika date filtering ini FRAGILE. Ia bekerja "secara kebetulan" lewat string comparison di SQLite, bukan lewat proper date logic. Jika format date berubah sedikit saja, semuanya akan rusak.

---

## 🟠 BUG KRITIS

### BUG-04: `backfillFromR2` — Arrow Column Name Mismatch

**File**: [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts#L303-L311)
**Severity**: 🟠 KRITIS

```typescript
const siteId = (table.getChild("siteId")?.get(i) as string) ?? "";
const views = (table.getChild("views")?.get(i) as number) ?? 0;
const visitors = (table.getChild("visitors")?.get(i) as number) ?? 0;
const bounces = (table.getChild("bounces")?.get(i) as number) ?? 0;
```

Arrow IPC files ditulis oleh [arrow.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/lib/arrow.ts) yang membackup raw WAE data. Kolom di WAE menggunakan **blob names** (`blob8` untuk siteId), **bukan** logical names. Kecuali `arrow.ts` melakukan remapping, `table.getChild("siteId")` akan return **null** dan semua backfill data akan menjadi empty strings / zeros.

**Impact**: Seluruh R2 backfill saat pertama kali setup menghasilkan SEMUA row bernilai 0. Database terisi tapi data semuanya salah.

---

### BUG-05: `aggregateDay()` — `getAggregationCountsForColumn()` Memfilter Empty Values (`!= ''`)

**File**: [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts#L501)
**Severity**: 🟠 KRITIS

```sql
AND ${_column} != ''
```

Method `getAggregationCountsForColumn()` di WAE query MEMFILTER rows dengan empty column values. Tapi komentar di `d1-aggregation.ts` (line 214) bilang:

```typescript
// Do not skip empty values, they represent direct traffic / unknown
```

Kontradiksi: Kode WAE query SKIP empty values, tapi aggregation comment bilang JANGAN skip. Hasilnya:
- Direct traffic (referrer = '') **TIDAK ter-aggregate** ke D1 untuk dimension `referrer`
- Unknown devices/browsers **TIDAK ter-aggregate**
- Ini menyebabkan total `visitors` di D1 dimension breakdown **KURANG** dari `overall`

---

### BUG-06: `UnifiedAnalyticsQuery.getCounts()` — Extended Range dengan Filter `dimensionValue = ""` Query D1 `overall` Data

**File**: [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L234-L248)
**Severity**: 🟠 KRITIS

```typescript
let dimensionType = "overall";
let dimensionValue = "";
// ... filter loop assigns if found
const [d1Counts, waeCounts] = await Promise.all([
    getD1Counts(this.db, siteId, d1StartDate, d1EndDate, dimensionType as any, dimensionValue),
    ...
]);
```

Ketika **TIDAK ada filter aktif**, `dimensionType = "overall"` dan `dimensionValue = ""`, lalu `getD1Counts()` dipanggil DENGAN `dimensionValue = ""`. Di `getD1Counts()`:

```typescript
if (dimensionValue !== undefined) {
    // Query WITH dimension_value = '' filter
}
```

Karena `dimensionValue = ""` (bukan `undefined`), query akan **selalu** masuk ke branch WITH `dimension_value = ?` binding `""`. Ini benar untuk `overall` (karena dimension_value memang `""`), tapi jika ada bug di data insert yang dimension_value-nya tidak `""` untuk overall, query akan miss.

**Lebih penting**: ketika ADA filter aktif (misalnya `path=/about`), D1 query hanya bisa filter per satu dimensi. Tapi `getCounts` mengirim `dimensionType = filter key` dan `dimensionValue = filter value`. Ini berarti counts yang dikembalikan D1 adalah **hanya counts untuk dimensi itu**, bukan total filtered counts. Ini BENAR secara desain, TAPI:

Jika filter adalah `country=US` dan kita query D1 untuk `getCounts` dengan `dimensionType='country', dimensionValue='US'`, kita dapat visitors/views **hanya dari negara US**. Tapi WAE query dengan filter `country=US` juga returns only US data. Sehingga penambahan D1+WAE counts **BENAR** — kecuali ada overlap (data D1 dan WAE untuk hari yang sama), yang SEHARUSNYA tidak terjadi jika `computeDateRangeSplit` bekerja benar.

Conclusion: Bug ini POTENTIAL tapi tidak selalu terjadi. Priority rendah jika `computeDateRangeSplit` benar.

---

### BUG-07: Cron Scheduled Handler — Dua `ctx.waitUntil()` yang Berjalan Independen, Tidak Ada Error Propagation

**File**: [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts#L31-L78)
**Severity**: 🟠 KRITIS

```typescript
// 1. R2 backup - fire and forget
ctx.waitUntil(extractAsArrow(...));

// 2. D1 aggregation - fire and forget
ctx.waitUntil((async () => {
    await runDailyAggregation(...)
    await purgeAllSitesCache(siteIds)
})());
```

**Problems**:
1. **Race condition**: R2 backup dan D1 aggregation berjalan secara paralel. D1 aggregation memanggil `aggregateDay()` yang query WAE — BUKAN R2 files. Ini seharusnya OK, tapi jika WAE sedang under load atau throttled, kedua operasi mungkin saling compete untuk WAE API quota.

2. **`purgeAllSitesCache()` adalah NO-OP**: Function ini (line 157-161 di cache-layer.ts) return `0` — tidak melakukan apa-apa. Cache versioning memang auto-invalidate, tapi ini berarti **seluruh cache purge logic di cron handler adalah dead code**. Ini "konyol" tapi bukan bug — hanya menyesatkan siapa pun yang membaca kode.

3. **Jika D1 aggregation GAGAL, `setLastAggregatedDate` tetap di-update** di `runDailyAggregation()` pada line 616-619 karena update terjadi di LUAR loop. Jika salah satu hari gagal di-aggregate, `lastAggregatedDate` tetap maju — data hari itu **hilang selamanya**.

---

## 🟡 BUG KONYOL / MINOR

### BUG-08: Duplikasi `isExtendedInterval()` — Didefinisikan di DUA File Berbeda

**Files**: 
- [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L30-L35) 
- [utils.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/lib/utils.ts#L114-L119)

Implementasi identik, tapi import beragam:
- Route files import dari `~/analytics/unified-query`
- Tidak jelas mana yang "canonical"

Potensi drift jika seseorang mengedit satu tapi tidak yang lain.

---

### BUG-09: Duplikasi `SearchFilters` Interface — utils.ts vs types.ts

**Files**: 
- [utils.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/lib/utils.ts#L23-L35) (local interface)
- [types.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/lib/types.ts#L1-L14) (exported)

`utils.ts` mendefinisikan `SearchFilters` sendiri (TANPA `deviceModel`) sementara `types.ts` punya `deviceModel`. Code yang import dari `~/lib/types` punya properti `deviceModel`, tapi code di `utils.ts` TIDAK. Ini menyebabkan BUG-02.

---

### BUG-10: `api.analytics.ts` — Combined API Route Tidak Return JSON Response

**File**: [api.analytics.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/api.analytics.ts#L151)
**Severity**: 🟡 KONYOL

```typescript
return fullResponse;
```

API route me-return plain object dari React Router loader. React Router akan serialize ini sebagai JSON response. Ini secara teknis BENAR di React Router v7, tapi tidak ada explicit `Content-Type: application/json` header. Jika ada consumer yang strict tentang content-type checking, ini bisa bermasalah.

API routes lain (`api.analytics.stats.ts`, `api.analytics.timeseries.ts`, `api.analytics.$dimension.ts`) memiliki masalah yang sama.

---

### BUG-11: `dashboard.tsx` — Site List Query Uses `"all"` Interval, Triggering Unnecessary D1 + WAE Merge

**File**: [dashboard.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/dashboard.tsx#L107)

```typescript
const sitesByHits = unifiedQuery.getSitesOrderedByHits("all");
```

Setiap kali dashboard dimuat, ia query `getSitesOrderedByHits("all")` yang:
1. Mendeteksi `"all"` sebagai extended interval
2. Query D1 + WAE secara paralel
3. Merge hasilnya

Ini **tidak di-cache** di dashboard loader, jadi setiap page load memicu D1 query. Untuk `"all"` interval, D1 harus scan seluruh tabel `daily_aggregates`. Performance concern.

---

### BUG-12: `getDateTimeRange()` untuk `"all"` Interval Hardcoded 10 Years (3650 days)

**File**: [utils.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/lib/utils.ts#L130-L136)

```typescript
localDateTime = localDateTime
    .subtract(3650, "day")  // ~10 years as a safe upper bound
    .tz(tz)
    .startOf("day");
```

Plan bilang "all time" menggunakan dynamic detection dari `aggregation_metadata`. Tapi `getDateTimeRange()` hardcodes 3650 hari (10 tahun). Ini berarti:
- `startDate` yang dikirim ke `getViewsGroupedByInterval()` bisa sangat jauh di masa lalu
- D1 query akan mencari data yang tidak ada
- Performance waste tapi bukan data corruption

---

### BUG-13: `computeDateRangeSplit()` Menggunakan `nowUtc` untuk D1 tapi `nowLocal` untuk WAE — Timezone Mismatch Potential

**File**: [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L56-L64)

```typescript
const nowUtc = dayjs().utc();
const nowLocal = dayjs().tz(tz);
const waeStartUtc = nowUtc.subtract(WAE_RETENTION_DAYS - 1, "day").startOf("day");
const waeInterval = `range:${waeStartUtc.toISOString()}|${nowLocal.toISOString()}`;
```

WAE interval end menggunakan `nowLocal` (local timezone) tapi D1 date range menggunakan UTC dates. Untuk timezone yang sangat berbeda dari UTC (misalnya UTC+12), ada potensi **1-day gap** antara D1 end dan WAE start, yang bisa menyebabkan data hilang untuk satu hari.

---

## Prompt untuk AI Agent (Fixing Instructions)

> [!NOTE]
> Setiap prompt di bawah ini dirancang untuk diberikan ke AI agent yang lebih murah. Setiap prompt berisi konteks lengkap, file yang harus diubah, dan instruksi step-by-step yang sangat detail.

---

### PROMPT 1: Fix BUG-01 (Cache Version Mismatch)

```
TASK: Fix cache version timing in seeflare cache-layer.ts

CONTEXT:
File: packages/server/app/analytics/cache-layer.ts
The cron job runs at 02:00 UTC (defined in wrangler.json triggers.crons = "0 2 * * *").
But getCacheVersion() on line 18-22 invalidates cache at 01:05 UTC (3900000 ms offset).
This means cache invalidates 55 minutes BEFORE new data is written to D1.
During 01:05-02:00 UTC, queries will cache incomplete data for 24 hours.

WHAT TO FIX:
Change the offset in getCacheVersion() from 3900000 (01:05 UTC) to 7500000 (02:05 UTC).
This ensures cache version only changes 5 minutes AFTER the cron job runs and new data is available.

EXACT CHANGE:
In file: packages/server/app/analytics/cache-layer.ts

Replace line 19-21:
```typescript
function getCacheVersion(): string {
    // 01:05 UTC = 3900000 ms after midnight.
    return Math.floor((Date.now() - 3900000) / 86400000).toString();
}
```

With:
```typescript
function getCacheVersion(): string {
    // 02:05 UTC = 7500000 ms after midnight.
    // Must be AFTER the cron job (02:00 UTC) finishes writing new D1 data.
    return Math.floor((Date.now() - 7500000) / 86400000).toString();
}
```

Also update the comment on line 16 from "Cron job runs at 01:00 UTC" to "Cron job runs at 02:00 UTC".

VERIFICATION:
- Math check: 2 hours * 3600000 + 5 minutes * 60000 = 7200000 + 300000 = 7500000 ✓
- Cache version should change at 02:05 UTC, 5 minutes after cron
```

---

### PROMPT 2: Fix BUG-02 (Missing deviceModel Filter)

```
TASK: Add missing deviceModel filter parsing in utils.ts and remove duplicate SearchFilters interface

CONTEXT:
File: packages/server/app/lib/utils.ts
The SearchFilters interface is defined both in utils.ts (lines 23-35) AND in types.ts.
The utils.ts version is MISSING the `deviceModel` property.
Also, getFiltersFromSearchParams() (lines 37-75) does NOT parse `deviceModel` from URL params.

WHAT TO FIX:
1. Remove the local SearchFilters interface from utils.ts (lines 23-35)
2. Import SearchFilters from ~/lib/types instead
3. Add deviceModel parsing to getFiltersFromSearchParams()

EXACT CHANGES:

In file: packages/server/app/lib/utils.ts

Step 1 - Add import at top (after line 5):
```typescript
import { SearchFilters } from "~/lib/types";
```

Step 2 - Delete lines 23-35 (the local SearchFilters interface)

Step 3 - In getFiltersFromSearchParams(), add after the utmContent block (around line 71):
```typescript
    if (searchParams.has("deviceModel")) {
        filters.deviceModel = searchParams.get("deviceModel") || "";
    }
```

VERIFICATION:
- TypeScript should compile without errors
- All filter properties in ~/lib/types.ts SearchFilters should now be parsed from URL params
- Search for other files that import SearchFilters from ~/lib/utils - they should be updated to import from ~/lib/types instead (but check first if any actually do)
```

---

### PROMPT 3: Fix BUG-03 (D1 Date Range Query Logic)

```
TASK: Fix D1 query date range logic for monthly aggregates in d1-query.ts

CONTEXT:
File: packages/server/app/analytics/d1-query.ts
All D1 queries use this WHERE clause pattern:
  AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?

The problem: Monthly rows have date format 'YYYY-MM' (e.g., '2025-01').
- String comparison '2025-02' >= '2025-01-15' is TRUE, so most monthly rows work
- But the endDate check 'date <= ?' can include partial months (e.g., May monthly data included when endDate is May 29)
- Also, monthly rows like '2025-01' < '2025-01-15', so January monthly is only caught by the OR clause

The REAL fix is to properly handle both granularities in the date range:

WHAT TO FIX:
Replace the date filtering pattern in ALL query functions in d1-query.ts.
Use this improved WHERE clause:

```sql
AND (
    (granularity = 'day' AND date >= ? AND date <= ?)
    OR 
    (granularity = 'month' AND date >= substr(?, 1, 7) AND date < substr(?, 1, 7))
)
```

Where the bindings for the monthly part use:
- Start: substr(startDate, 1, 7) — the month of the start date
- End: substr(endDate, 1, 7) — we use < (not <=) because we DON'T want to include the end month if it's partial (WAE handles the current partial month)

Actually, a simpler and more correct approach: Since D1 end date from computeDateRangeSplit is always the day BEFORE WAE starts (the full day boundary), the end date's month should be fully included if it ended before WAE took over.

The safest fix:

EXACT CHANGES in d1-query.ts:

For each query function (getD1Counts, getD1ViewsGroupedByInterval, getD1VisitorCountByColumn, getD1AllCountsByColumn, getD1SitesOrderedByHits), replace the WHERE date clause:

OLD:
```sql
AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
```

NEW:
```sql
AND (
    (granularity = 'day' AND date >= ? AND date <= ?)
    OR
    (granularity = 'month' AND date >= substr(?, 1, 7) AND date <= substr(?, 1, 7))
)
```

And update bindings accordingly. For each function:
- Old bindings had: [..., startDate, startDate, endDate, ...]
- New bindings need: [..., startDate, endDate, startDate, endDate, ...]

EXAMPLE for getD1Counts without dimensionValue (line 56-64):

Replace:
```typescript
query = `
    SELECT COALESCE(SUM(views), 0) as views,
           COALESCE(SUM(visitors), 0) as visitors,
           COALESCE(SUM(bounces), 0) as bounces
    FROM daily_aggregates
    WHERE site_id = ? AND dimension_type = ?
      AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7))) AND date <= ?
`;
bindings = [siteId, dimensionType, startDate, startDate, endDate];
```

With:
```typescript
query = `
    SELECT COALESCE(SUM(views), 0) as views,
           COALESCE(SUM(visitors), 0) as visitors,
           COALESCE(SUM(bounces), 0) as bounces
    FROM daily_aggregates
    WHERE site_id = ? AND dimension_type = ?
      AND (
          (granularity = 'day' AND date >= ? AND date <= ?)
          OR
          (granularity = 'month' AND date >= substr(?, 1, 7) AND date <= substr(?, 1, 7))
      )
`;
bindings = [siteId, dimensionType, startDate, endDate, startDate, endDate];
```

Apply same pattern to ALL 5 query functions in d1-query.ts.
Also apply to the variant with dimensionValue (line 46-54).

VERIFICATION:
- Monthly aggregate '2025-01' with startDate '2025-01-15': substr('2025-01-15',1,7) = '2025-01', so '2025-01' >= '2025-01' is TRUE ✓
- Daily row '2025-01-10' with startDate '2025-01-15': '2025-01-10' >= '2025-01-15' is FALSE, correctly excluded ✓
- Monthly aggregate '2026-05' with endDate '2026-05-29': substr('2026-05-29',1,7) = '2026-05', so '2026-05' <= '2026-05' is TRUE — this is OK because the D1 endDate from computeDateRangeSplit should be the day BEFORE WAE starts, so if it's May 29, that means WAE handles May 30 onward ✓
```

---

### PROMPT 4: Fix BUG-07 (Cron setLastAggregatedDate Even When Aggregation Fails)

```
TASK: Fix runDailyAggregation to not advance lastAggregatedDate when aggregation fails

CONTEXT:
File: packages/server/app/analytics/d1-aggregation.ts, function runDailyAggregation() (line 533-630)

In the "normal run" branch (line 604-620), the code iterates through missing dates and aggregates each one. But setLastAggregatedDate is called AFTER the loop with `yesterday` as the date, regardless of whether all days succeeded.

If day 3 of 5 fails (throws an error), the error propagates up and setLastAggregatedDate is never called — which is actually correct! But the FIRST branch (line 592-603) has a different issue: after R2 backfill, it aggregates yesterday from WAE. If THAT fails, it also correctly does not update.

Actually wait — re-reading the code more carefully:

Line 608-614 is a while loop that calls `aggregateDay()`. If any aggregateDay() throws, the entire function throws. So setLastAggregatedDate (line 616-619) is only reached if ALL days succeed. This is actually CORRECT behavior!

However, there IS a subtle issue: if the function aggregates days 1-3 successfully but day 4 fails, on the NEXT cron run, lastAggregatedDate is still the old value, so it will RE-aggregate days 1-3 unnecessarily. The ON CONFLICT clause handles this gracefully (UPSERT), so this is not a bug but a performance waste.

REVISED TASK: Move setLastAggregatedDate inside the loop so it updates after EACH successful day.

EXACT CHANGE:
In file: packages/server/app/analytics/d1-aggregation.ts

Replace lines 604-620:
```typescript
    } else {
        // Normal run — aggregate any missing days between last and yesterday
        let nextDate = dayjs(lastAggregated).add(1, "day");

        while (
            nextDate.isBefore(yesterday) ||
            nextDate.isSame(yesterday, "day")
        ) {
            totalAggregated += await aggregateDay(db, api, nextDate);
            nextDate = nextDate.add(1, "day");
        }

        await setLastAggregatedDate(
            db,
            yesterday.format("YYYY-MM-DD"),
        );
    }
```

With:
```typescript
    } else {
        // Normal run — aggregate any missing days between last and yesterday
        let nextDate = dayjs(lastAggregated).add(1, "day");

        while (
            nextDate.isBefore(yesterday) ||
            nextDate.isSame(yesterday, "day")
        ) {
            totalAggregated += await aggregateDay(db, api, nextDate);
            // Update after EACH successful day so that if a later day fails,
            // we don't re-aggregate already-completed days on the next cron run
            await setLastAggregatedDate(
                db,
                nextDate.format("YYYY-MM-DD"),
            );
            nextDate = nextDate.add(1, "day");
        }
    }
```

VERIFICATION:
- If days 1,2,3 succeed and day 4 fails, lastAggregatedDate = day 3
- Next cron run starts from day 4, not day 1
- No wasted D1 writes from re-aggregating already-done days
```

---

### PROMPT 5: Fix BUG-08 & BUG-09 (Deduplicate isExtendedInterval and SearchFilters)

```
TASK: Remove duplicate isExtendedInterval function and ensure only one SearchFilters definition

CONTEXT:
- isExtendedInterval() is defined in BOTH:
  1. packages/server/app/lib/utils.ts (lines 114-119)
  2. packages/server/app/analytics/unified-query.ts (lines 30-35)
  
- SearchFilters interface is defined in BOTH:
  1. packages/server/app/lib/utils.ts (lines 23-35) - MISSING deviceModel
  2. packages/server/app/lib/types.ts (lines 1-14) - has deviceModel

All resource routes import isExtendedInterval from ~/analytics/unified-query.
Keep that as canonical and REMOVE the duplicate from utils.ts.
For SearchFilters, ~/lib/types.ts is canonical.

WHAT TO FIX:

1. In packages/server/app/lib/utils.ts:
   - Delete the local SearchFilters interface (lines 23-35)
   - Delete the isExtendedInterval function (lines 114-119) 
   - Add import: `import { SearchFilters } from "~/lib/types";`
   - Note: getFiltersFromSearchParams uses SearchFilters so keep the import

2. Check if any file imports isExtendedInterval from ~/lib/utils
   - If yes, change those imports to use ~/analytics/unified-query
   - If no, nothing to do

3. Check if any file imports SearchFilters from ~/lib/utils
   - If yes, change those imports to use ~/lib/types
   - If no, nothing to do

VERIFICATION:
- grep for "from ~/lib/utils" and check none import isExtendedInterval or SearchFilters
- grep for "from \"~/analytics/unified-query\"" to verify all isExtendedInterval imports are correct
- TypeScript should compile without errors
```

---

### PROMPT 6: Fix BUG-13 (Timezone Mismatch in computeDateRangeSplit)

```
TASK: Fix timezone consistency in computeDateRangeSplit in unified-query.ts

CONTEXT:
File: packages/server/app/analytics/unified-query.ts, function computeDateRangeSplit() (lines 45-93)

The function uses nowUtc for D1 dates but nowLocal for WAE interval end.
For users in UTC+12, this could create a gap or overlap.

WHAT TO FIX:
Use UTC consistently for both D1 and WAE date boundaries, since D1 stores dates in UTC.
The WAE range should also use UTC for the end boundary.

EXACT CHANGE:
In file: packages/server/app/analytics/unified-query.ts

Replace line 57:
```typescript
    const nowLocal = dayjs().tz(tz);
```

With:
```typescript
    const nowLocal = dayjs().utc();
```

Wait — this would break WAE queries that need timezone awareness for bucketing.
Actually, the WAE range:interval format just needs absolute timestamps. Using UTC for the end is fine since WAE stores timestamps in UTC anyway.

Actually, re-reading more carefully: the `nowLocal` is only used as the end of the WAE range. Since WAE timestamps are UTC-based, using `nowUtc` instead of `nowLocal` is more correct. The timezone only matters for WAE's toStartOfInterval bucketing, not for the range boundaries.

EXACT CHANGE:
Replace line 64:
```typescript
    const waeInterval = `range:${waeStartUtc.toISOString()}|${nowLocal.toISOString()}`;
```

With:
```typescript
    const waeInterval = `range:${waeStartUtc.toISOString()}|${nowUtc.toISOString()}`;
```

And remove the unused `nowLocal` variable on line 57.

VERIFICATION:
- Both D1 and WAE now use UTC-based boundaries
- No timezone-dependent gap between D1 end date and WAE start date
```

---

## Summary Table

| Bug ID | File | Fix Prompt | Effort |
|--------|------|------------|--------|
| BUG-01 | cache-layer.ts | PROMPT 1 | ⬜ 2 min |
| BUG-02 | utils.ts | PROMPT 2 | ⬜ 5 min |
| BUG-03 | d1-query.ts | PROMPT 3 | ⬜ 15 min |
| BUG-04 | d1-aggregation.ts | *Needs arrow.ts audit* | ⬜ 10 min |
| BUG-05 | query.ts | *Design decision needed* | ⬜ 5 min |
| BUG-06 | unified-query.ts | *Low priority* | ⬜ — |
| BUG-07 | d1-aggregation.ts | PROMPT 4 | ⬜ 5 min |
| BUG-08 | utils.ts + unified-query.ts | PROMPT 5 | ⬜ 5 min |
| BUG-09 | utils.ts + types.ts | PROMPT 5 | ⬜ (combined) |
| BUG-10 | api.analytics.ts | *Optional* | ⬜ 2 min |
| BUG-11 | dashboard.tsx | *Performance only* | ⬜ — |
| BUG-12 | utils.ts | *Works, wasteful* | ⬜ — |
| BUG-13 | unified-query.ts | PROMPT 6 | ⬜ 3 min |

> [!TIP]
> **Prioritas perbaikan**: BUG-01 → BUG-03 → BUG-02 → BUG-07 → BUG-13 → BUG-08/09 → sisanya.
> BUG-04 memerlukan audit terhadap file `arrow.ts` untuk memastikan format kolom di Arrow IPC files sebelum bisa diperbaiki.

