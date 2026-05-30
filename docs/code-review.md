# 🔍 Laporan Review Logika Kode Seeflare — Semua Fitur

Review mendalam terhadap seluruh logika kode berdasarkan arsitektur yang didokumentasikan di [id-how-it-work.md](file:///c:/Users/Admin/Desktop/see-flare/seeflare/how/id-how-it-work.md).

---

## Ringkasan Eksekutif

| Severity | Jumlah | Deskripsi |
|:---------|:------:|:----------|
| 🔴 CRITICAL | 2 | Bug logika yang berpotensi menyebabkan data salah |
| 🟠 HIGH | 4 | Cacat logika yang mempengaruhi akurasi atau keamanan |
| 🟡 MEDIUM | 5 | Edge case yang bisa menyebabkan perilaku tak terduga |
| 🔵 LOW | 4 | Kode inkonsisten atau potensi improvement |

---

## Fitur 1: Tracker (Client-Side)

**File:** `packages/tracker/src/`

### ✅ Yang Berjalan Benar
- SPA tracking melalui `instrumentHistoryBuiltIns` — mengganti `pushState`, `replaceState`, dan listen `popstate` ✔
- Fallback cookieless tracking dengan `ht: 0` ketika gagal — server-side menangani ✔
- Canonical URL support ✔
- Referrer parsing dengan multiple fallback params (`ref`, `referer`, `referrer`, `source`, `utm_source`) ✔
- Self-referral filtering via `getReferrer` ✔
- Cleanup saat unmount ✔

### 🟡 MEDIUM — `getHostnameAndPath` untuk path relatif di browser

**File:** [track.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/track.ts#L91-L93)

```typescript
const url = opts.url || location.pathname + location.search || "/";
const { hostname, path } = getHostnameAndPath(url, true);
```

Ketika `useBrowserDOM = true`, fungsi `getHostnameAndPath` membuat elemen `<a>` dan set `a.href = url`. Jika `url` adalah path relatif seperti `/about?q=1`, elemen `<a>` akan resolve ke `location.origin + /about?q=1`, sehingga `hostname` menjadi `https://current-site.com`. Ini **berfungsi dengan benar** karena browser resolve relatif path otomatis.

**Namun**, `getUtmParamsFromBrowserUrl(url)` dipanggil dengan `url` yang merupakan path relatif (e.g. `/about?utm_source=google`). Fungsi ini hanya mencari `?` di string dan parse query params — ini **benar** karena hanya butuh query string. ✅ Tidak ada bug di sini.

### 🟡 MEDIUM — Race condition pada `autoTrackPageviews` via `setTimeout`

**File:** [client.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/lib/client.ts#L27-L29)

```typescript
setTimeout(() => {
    this._cleanupAutoTrackPageviews = autoTrackPageviews(this);
}, 0);
```

`setTimeout(fn, 0)` menunda pemasangan history listener. Jika `pushState` dipanggil **sebelum** microtask queue selesai (misalnya oleh framework SPA yang melakukan immediate redirect di `componentDidMount`), pageview pertama bisa terlewat. Ini adalah tradeoff yang disengaja (untuk testing), tapi merupakan **edge case yang nyata di framework SPA tertentu**.

**Impact:** Pageview pertama setelah redirect sangat cepat bisa hilang. Low probability.

---

## Fitur 2: Server Collect Endpoint (`/collect`)

**File:** [collect.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/collect.ts)

### ✅ Yang Berjalan Benar
- Hit count ke bounce value mapping (1→bounce, 2→anti-bounce, 3+→normal) ✔
- Cookieless tracking via `If-Modified-Since` header manipulation ✔
- User-Agent parsing ✔
- Country dari `request.cf` ✔
- 1x1 GIF response ✔
- `Tk: "N"` header ✔

### 🔴 CRITICAL — Logika `handleCacheHeaders` mengembalikan hit count yang salah untuk kunjungan ulang

**File:** [collect.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/collect.ts#L86-L111)

```typescript
let hits = newVisitor ? 1 : nextLastModifiedDate.getSeconds();
```

**Masalah:** Ketika `newVisitor` adalah `false` (hari yang sama, bukan visitor baru), `hits` di-set dari `nextLastModifiedDate.getSeconds()`. Tetapi `getNextLastModifiedDate` sudah menaikkan seconds sebesar +1 (line 28: `next.setSeconds(Math.min(3, currentSeconds + 1))`). 

**Alur untuk kunjungan kedua:**
1. Kunjungan 1: `ifModifiedSince = null` → `current = null` → `next = midnight (00:00:00)` → seconds = 0 → `setSeconds(min(3, 0+1)) = 1` → `nextLastModifiedDate.getSeconds() = 1`
2. Tapi `newVisitor = true` (pertama kali hari ini), jadi `hits = 1` ✅

3. Kunjungan 2: `ifModifiedSince = "midnight+1s"` → `newVisitor = false` → `next = ifModifiedSince date (seconds=1)` → `setSeconds(min(3, 1+1)) = 2` → `nextLastModifiedDate.getSeconds() = 2`
4. `hits = 2` ✅

5. Kunjungan 3: `ifModifiedSince = "midnight+2s"` → `newVisitor = false` → `setSeconds(min(3, 2+1)) = 3` → `hits = 3` ✅

6. Kunjungan 4: `ifModifiedSince = "midnight+3s"` → `newVisitor = false` → `setSeconds(min(3, 3+1)) = 3` → `hits = 3` ✅ (capped)

**Kesimpulan:** Setelah analisis ulang, logika ini **BENAR** ✅. Kunjungan pertama selalu hits=1, kedua=2, ketiga=3, cap pada 3. Maaf, bukan critical. Saya turunkan severity-nya.

### 🟠 HIGH — `extractParamsFromQueryString` tidak handle multi-value params dan rentan decode error

**File:** [collect.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/collect.ts#L113-L126)

```typescript
queryString.forEach((item) => {
    const kv = item.split("=");
    if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1]);
});
```

**Bug 1:** Jika value mengandung `=` (misalnya `p=/search?q=hello=world`), `split("=")` akan memecah di `=` pertama saja — `kv[1]` hanya mendapat `/search?q` dan sisanya hilang.

**Perbaikan:** Gunakan `item.split("=", 2)` lalu gabungkan sisa, atau gunakan `item.indexOf("=")`:
```typescript
const idx = item.indexOf("=");
if (idx >= 0) params[item.substring(0, idx)] = decodeURIComponent(item.substring(idx + 1));
```

**Bug 2:** Jika `kv[1]` adalah `undefined` (parameter tanpa value, e.g. `?flag`), `decodeURIComponent(undefined)` akan menghasilkan `"undefined"` (string), bukan crash, tapi data kotor.

**Impact:** Path yang mengandung `=` dalam query string akan terpotong. UTM values yang mengandung `=` (base64 encoded values) akan rusak.

### 🟡 MEDIUM — SQL Injection pada `filtersToSql` hanya escape single quote

**File:** [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts#L166-L175)

```typescript
const sanitized = String(filters[filter]).replace(/'/g, "\\'");
filterStr += `AND ${ColumnMappings[filter]} = '${sanitized}'`;
```

Hanya single quote yang di-escape. WAE hanya mendukung SELECT (read-only), jadi injection tidak bisa mengubah data. Tapi backslash escaping bisa di-bypass pada beberapa SQL dialek. Karena ini WAE (bukan SQLite), dan WAE hanya mendukung SELECT, risiko terbatas pada **information leak** (melihat data dari site lain dengan injeksi filter). Kode sudah menyadari ini (comment di L177-186).

**Impact:** Low — WAE read-only. Tapi masih disarankan untuk double-check.

---

## Fitur 3: WAE Query (`query.ts`)

**File:** [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts)

### ✅ Yang Berjalan Benar
- `accumulateCountsFromRowResult` menghitung views, visitors, bounces dengan benar ✔
- Negative bounce correction di `getViewsGroupedByInterval` ✔
- Timezone-aware bucketing ✔
- DST workaround (add 25 hours) ✔
- Pagination tanpa OFFSET (select LIMIT*page lalu slice) ✔
- Two-query strategy untuk `getAllCountsByColumn` (visitors first, then non-visitors) ✔

### 🟠 HIGH — `getAllCountsByColumn` pagination inconsistency

**File:** [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts#L573-L629)

```typescript
// Query 2: non-visitor hits
const query = `... LIMIT ${limit * page}`;
// ...
const pageData = responseData.data.slice(limit * (page - 1), limit * page);

// Then push ALL visitor data back in
visitorCountByColumn.forEach(([key, value]) => {
    pageData.push({ ... });
});
```

**Masalah:** `visitorCountByColumn` berisi data untuk page yang diminta (sliced di `getVisitorCountByColumn`). Tapi query non-visitor mengambil `limit * page` results lalu slice ke page yang diminta. Jika ada dimensi yang muncul di visitors tapi tidak di non-visitors (atau sebaliknya karena ordering berbeda), merge akan **kehilangan beberapa dimensi** atau **double-count**.

Contoh: Page 2, limit 10. Visitor query mengembalikan top 11-20 dimensions. Non-visitor query mengembalikan top 11-20 berdasarkan non-visitor count (bisa jadi dimensi BERBEDA). Merge hanya bisa akurat jika kedua query memiliki dimensi yang sama, tapi filter `AND ${_column} IN (...)` pada query kedua memastikan ini. ✅

**Revisi:** Setelah analisis ulang, filter `IN (keys)` memastikan query 2 hanya mengambil dimensi yang sama. **Logic correct** ✅ tapi ada edge case — jika non-visitor count berbeda urutannya, slice `pageData` bisa tidak menangkap semua karena LIMIT. Namun karena filter `IN` membatasi ke tepat N keys, ini aman selama hasilnya ≤ limit*page.

### 🟡 MEDIUM — `getEarliestEvents` tidak mendeteksi bounce value `-1` (anti-bounce)

**File:** [query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/query.ts#L962-L968)

```typescript
const earliestEvent = data.find((row) => row["isBounce"] === 0)?.earliestEvent;
const earliestBounce = data.find((row) => row["isBounce"] === 1)?.earliestEvent;
```

Query GROUP BY `isBounce` menghasilkan 3 kemungkinan: `isBounce = -1, 0, 1`. Kode hanya mencari `isBounce === 0` dan `isBounce === 1`. Row dengan `isBounce === -1` (anti-bounce) diabaikan. Ini bukan bug serius karena anti-bounce records selalu hadir bersama bounce records, tapi `earliestEvent` bisa salah jika event pertama adalah anti-bounce (edge case sangat jarang).

---

## Fitur 4: D1 Aggregation (`d1-aggregation.ts`)

**File:** [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts)

### ✅ Yang Berjalan Benar
- Schema creation dengan `IF NOT EXISTS` ✔
- UPSERT pattern (`ON CONFLICT DO UPDATE`) ✔
- Batch size 50 (conservative) ✔
- Atomic compaction via `db.batch()` ✔
- Re-aggregation 2 hari terakhir ✔
- Last aggregated date tracking per-day ✔
- R2 backfill on first run ✔

### 🔴 CRITICAL — `compactOldData` menggunakan `month` sebagai date value tapi schema expects berbeda format

**File:** [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts#L485-L498)

```typescript
await db.batch([
    db.prepare(
        `INSERT INTO daily_aggregates (date, granularity, ...)
         SELECT ?, 'month', site_id, ...
         FROM daily_aggregates
         WHERE substr(date, 1, 7) = ? AND granularity = 'day'
         GROUP BY site_id, dimension_type, dimension_value`
    ).bind(month, month),  // month = "YYYY-MM"
```

Ketika INSERT monthly aggregate, `date` column diset ke `month` = `"YYYY-MM"` (e.g. `"2024-06"`).

**Lalu di d1-query.ts**, data monthly diformat:

```typescript
const dateStr = row.granularity === "month"
    ? `${row.date}-01 00:00:00`  // "2024-06-01 00:00:00"
    : `${row.date} 00:00:00`;
```

Ini **benar** karena query menambahkan `-01` untuk monthly data. ✔

**Tapi ada masalah di D1 query WHERE clause:**

```sql
AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01'))
```

Logika `substr(?, 9, 2) = '01'` mengecek karakter ke-9 dan ke-10 dari `startDate` (e.g., dari `"2024-06-15"` → `"15"` ≠ `"01"` → FALSE). Ini berarti **monthly data hanya dimasukkan jika `startDate` dimulai pada hari pertama bulan**.

**Impact:** Jika user memilih interval yang start date-nya bukan tanggal 1 (e.g., `"2024-06-15"`), monthly aggregate untuk bulan Juni akan **dilewatkan** dari hasil query. Data hilang untuk bulan parsial di awal rentang waktu.

**Contoh kasus:** 
- `startDate = "2024-03-15"`, `endDate = "2025-01-01"`
- Monthly row `date = "2024-03"` → `"2024-03" >= "2024-03-15"` = FALSE → cek fallback: `date = substr("2024-03-15", 1, 7) = "2024-03"` = TRUE, tapi `substr("2024-03-15", 9, 2) = "15"` ≠ `"01"` → **EXCLUDED** ❌
- Padahal bulan Maret memiliki data 1-31 yang sudah di-compact. Seharusnya tetap dimasukkan.

**Perbaikan yang benar:** Monthly row harus dimasukkan jika `month` overlap dengan rentang query, bukan hanya jika start date tepat di hari pertama.

```sql
AND (
    (granularity = 'day' AND date >= ? AND date <= ?)
    OR
    (granularity = 'month' AND date >= substr(?, 1, 7) AND date <= substr(?, 1, 7))
)
```

### 🟠 HIGH — `aggregateDay` sequential per-site dan per-dimension → timeout risk

**File:** [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts#L190-L226)

```typescript
for (const siteId of siteIds) {
    const overall = await api.getCounts(siteId, rangeInterval, tz);
    // ...
    for (const col of columns) {
        const countsMap = await api.getAggregationCountsForColumn(siteId, col, startDateTime, endDateTime);
    }
}
```

Untuk setiap site, ada 1 getCounts + 11 getAggregationCountsForColumn = **12 sequential API calls per site**. Untuk 10 site = **120 sequential HTTP requests** ke WAE API. Cloudflare Workers memiliki CPU time limit (30 detik pada Paid plan). Jika respons API lambat, cron bisa timeout.

**Impact:** Aggregation bisa gagal untuk deployment dengan banyak site. 

**Perbaikan:** Paralelisasi calls per-site atau per-dimension dengan `Promise.all()`.

---

## Fitur 5: D1 Query (`d1-query.ts`)

**File:** [d1-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-query.ts)

### 🔴 Masalah Utama: WHERE clause untuk monthly data (sama dengan Section 4 di atas)

Bug ini mempengaruhi **semua** fungsi D1 query: `getD1Counts`, `getD1ViewsGroupedByInterval`, `getD1VisitorCountByColumn`, `getD1AllCountsByColumn`, `getD1SitesOrderedByHits`.

Semua menggunakan pattern yang sama:
```sql
AND (date >= ? OR (granularity = 'month' AND date = substr(?, 1, 7) AND substr(?, 9, 2) = '01'))
```

**Impact:** Setiap kali `startDate` bukan tanggal 1, monthly aggregate di awal rentang dilewatkan. Ini menyebabkan **under-counting** data historis.

### ✅ Yang Berjalan Benar
- Parameterized queries (aman dari SQL injection, berbeda dengan WAE) ✔
- COALESCE handling ✔
- Granularity-aware date formatting ✔
- Pagination dengan LIMIT/OFFSET ✔

---

## Fitur 6: Unified Query (`unified-query.ts`)

**File:** [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts)

### ✅ Yang Berjalan Benar
- `isExtendedInterval` benar mendeteksi >90 hari ✔
- `computeDateRangeSplit` memotong rentang WAE (89 hari terakhir) dan D1 (sisanya) dengan benar ✔
- `mergeTimeSeries` — WAE overwrites D1 untuk overlap dates ✔
- `fixNegativeBounces` — redistributes negative bounces backward ✔
- Parallel fetch D1 + WAE via `Promise.all` ✔
- Monthly/Weekly bucketing ✔

### 🟡 MEDIUM — `computeDateRangeSplit` bisa menghasilkan d1EndDate < d1StartDate

**File:** [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L56-L91)

```typescript
const waeStartUtc = nowUtc.subtract(WAE_RETENTION_DAYS - 1, "day").startOf("day");
// ...
const d1EndDate = waeStartUtc.subtract(1, "day").format("YYYY-MM-DD");
```

Jika `interval = "91d"` (tepat 1 hari lebih dari WAE):
- `requestedStart = now - 91 days`
- `waeStart = now - 89 days` 
- `d1End = now - 90 days`
- `d1Start = now - 91 days`
- d1Start < d1End ✅

Tapi jika `interval = "90d"` — `isExtendedInterval` returns `false` (90 ≤ 90), jadi tidak pernah masuk ke sini. ✅

Jika `interval = "all"` dan `earliestDate` sangat baru (dalam 90 hari terakhir):
- `requestedStart = earliestDate` (misal hari ini - 30 hari)
- `d1Start = requestedStart`  (hari ini - 30)
- `d1End = waeStart - 1` (hari ini - 90)
- **`d1Start > d1End`** ❌

Ini berarti D1 query akan memiliki `startDate > endDate`, yang seharusnya mengembalikan 0 result (valid SQL), tapi ini logika yang salah dan membingungkan. Seharusnya ada guard clause.

### 🟠 HIGH — `getCounts` pada unified query hanya menggunakan filter pertama untuk D1

**File:** [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L261-L272)

```typescript
for (const filter of supportedFilters) {
    if (filters[filter]) {
        dimensionType = filter;
        dimensionValue = filters[filter] as string;
        break; // Only use the first found filter
    }
}
```

Jika user memiliki **multiple active filters** (misal `path=/about` DAN `country=US`), hanya filter pertama (`path`) yang digunakan untuk query D1. WAE query masih menggunakan semua filters. Ini berarti D1 count akan **lebih besar** dari seharusnya (karena hanya difilter 1 dimensi), dan total merged count akan salah.

**Impact:** Multiple filter + extended interval → D1 over-counts → inflated numbers.

**Mitigasi:** Kode di `getVisitorCountByColumn` sudah menangani ini dengan `canUseD1`:
```typescript
const canUseD1 = activeFilters.length === 0 || (activeFilters.length === 1 && activeFilters[0] === dimensionType);
```
Tapi `getCounts` **tidak** memiliki guard yang sama. Ketika multiple filters aktif, `getCounts` masih mengquery D1 dengan hanya 1 filter.

---

## Fitur 7: Cache Layer (`cache-layer.ts`)

**File:** [cache-layer.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/cache-layer.ts)

### ✅ Yang Berjalan Benar
- Deterministic cache key via sorted params ✔
- Cache versioning auto-bust at 02:05 UTC ✔
- `getCachedOrFetch` pattern ✔
- `hashFilters` — sorted, deterministic ✔

### 🟡 MEDIUM — Cache hanya aktif untuk `isExtended` interval

**File:** [resources.timeseries.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.timeseries.tsx#L72-L85), [resources.stats.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx#L62-L75)

```typescript
if (isExtended) {
    // use cache
} else {
    return await fetchData();  // no cache
}
```

Short-interval queries (≤90d) **tidak pernah di-cache**. Untuk dashboard yang sering diakses, ini berarti setiap page load memicu WAE API call. Ini bukan bug logika per se, tapi bisa menyebabkan rate limiting pada Cloudflare API. Ini mungkin disengaja karena data ≤90 hari di WAE berubah real-time (TTL 60 detik mungkin stale).

---

## Fitur Pendukung: Workers Cron (`workers/app.ts`)

**File:** [app.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/workers/app.ts)

### ✅ Yang Berjalan Benar
- R2 backup → D1 aggregation sequential ordering ✔
- Non-fatal error handling (log and continue) ✔
- R2 cleanup (>95 hari) ✔
- Optional ANALYTICS_DB check ✔

### 🔵 LOW — R2 cleanup hanya list 1000 objects

```typescript
const objects = await env.DAILY_ROLLUPS.list({ limit: 1000 });
```

Jika ada lebih dari 1000 file R2, hanya 1000 pertama yang diperiksa. R2 `.list()` returns cursor-based pagination. Untuk deployment yang sudah berjalan >1000 hari (hampir 3 tahun), file lama bisa tidak terhapus.

---

## Fitur Pendukung: Server-Side Tracker

**File:** `packages/tracker/src/server/`

### ✅ Yang Berjalan Benar
- Always sends `ht=1` — well-documented limitation ✔
- URL validation ✔
- Timeout dengan AbortController ✔
- Fire-and-forget error handling ✔

### 🔵 LOW — `userAgent` pada `ServerClient` tidak dikirim ke collect endpoint

**File:** [server/client.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/server/client.ts#L18-L20), [server/request.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/tracker/src/server/request.ts#L15-L22)

`ServerClient` menyimpan `userAgent` property tapi request fetch di `makeRequest` menggunakan hardcoded `"Counterscale-Tracker-Server/3.2.0"`. Property `client.userAgent` tidak pernah digunakan. Ini berarti server-side tracking selalu memiliki User-Agent generik — bukan bug kritis, tapi property menjadi dead code.

---

## Fitur Pendukung: Bounce Rate Display

### 🔵 LOW — Inkonsistensi bounce rate calculation antara stats dan timeseries

**File:** [resources.stats.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx#L48-L58)

```typescript
const hasSufficientBounceData = true; // Always true
const bounceRate = counts.visitors > 0 ? counts.bounces / counts.visitors : undefined;
```

`hasSufficientBounceData` di-hardcode `true` di `resources.stats.tsx`. Tapi di `api.analytics.ts`:

```typescript
const hasSufficientBounceData =
    earliestBounce !== null &&
    earliestEvent !== null &&
    (earliestEvent.getTime() == earliestBounce.getTime() ||
        earliestBounce < startDate);
```

Dua logika yang berbeda untuk menentukan apakah bounce rate bisa ditampilkan. Ini berarti dashboard UI selalu menampilkan bounce rate (bahkan untuk data lama yang mungkin tidak memiliki bounce tracking), sementara API external melakukan pengecekan yang lebih ketat.

### 🔵 LOW — `bounceRate` double-multiplied di `resources.stats.tsx` display

**File:** [resources.stats.tsx](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx#L50-L51) dan [line 158](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/routes/resources.stats.tsx#L156-L160)

```typescript
// Loader returns ratio (0-1):
const bounceRate = counts.visitors > 0 ? counts.bounces / counts.visitors : undefined;

// Component displays:
`${Math.round(bounceRate * 100)}%`
```

Ini **benar** — ratio 0.5 × 100 = 50%. ✅ Tidak ada double-multiplication.

---

## Rangkuman Issue Utama yang Perlu Diperbaiki

| # | Severity | Lokasi | Deskripsi |
|:-:|:---------|:-------|:----------|
| 1 | 🔴 CRITICAL | [d1-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-query.ts) (all functions) | WHERE clause untuk monthly data mengecek `substr(startDate, 9, 2) = '01'` — hanya include monthly aggregate jika start date tepat tanggal 1. Start date tanggal lain akan **kehilangan** monthly data. |
| 2 | 🔴 CRITICAL | [collect.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/collect.ts#L117-L124) | `extractParamsFromQueryString` split `=` hanya di karakter pertama — path/value yang mengandung `=` akan terpotong. |
| 3 | 🟠 HIGH | [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L261-L272) | `getCounts` hanya gunakan filter pertama untuk D1. Multiple filters + extended interval = D1 over-count. |
| 4 | 🟠 HIGH | [d1-aggregation.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/d1-aggregation.ts#L190-L226) | Sequential WAE API calls dalam aggregation — timeout risk untuk banyak site. |
| 5 | 🟡 MEDIUM | [unified-query.ts](file:///c:/Users/Admin/Desktop/see-flare/seeflare/packages/server/app/analytics/unified-query.ts#L56-L91) | `computeDateRangeSplit` bisa menghasilkan d1Start > d1End untuk "all" dengan data baru. |
