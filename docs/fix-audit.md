# Fix Audit Report: Bug vs Trade-off Analysis

Dokumen ini merupakan hasil analisis mendalam (deep scan) yang memverifikasi daftar tugas perbaikan (`docs/fix-task-list.md`) terhadap prinsip arsitektur sistem (`how/id-how-it-work.md`), laporan ulasan kode (`docs/code-review.md`), dan hasil verifikasinya (`docs/review-verify.md`). 

Tujuan dari audit ini adalah untuk dengan tegas memisahkan **bug nyata (yang layak dan wajib diperbaiki)** dari perilaku sistem yang merupakan **kompromi desain (trade-off) arsitektural yang disengaja**. Penilaian ini berlandaskan pada prinsip mempertahankan skalabilitas jangka panjang Cloudflare Workers (WAE) dan SQLite (D1) seperti desain awal Seeflare.

---

## 1. Task yang Berstatus BUG NYATA (Layak & Wajib Diperbaiki)

### 1.1. Double Pagination pada WAE `getAllCountsByColumn` (Task 3) [DONE]
* **Kategori:** Logical Bug (Critical Data Loss)
* **Analisis Mendalam:** Setelah query pertama (pengunjung/visitor) melakukan *paginasi* dan mengambil kunci-kunci baris (keys) yang spesifik untuk halaman yang dilihat, query kedua (non-visitor) dibatasi pada kunci-kunci tersebut. Namun secara fatal, array hasil dari query kedua di-*slice* lagi menggunakan kursor halaman `slice(limit * (page - 1), limit * page)`. Karena himpunan hasil kedua sudah difilter hingga maksimal sejumlah batasan limit (10 baris), *slice* untuk `page > 1` (misal 11-20) akan selalu menghasilkan array kosong. 
* **Dampak Khusus:** Data views dan bounces dari "non-visitor" hilang tanpa disadari pada halaman 2 dan seterusnya di tabel dasbor UI.
* **Keputusan Audit:** **BUG NYATA**. Wajib diperbaiki dengan tidak memotong (`slice`) ulang himpunan hasil query kedua.

### 1.2. Kelemahan Escape SQL di WAE (Task 2) [DONE]
* **Kategori:** Security & Data Reliability Bug
* **Analisis Mendalam:** Walau WAE Analytics Engine beroperasi secara *read-only* (mencegah modifikasi atau penghapusan tabel), sanitasi data `filtersToSql` saat ini hanya meng-_escape_ karakter kutip tunggal (`'`) dengan _backslash_ tanpa mekanisme pencegahan lanjutan. Parameter seperti `siteId` serta parameter list `IN (...)` dilempar secara mentah ke _string query_.
* **Dampak Khusus:** Injeksi SQL dapat mengeksploitasi _information leak_ (melihat agregat dari `siteId` orang lain) atau meluncurkan serangan *Denial of Service* (DoS) melalui kueri *malformed* secara massal.
* **Keputusan Audit:** **BUG NYATA**. Wajib diperbaiki. Konstruksi literal SQL `''` harus dilindungi secara komprehensif, dan kolom-kolom perlu menggunakan _whitelisting_ yang ketat.

### 1.3. Kehilangan Opsi `userAgent` pada Server-Side Tracker (Task 8) 
* **Kategori:** Functional Bug (Dead API)
* **Analisis Mendalam:** Opsi internal dari library sisi-server Seeflare telah menyediakan _parameter_ `userAgent` dari klien untuk diteruskan. Ironisnya, rutinitas _network builder_ justru memaksa penggunaan string statis `Counterscale-Tracker-Server/3.2.0` tanpa melihat opsi tersebut. 
* **Dampak Khusus:** Fungsionalitas deteksi _Browser_, _OS_, dan Tipe Perangkat lumpuh secara mutlak jika pelanggan menggunakan pelacakan dari _backend server_ mereka.
* **Keputusan Audit:** **BUG NYATA**. Layak diperbaiki untuk menghidupkan _dead option_ dan mewariskan agen klien sesungguhnya ke _collect endpoint_.

### 1.4. Akurasi Penetapan `earliestEvent` (Task 4)
* **Kategori:** Logical Accuracy Bug
* **Analisis Mendalam:** Secara fundamental, perhitungan `isBounce` dalam arsitektur sistem adalah: hitung pertama = 1 (bounce tercatat), hitung kedua = -1 (anti-bounce), dan baru hitung ketiga = 0 (kunjungan normal). Kode `getEarliestEvents` secara naif mengandalkan row `isBounce === 0` untuk tanggal terawal situs. Jika situs (atau dataset) terlalu baru atau semua lalu lintas berupa pengunjung tunggal, titik terawal gagal dikalkulasi.
* **Dampak Khusus:** API menganggap data belum tersedia (null) dan merusak visualisasi grafik retensi awal.
* **Keputusan Audit:** **BUG NYATA**. Layak diperbaiki. Titik mulai situs harus didapat dari pencarian _timestamp minimum_ semua data terlepas dari flag bounce.

### 1.5. Kerentanan Parser Query String (Task 1)
* **Kategori:** Reliability Bug
* **Analisis Mendalam:** Meski _tracker browser_ resmi telah men-_encode_ variabel URL sebelum dikirim, server *endpoint* `/collect` secara primitif bergantung pada eksekusi `split("=")`. Permintaan REST API dari modul luar pihak ketiga yang memuat token/Base64 payload dengan karakter sama dengan `=` akan terpotong paksa atau menghasilkan _URIError_ yang melumpuhkan Worker.
* **Dampak Khusus:** API endpoint gagal menerima _payload_ yang panjang dan kehilangan parameter krusial.
* **Keputusan Audit:** **BUG NYATA**. Harus distandarisasi penguraiannya menggunakan ekosistem `URLSearchParams`.

### 1.6. Inkonsistensi Dashboard dan API untuk Bounce Rate (Task 9)
* **Kategori:** Interface Consistency Bug
* **Analisis Mendalam:** Tampilan statistik antarmuka memaksa properti ketersediaan data pantulan (bounce data) ke posisi kebenaran statis (`hasSufficientBounceData = true`). Sebaliknya, API internal mengevaluasi kebenarannya berdasar deretan tanggal data dasar. 
* **Dampak Khusus:** Dasbor akan menyajikan _bounce rate_ yang berstatus "0%" alih-alih memberitahu tidak adanya jejak analitik pantulan masa lampau. 
* **Keputusan Audit:** **BUG NYATA**. Wajib distandarkan mengadopsi logika sumber kebenaran (Source of Truth) API.

---

## 2. Task yang Merupakan KOMPROMI DESAIN (Trade-off) & Butuh Penyesuaian, Bukan Perbaikan Mutlak

### 2.1. Unified Query dengan Multiple Filters pada Agregasi D1 (Task 5)
* **Kategori:** Arsitektural Trade-off (Bug pada Logika Transisi D1)
* **Analisis Mendalam:** Mengacu kepada `id-how-it-work.md`, tabel `daily_aggregates` pada D1 SQLite berfungsi dengan arsitektur **Agregasi per Dimensi**. D1 tidak menampung kombinasi multi-dimensi (contoh: irisan spesifik Path `/about` AND Negara `ID`) untuk mengurangi latensi pembengkakan kolom.
* **Masalah Aktual:** Pemanggilan kueri `getCounts` berusaha memaksa kueri ke D1 untuk multi-filter dengan melempar filter pertama saja. Akibatnya D1 mengembalikan akumulasi yang **jauh lebih besar (_overcount_)** karena tidak memfilter aspek dimensi kedua, sementara bagian rentang 90 harinya di WAE memfilternya dengan akurat.
* **Keputusan Audit:** Ini adalah **TRADE-OFF ARSITEKTUR YANG DI-HANDLE SECARA SALAH**. Batasan kapabilitas agregat D1 adalah keniscayaan desain. Perbaikan **BUKAN** dengan merancang ulang D1, melainkan dengan memodifikasi modul `unified-query.ts`: bila filter berjumlah > 1, sistem dilarang memanggil D1, dan secara eksplisit harus membatalkan penggabungan interval panjang (fallback pure-WAE atau berikan warning akurasi pada dasbor). Task ini patut dijalankan demi meluruskan batasan arsitektur.

### 2.2. Batasan Paginasi `limit 1000` Kursor R2 Cleanup (Task 7)
* **Kategori:** Operasional Limit Trade-off (Scaling Bug)
* **Analisis Mendalam:** Proses _Cron Job_ secara *hardcoded* dibatasi melakukan `list({ limit: 1000 })` untuk mengusap file-file usang. 
* **Masalah Aktual:** Merujuk klaim di Arsitektur, sistem ini merekam data "selamanya". Ketika sistem memasuki tahun ke tiga operasi (hari ke 1001), prosedur ini akan gagal membersihkan R2 dan biaya server pengguna perlahan-lahan membengkak secara linier.
* **Keputusan Audit:** **BUG TERHADAP SKALABILITAS (OPERASIONAL).** Task ini harus diperbaiki menggunakan perulangan kursor API (Cursor Pagination) untuk membersihkan berapapun jumlah baris backup bulanan.

### 2.3. Celah Guard Pemisah Rentang D1 yang Menghasilkan `d1Start > d1End` (Task 6)
* **Kategori:** Edge Case / Efisiensi (Optimization)
* **Analisis Mendalam:** Jika periode rentang filter ditetapkan sebagai "All Time", namun riwayat situs baru berumur belasan hari. Rumus pembelahan dua zona waktu (`computeDateRangeSplit`) akan terdistorsi dan mengirim SQL terbalik.
* **Keputusan Audit:** **BUKAN CRITICAL BUG (HANYA OPTIMISASI).** Kueri SQLite terhadap masa tidak masuk akal tidak mengakibatkan kesalahan fatal (hanya mengembalikan nol baris), namun perbaikan ini direkomendasikan demi menghemat limit operasi database (API call).

---

## 3. Tidak Termasuk Ke Dalam Daftar Perbaikan (Pure Trade-off)

Hal-hal di bawah merupakan kompromi arsitektural (Trade-off) mutlak dari model integrasi Seeflare yang **TIDAK PERLU DIPERBAIKI**, mengonfirmasi hasil `review-verify.md` yang sejalan dengan `id-how-it-work.md`:

1. **D1 Monthly Boundary Filter (SQL Partial Month Limit):** D1 secara eksplisit dilarang mengeksekusi komputasi bulan parsial. Ini adalah pertahanan logis dari Overcounting D1 dengan rentang geser transaksional 90 hari WAE. Mengubah ini merusak keakuratan penggabungan total.
2. **D1 Aggregation Sequential Calls (`aggregateDay`):** Mengeksekusi loop site & dimension tanpa paralel secara sadar diimplementasikan. Eksekusi bersamaan `Promise.all()` akan mempercepat tugas, tetapi mempertaruhkan _rate limit_ _WAE Cloudflare Analytics_.
3. **Caching Absen pada Interval ≤ 90 Hari:** Keputusan meninggalkan WAE (kurang dari 90 hari) tanpa lapisan *Edge Cache* adalah jaminan kesegaran laporan secara waktu nyata (Real-time tracking), caching dikhususkan untuk kueri masif berjangka waktu selamanya (Extended D1).
4. **Tracker History PushState Delay `setTimeout(fn, 0)`:** *Task asinkron loop event* dibutuhkan memfasilitasi _reactivity_ di _Single Page Application_ modern (React, Vue, dsb). Tidak terdapat dampak negatif pengukuran sesi kecuali pengguna berpindah halaman dalam orde milidetik sebelum DOM diselesaikan oleh browser.

## Kesimpulan
Audit menyimpulkan daftar *Task 1 hingga 9* yang telah diseleksi tersebut adalah **VALID**, layak diperbaiki secara utuh, dan bukan sekadar *trade-off*. Satu-satunya peringatan ada di *Task 5*, di mana penyelesaiannya harus difokuskan pada _limitasi kueri filter ganda_ di lapisan logika dasbor, bukan dengan merusak konsep skema dimensi agregasi tunggal di dalam SQLite D1.
