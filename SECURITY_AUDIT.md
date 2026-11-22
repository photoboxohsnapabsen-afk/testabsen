# Laporan Audit Keamanan — Oh Snap! Photobox 5 Cabang

**Kesimpulan: versi awal TIDAK aman untuk dipublikasikan.** Siapa pun yang membuka source halaman web (publik) bisa mengambil seluruh password kru dan PIN admin, membaca/menghapus data, bahkan membaca atau membuang file Google Drive apa pun milik pemilik script — tanpa login.

Arsitektur: halaman statis di GitHub Pages (`index.html`, `admin.html`) + Google Apps Script (`Code.gs`, web app "Anyone") + Spreadsheet/Drive per cabang. Folder `backend/` (Node.js) adalah server uji lokal.

Legenda status: ✅ diperbaiki & diuji · 🟡 dikurangi / perlu tindakan Anda · ⛔ belum bisa saya tangani

## 🔴 Kritis

| # | Temuan | Bukti | Status |
|---|---|---|---|
| K1 | **Apps Script tanpa autentikasi.** `doGet`/`doPost` melayani `get_config`, `save_config`, `delete_records`, `get_photo`, simpan laporan untuk siapa pun yang tahu URL `/exec` (URL ada di source HTML publik). `get_config` mengembalikan **PIN admin + password polos semua kru**. Penulisan juga lewat `GET` (mudah dipicu dari link/gambar). | Baca kode; uji: aksi tanpa token kini ditolak `AUTH_REQUIRED` | ✅ Token HMAC bertanda tangan, peran ADMIN/EMPLOYEE, semua aksi dicek di server, GET tidak lagi melayani data |
| K2 | **Baca & hapus file Drive apa pun.** `get_photo?fileId=…` membaca file mana pun yang bisa diakses pemilik script lalu **menjadikannya publik**; `delete_records` membuang file Drive apa pun ke trash. | Baca kode; uji dengan file di luar folder: ditolak | ✅ File harus berada di dalam Folder Pusat (dan folder cabang untuk kru); tidak ada lagi perubahan sharing otomatis |
| K3 | **Kredensial tertulis di kode & dokumen publik**: 14 password kru di `defaultEmployees`, di README & 2 file prompt, di `backend/storage/ohsnap_database.json`; PIN admin default `admin123`. **Pintu belakang**: PIN `1234` dan `admin123` *selalu* diterima walau PIN diganti. Password juga disalin ke localStorage tiap perangkat dan diunggah ke Cloud Config + cadangan Drive dalam bentuk polos. | Grep kode & dokumen | ✅ Dibuang dari kode/dokumen; password hanya hash di server; backdoor dihapus. 🟡 **Anda wajib mengganti semua password** (riwayat Git masih menyimpannya) |
| K4 | **Login 100% di browser.** Admin dapat "login" cukup dengan `sessionStorage.setItem('ohsnap_admin_auth_v1','1')`. | **Dibuktikan di Chromium** pada HTML asli: `isAdminAuthenticated = true` tanpa password | ✅ Flag dihapus; keabsahan sesi ditentukan token server. Uji: flag lama & token palsu → ditolak |
| K5 | **Stored XSS.** 122 pemakaian `innerHTML`, **tidak ada** fungsi escape. Karena K1, siapa saja bisa menanam `<img onerror=…>` di data log/nama/catatan; kode berjalan di browser admin (mencuri sesi, mengubah config, menghapus data). | **Dibuktikan** pada HTML asli (`window.__xss=1`, 4 elemen `<img>` hasil injeksi) | ✅ 793 interpolasi di-escape otomatis (`escapeHtml`/`safeUrl`), ditinjau satu per satu; uji ulang: tidak tereksekusi |

## 🟠 Tinggi

| # | Temuan | Status |
|---|---|---|
| T1 | Spreadsheet & foto otomatis dibagikan "siapa saja dengan link" (`ANYONE_WITH_LINK`); dashboard membaca sheet lewat gviz publik. Foto selfie kru + lokasi GPS + omzet bisa dibuka siapa pun yang punya link. | ✅ Tidak dibagikan publik lagi; dashboard membaca via server (`get_sheet_rows`, per cabang). 🟡 File lama baru tertutup setelah Anda menjalankan `lockdownExistingSharing()` |
| T2 | **Formula injection** pada Google Sheets: nama/catatan berawalan `=` (mis. `=IMPORTXML(...)`) dieksekusi sebagai rumus. | ✅ Dinetralkan (`secAppendRow_`); diuji |
| T3 | Upload foto tanpa validasi tipe/ukuran/jumlah; `cabang` karangan membuat spreadsheet baru; `branchSpreadsheetId` dari klien membuat script menulis ke spreadsheet mana pun. | ✅ Hanya JPEG/PNG/WebP ≤ 6 MB, ≤ 12 foto; cabang harus terdaftar; ID spreadsheet hanya dari admin |
| T4 | Backend Node: menyajikan **seluruh repo** (database JSON dengan 14 password, `Code.gs`, README), CORS `*`, API tanpa auth (baca/timpa/hapus data), **crash** akibat satu JSON rusak. | ✅ Dibuktikan di versi asli (200 pada file sensitif; server mati), diperbaiki & diuji berdampingan |
| T5 | URL server (`webhookUrl`) bisa diubah lewat Cloud Config dan hanya divalidasi `includes('script.google.com')` (mis. `https://evil.com/script.google.com` lolos) → data & token dialihkan ke penyerang. | ✅ Hanya `https://script.google.com/macros/s/…` |

## 🟡 Sedang

| # | Temuan | Status |
|---|---|---|
| S1 | Pesan error internal (`err.toString()`) dikirim ke klien. | ✅ Pesan generik; detail ke log server |
| S2 | Tanpa pembatasan percobaan login; password kru bertipe nama+2 digit (mudah ditebak) dan sekaligus menjadi identitas. | ✅ 6 gagal → kunci 10 menit; min. 8 karakter; unik per cabang |
| S3 | Tidak ada CSP/anti-clickjacking. | 🟡 CSP `<meta>` + pemecah iframe (keterbatasan GitHub Pages, lihat README) |
| S4 | Salinan `Code.gs` lama tertanam di HTML (tombol "Copy Code.gs") — admin bisa menempel ulang versi rentan. | ✅ Diganti versi aman |
| S5 | Atribut `href`/`src` dari data tanpa validasi skema (`javascript:`). | ✅ `safeUrl()` |
| S6 | Kru bisa mengirim laporan atas nama orang/cabang lain; kru melihat data semua cabang. | ✅ Nama & cabang dipaksa dari sesi; data dibatasi per cabang |
| S7 | Teks bantuan di UI menampilkan "Password Admin bawaan: admin123". | ✅ Dihapus |

## 🔵 Rendah / informasi

| # | Temuan | Status |
|---|---|---|
| R1 | Skrip CDN tanpa SRI; Tailwind Play CDN (dev-only); SheetJS 0.18.5 punya CVE (CVE-2023-30533, CVE-2024-22363). | ⛔ Perlu hash/berkas dari Anda — lihat README |
| R2 | File `.lnk` membocorkan nama mesin & path lokal. | ✅ Dihapus |
| R3 | Nama depan kru di HTML publik. | 🟡 Dibiarkan (risiko uji); lihat README |
| R4 | Riwayat Git menyimpan semua rahasia lama. | 🟡 **Tindakan Anda**: ganti semua password; repo private/commit bersih |
| R5 | Tidak ada `.gitignore` (database/ .env bisa ikut ter-commit). | ✅ Ditambahkan |

## Cara pengujian (dan batasannya)

1. **Unit/otorisasi (`security-tests/test_codegs.js`)** — 89 pemeriksaan pada `Code.gs` asli di sandbox dengan tiruan layanan Apps Script: tanpa token, token dipalsukan/kedaluwarsa/dicabut, lintas cabang, brute-force, formula injection, file di luar folder, upload non-gambar, dll.
2. **Ujung-ke-ujung di Chromium (44 pemeriksaan)** — halaman hasil perbaikan dijalankan di browser sungguhan, panggilan ke Apps Script diarahkan ke sandbox di atas: login kru/admin, password lama ditolak, password tidak tersimpan di browser, XSS tidak tereksekusi (data berbahaya benar-benar dirender), manajemen kru, kirim laporan, sesi dirusak, foto tetap tampil setelah file dijadikan privat.
3. **Kontrol negatif** — payload & serangan yang sama dijalankan pada kode **asli** untuk membuktikan celahnya nyata (XSS tereksekusi, bypass admin, backend bocor & crash).

**Yang belum teruji:** Google Apps Script sungguhan (alur redirect `script.googleusercontent.com`, kuota, `CacheService` nyata), perangkat seluler/kamera/GPS, dan alur lengkap Excel/PDF. Lakukan uji asap pasca-deploy (lihat README).

## Tambahan: penyimpanan foto di Supabase (opsional)

| Aspek | Keputusan |
|---|---|
| Akses bucket | **Privat**, tanpa policy publik; semua akses lewat Apps Script dengan kunci `service_role` yang hanya ada di Script Properties |
| Unggah | URL bertanda tangan **sekali pakai** per foto; path acak `<Cabang>/<tanggal>/<uuid>.jpg`; kru hanya bisa meminta untuk cabangnya |
| Lihat | URL bertanda tangan **15 menit** setelah cek token & cabang; link di Spreadsheet mengarah ke `foto.html` yang meminta login |
| Validasi | Bentuk path, cabang terdaftar, berkas ada di bucket sebelum link ditulis; Supabase menolak non-gambar dan > 15 MB |
| Hapus | Admin menghapus laporan → foto Supabase ikut terhapus |
| Cadangan | Jika Supabase belum dikonfigurasi, aplikasi memakai Google Drive seperti sebelumnya |
| Kuota penyimpanan lokal | Foto resolusi tinggi tidak disimpan di localStorage (sebelumnya penyimpanan lokal bisa berhenti diam-diam saat penuh) |

Pengujian: `security-tests/test_codegs.js` kini 133 pemeriksaan (44 untuk jalur foto); uji Chromium mengukur piksel berkas yang benar-benar tersimpan (2048×1365 dan 1920×1080 vs 720 px sebelumnya). Belum diuji terhadap Supabase asli (lihat `SUPABASE_FOTO.md` bagian 9).
