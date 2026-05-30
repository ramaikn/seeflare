# Fix Task List

Daftar ini hanya berisi bug yang tetap valid setelah dibandingkan dengan `docs/code-review.md`, `docs/review-verify.md`, dan desain di `how/id-how-it-work.md`.

Item yang bersifat trade-off desain dari `id-how-it-work.md` tidak dimasukkan sebagai task fix langsung. Contohnya: D1 monthly boundary untuk menghindari over-counting, cache hanya untuk interval extended, dan pembagian WAE/D1 berdasarkan retensi 90 hari.

## Prinsip Pengerjaan

- Kerjakan task kecil per PR/commit bila memungkinkan.
- Tambahkan test yang membuktikan bug sebelum/sesudah fix.
- Jangan mengubah behavior yang sudah dijelaskan sebagai trade-off desain tanpa keputusan produk baru.
- Untuk WAE/D1 split, utamakan tidak menampilkan angka yang terlihat pasti tetapi sebenarnya hasil filter parsial.

## Task 1 - Perbaiki parser query `/collect` 
[ ] 

File target:
- `packages/server/app/analytics/collect.ts`

Masalah:
- `extractParamsFromQueryString` melakukan parsing manual dengan `split("=")`.
- Value raw yang berisi `=` bisa terpotong.
- Malformed percent encoding bisa menyebabkan error.
- Parameter tanpa value bisa menjadi string `"undefined"`.

Instruksi fix:
- Ganti parser manual dengan `URL`/`URLSearchParams`.
- Jika input bisa berupa path relatif, gunakan base dummy, misalnya `new URL(requestUrl, "https://example.invalid")`.
- Parameter tanpa value harus menjadi string kosong.
- Duplicate parameter boleh mengikuti behavior `URLSearchParams` yang konsisten, tetapi dokumentasikan di test.
- Pastikan request collect tidak gagal hanya karena satu parameter optional malformed. Jika parser tetap bisa throw, tangkap error dan fallback ke object kosong atau partial safe parse.

Kriteria selesai:
- Test untuk `?p=/a=b&sid=x` memastikan value `p` tidak terpotong.
- Test untuk parameter tanpa value memastikan hasilnya `""`, bukan `"undefined"`.
- Test untuk malformed query memastikan handler tidak crash.

## Task 2 - Harden interpolasi SQL WAE [ ]
[ ] 

File target:
- `packages/server/app/analytics/query.ts`

Masalah:
- `filtersToSql` hanya escape `'` dengan backslash.
- `siteId` disisipkan mentah di banyak query.
- `getAllCountsByColumn` membangun `IN (...)` dari dimension values tanpa escaping yang kuat.
- WAE read-only membatasi dampak, tetapi query manipulation, data leak antar site/dimensi, dan query error/DoS tetap mungkin.

Instruksi fix:
- Buat helper tunggal untuk literal string SQL WAE, misalnya `toWaeSqlString(value)`.
- Gunakan SQL escaping standar untuk string literal: bungkus dengan `'...'` dan escape quote internal dengan menggandakan quote (`'` menjadi `''`), bukan backslash.
- Gunakan helper tersebut untuk semua value dinamis: `siteId`, filter values, dan values di `IN (...)`.
- Pastikan nama kolom hanya berasal dari mapping internal yang di-whitelist, bukan input user mentah.
- Hindari membangun fragment SQL dari key filter yang tidak ada di `ColumnMappings`.

Kriteria selesai:
- Test/fixture query dengan value berisi quote dan backslash tidak memutus string literal.
- Test `siteId` dengan payload mirip injection tetap menjadi string literal biasa.
- Test `IN (...)` pada path/referrer/country dengan quote menghasilkan SQL valid.

## Task 3 - Perbaiki double pagination di `getAllCountsByColumn`
[ ] 

File target:
- `packages/server/app/analytics/query.ts`

Masalah:
- Query visitor sudah memilih keys untuk page yang diminta.
- Query non-visitor lalu difilter ke keys tersebut.
- Hasil query kedua masih di-slice lagi dengan `slice(limit * (page - 1), limit * page)`.
- Untuk `page > 1`, hasil query kedua bisa kosong sehingga views/bounces non-visitor hilang.

Instruksi fix:
- Setelah query kedua dibatasi dengan `IN (keys page ini)`, jangan lakukan pagination slice lagi.
- Merge semua row dari query kedua ke keys yang sudah dipilih query visitor.
- Pertahankan urutan output berdasarkan urutan visitor query pertama.

Kriteria selesai:
- Test page 2 dengan `limit=10` tetap memiliki views/bounces dari query kedua.
- Test page 1 tetap tidak berubah.

## Task 4 - Perbaiki `getEarliestEvents`
[x] 

File target:
- `packages/server/app/analytics/query.ts`
- `packages/server/app/routes/api.analytics.ts`
- `packages/server/app/routes/api.analytics.stats.ts`

Masalah:
- `earliestEvent` saat ini dicari dari row `isBounce === 0`.
- Event pertama biasanya `isBounce === 1`, dan hit kedua bisa `-1`.
- Dataset yang hanya punya bounce/anti-bounce bisa dianggap tidak punya event normal, sehingga bounce rate API menjadi `null`.

Instruksi fix:
- Ambil earliest event dari semua row, tanpa filter/group `isBounce`.
- Ambil earliest bounce secara terpisah dari row `isBounce = 1`.
- Return bentuk data yang jelas, misalnya `{ earliestEvent, earliestBounce }`.
- Update caller API agar memakai bentuk baru tersebut.

Kriteria selesai:
- Test dataset hanya berisi `isBounce=1` tetap menghasilkan `earliestEvent`.
- Test dataset berisi `isBounce=1` dan `isBounce=-1` tidak menghasilkan `earliestEvent: null`.
- Validasi bounce API tidak berubah untuk dataset lengkap yang sudah punya row normal.

## Task 5 - Perbaiki unified query saat multiple filters aktif
[x] 

File target:
- `packages/server/app/analytics/unified-query.ts`
- `packages/server/app/analytics/d1-query.ts`

Masalah:
- WAE bisa memakai semua filter sekaligus.
- D1 aggregate hanya bisa mewakili overall atau satu dimension filter.
- `getCounts` dan time series extended memakai filter pertama saja untuk D1.
- Hasil extended interval dengan multiple filters menjadi over-count karena D1 portion hanya terfilter sebagian.

Instruksi fix:
- Buat helper shared, misalnya `getActiveFilters(filters)` dan `canUseD1ForFilters(filters, dimensionType?)`.
- Untuk `getCounts`:
  - Jika tidak ada filter, D1 boleh dipakai untuk overall.
  - Jika tepat satu filter, D1 boleh dipakai untuk dimension tersebut.
  - Jika lebih dari satu filter, jangan gabungkan D1 yang hanya memakai filter pertama.
- Untuk `getD1ViewsGroupedByInterval`/time series extended, terapkan guard yang sama.
- Jika multiple filters aktif dan D1 tidak bisa menghitung intersection secara benar, pilih behavior eksplisit:
  - minimal fix: gunakan WAE-only untuk range yang tersedia dan jangan tambahkan D1 parsial;
  - atau tampilkan/return status bahwa historical D1 tidak tersedia untuk multiple filters.
- Jangan diam-diam mengembalikan total yang inflated.

Kriteria selesai:
- Test extended interval dengan `path` + `country` memastikan D1 query tidak dipanggil dengan hanya salah satu filter.
- Test no-filter dan single-filter tetap memakai D1.
- Test time series dan counts punya behavior guard yang sama.

## Task 6 - Tambahkan guard untuk split range D1 kosong
[x] 

File target:
- `packages/server/app/analytics/unified-query.ts`

Masalah:
- `computeDateRangeSplit` bisa menghasilkan `d1Start > d1End`, terutama untuk interval `all` saat earliest data masih berada dalam 90 hari terakhir.
- Dampak kecil, tetapi ini bukan trade-off desain; query D1 kosong sebaiknya tidak dijalankan.

Instruksi fix:
- Ubah hasil split agar D1 range bisa bernilai `null`/`undefined` saat tidak ada rentang historis.
- Semua caller harus skip query D1 jika D1 range kosong.
- Pastikan WAE range tetap mencakup data yang relevan.

Kriteria selesai:
- Test `all` dengan earliest date di dalam 90 hari terakhir tidak memanggil D1.
- Test interval extended yang benar-benar melewati 90 hari tetap memanggil D1 + WAE.

## Task 7 - Pagination R2 list untuk cleanup dan backfill
[x] 

File target:
- `packages/server/workers/app.ts`
- `packages/server/app/analytics/d1-aggregation.ts`

Masalah:
- Cleanup R2 memakai `list({ limit: 1000 })` tanpa cursor pagination.
- First-run R2 backfill juga hanya membaca maksimal 1000 object.
- Ini melanggar tujuan dokumen: cleanup backup lama dan backfill historis dari R2.

Instruksi fix:
- Buat helper async untuk iterasi semua object R2 dengan cursor, misalnya `listAllR2Objects(bucket, options)`.
- Loop sampai response tidak truncated / cursor habis sesuai API Cloudflare R2 yang dipakai project.
- Gunakan helper yang sama untuk cleanup dan first-run backfill.
- Untuk delete banyak object, gunakan batching yang wajar agar tidak membuat request terlalu besar.

Kriteria selesai:
- Test/mock dengan 1001+ object memastikan semua page diproses.
- Cleanup menghapus object lama yang berada di page kedua.
- Backfill dapat menemukan backup yang berada setelah page pertama.

## Task 8 - Pakai `userAgent` pada server-side tracker
[ ] 

File target:
- `packages/tracker/src/server/client.ts`
- `packages/tracker/src/server/request.ts`
- `packages/tracker/src/server/types.ts`

Masalah:
- `ServerClientOpts.userAgent` dan `ServerTrackPageviewOpts.userAgent` ada di public API.
- Request tetap memakai hardcoded `Counterscale-Tracker-Server/3.2.0`.
- Option menjadi dead API dan analytics browser/device dari server-side tracking bisa salah.

Instruksi fix:
- Thread `userAgent` dari client opts dan per-call track opts sampai ke request builder.
- Tentukan precedence yang jelas: per-call `userAgent` > client `userAgent` > default tracker UA.
- Gunakan value tersebut pada header request yang dikirim ke collect endpoint.
- Jika opsi ini tidak ingin didukung, hapus dari public type dan dokumentasi. Pilihan yang lebih compatible adalah memakai opsi yang sudah ada.

Kriteria selesai:
- Test client-level `userAgent` terkirim.
- Test per-call `userAgent` override client-level value.
- Test default UA tetap dipakai jika tidak ada opsi.

## Task 9 - Samakan kebijakan tampilan bounce rate dashboard dan API
[x] 

File target:
- `packages/server/app/routes/resources.stats.tsx`
- `packages/server/app/routes/api.analytics.ts`
- `packages/server/app/routes/api.analytics.stats.ts`

Masalah:
- Dashboard stats hardcode `hasSufficientBounceData = true`.
- API masih memakai validasi earliest bounce/event.
- Hasil UI dan API bisa berbeda untuk rentang data yang sama.

Instruksi fix:
- Ekstrak helper shared untuk menentukan apakah bounce rate reliable, atau hapus validasi di semua tempat jika produk memang ingin selalu menampilkan bounce rate.
- Pilihan minimal yang paling backward-compatible: pakai kebijakan API sebagai sumber kebenaran dan gunakan helper yang sama di dashboard.
- Pastikan display masih memakai ratio `bounces / visitors` dan hanya mengalikan `* 100` saat rendering persen.

Kriteria selesai:
- Test untuk data tanpa sufficient bounce history menghasilkan behavior yang sama di dashboard loader dan API.
- Test data normal tetap menampilkan bounce rate.
- Tidak ada double multiplication pada display persen.

## Tidak Masuk Task Fix Langsung

Item berikut tidak dimasukkan karena false positive, trade-off desain, atau butuh keputusan produk lebih dulu:

- Tracker relative URL: false positive; path relatif di browser resolve via anchor/DOM.
- Tracker `setTimeout` auto pageviews: edge case SPA kecil dan dinilai trade-off testing/convenience.
- `handleCacheHeaders`: false positive; hit count 1, 2, 3+ sudah sesuai desain dua fase.
- D1 monthly WHERE partial month: `id-how-it-work.md` menyebut D1 sengaja memfilter monthly boundary agar tidak over-counting. Perubahan butuh keputusan produk tentang approximate historical data, bukan fix SQL sederhana.
- D1 aggregation sequential calls: operational scaling risk, tetapi masih trade-off konservatif terhadap WAE API/rate limit.
- Cache hanya untuk extended interval: sesuai desain freshness WAE <= 90 hari dan cache untuk D1/extended.
- Bounce double multiply: false positive; loader mengembalikan ratio dan UI mengalikan saat render persen.
