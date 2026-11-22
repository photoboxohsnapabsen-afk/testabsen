# 📷 Foto & File di Supabase — Laporan Tetap di Google Spreadsheet

**Pembagian tugas (sesuai permintaan Anda):**

| Apa | Disimpan di |
|---|---|
| Laporan per cabang (absen, harian, stok, open/close store…) | **Google Spreadsheet** (seperti sekarang) |
| **Foto / file gambar** | **Supabase Storage** (bucket privat) |
| Login, hak akses, logika server | Google Apps Script (`Code.gs`, tidak berubah arsitekturnya) |

Di Spreadsheet, kolom foto kini berisi **link penampil** (`https://absen.ohsnap.web.id/foto.html#p=…`) menggantikan link Google Drive. Link itu membuka foto resolusi penuh setelah login.
Database Supabase yang saya buat sebelumnya (`supabase-ohsnap.zip`) **tidak dipakai** pada skema ini — abaikan saja.

---

## 1. Kenapa foto sebelumnya buram — dan apa yang berubah

Penyebabnya ada di aplikasi, bukan di Drive: semua foto diperkecil ke **maksimal 720 px** dengan kualitas JPEG 0,8 (kemungkinan agar muat dikirim lewat Apps Script). Sekarang:

| | Sebelumnya | Sekarang |
|---|---|---|
| Resolusi kamera diminta | 1280×720 | **1920×1080** |
| Foto yang dikirim | maks. 720 px, q0,8 | **maks. 2048 px, q0,92** |
| Jalur pengiriman | lewat Apps Script (base64) | **langsung ke Supabase**, Apps Script hanya mencatat link |
| Foto kecil (720 px) | satu-satunya | tetap dipakai hanya untuk **pratinjau lokal** di HP agar penyimpanan browser tidak penuh |

Hasil uji (gambar uji sangat detail dengan teks kecil): foto struk 3000×2000 → tersimpan **2048×1365 (±1,2 MB)**; foto kamera 1920×1080 → tersimpan **1920×1080 penuh** (watermark ikut menskala). Foto asli biasanya 0,4–1,2 MB.

**Mengubah kualitas:** cari `PHOTO_UPLOAD_MAX_DIM = 2048` dan `PHOTO_UPLOAD_QUALITY = 0.92` di `index.html` dan `admin.html` (juga salinannya di `frontend/` dan `laporan_keuangan_harian.html`). Contoh lebih hemat ruang: `1600` dan `0.85` (±3× lebih kecil). Foto asli yang lebih kecil dari batas tidak diperbesar.

---

## 2. Alur kerja

```
HP kru ──(1) minta izin unggah + token login──▶ Apps Script  ──▶ Supabase (buat URL unggah sekali pakai)
HP kru ◀─(2) URL unggah ───────────────────────┘
HP kru ──(3) unggah foto resolusi penuh ───────────────────────▶ Supabase Storage (bucket privat)
HP kru ──(4) kirim laporan + referensi "sb:<path>" ───────────▶ Apps Script ──▶ Spreadsheet (link penampil)
Admin  ──(5) klik link di Spreadsheet → foto.html → login → URL lihat 15 menit → foto
```
Kunci rahasia Supabase (`service_role`) **hanya ada di Script Properties** Apps Script, tidak pernah dikirim ke browser.

---

## 3. Langkah pemasangan (±15 menit)

### a. Buat proyek Supabase
supabase.com → **New project** → region **Southeast Asia (Singapore)**.

### b. Buat bucket
SQL Editor → tempel isi **`supabase/storage.sql`** → Run. Hasil pemeriksaan di bawahnya harus: 1 baris bucket dengan `public = false`, dan **daftar policy kosong** (memang disengaja).
*Alternatif tanpa SQL:* Storage → New bucket → nama `ohsnap-photos`, **Public OFF**, batas ukuran 15 MB, MIME `image/jpeg, image/png, image/webp`.

### c. Ambil 3 nilai
Project Settings → **API**: *Project URL* (`https://xxxx.supabase.co`), kunci **anon / publishable**, dan kunci **service_role / secret**.
Kunci `service_role` menembus semua pengaman — **jangan** ditempel di chat, GitHub, atau HTML.

### d. Isi Script Properties (Apps Script → ⚙️ Project Settings → Script properties)

| Nama | Nilai |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` (harus berakhiran `.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | kunci service_role / secret **(RAHASIA)** |
| `SUPABASE_ANON_KEY` | kunci anon / publishable (publik) |
| `PHOTO_VIEWER_URL` | `https://absen.ohsnap.web.id/foto.html` |
| `SUPABASE_BUCKET` | *(opsional)* default `ohsnap-photos` |

Selama salah satu dari empat yang wajib belum diisi, aplikasi **otomatis tetap memakai Google Drive** seperti sebelumnya (aman untuk dicoba bertahap).

### e. Tempel `Code.gs` baru → Deploy **New version**
Seperti langkah di `SECURITY_FIX_README.md`.

### f. Uji koneksi dari Apps Script
Pilih fungsi **`testSupabaseStorage`** → ▶ Run → lihat *Execution log*. Hasil yang benar:
```
✅ 1. Unggah berkas uji
✅ 2. Daftar objek
✅ 3. URL lihat bertanda tangan
✅ 4. Mengunduh lewat URL bertanda tangan
✅ 5. Bucket PRIVAT (akses publik ditolak)
✅ 6. Hapus berkas uji
=== SEMUA OK: foto siap disimpan di Supabase ===
```
Baris `❌ BAHAYA` pada nomor 5 berarti bucket masih publik — ubah `public` menjadi false.

### g. Upload web baru ke Vercel
Pastikan `foto.html` ikut (ada di folder `frontend/`). `vercel.json` sudah mengizinkan `*.supabase.co` pada CSP.

### h. Uji dari aplikasi (wajib — bagian ini tidak bisa diuji oleh Apps Script)
1. Login kru → kirim **1 absen dengan foto**.
2. Spreadsheet cabang: sel foto berisi link `…/foto.html#p=…`.
3. Supabase → Storage → `ohsnap-photos` → folder `Majenang/<tanggal>/` berisi file `.jpg` (ukurannya ratusan KB–1 MB).
4. Klik link di Spreadsheet → login → foto tampil tajam (resolusi tertera di bawah foto).

### i. (Disarankan) Kencangkan CSP
Di `frontend/vercel.json` ganti `https://*.supabase.co` dengan `https://xxxx.supabase.co` (alamat proyek Anda) pada `connect-src` dan `img-src`.

---

## 4. Keamanan

- Bucket **privat**; tidak ada policy untuk publik. Tanpa login, link di Spreadsheet hanya menampilkan halaman login.
- Kru hanya bisa **meminta izin unggah ke folder cabangnya** dan **melihat foto cabangnya**; admin bisa semua cabang terdaftar.
- URL unggah **sekali pakai**; URL lihat berlaku **15 menit**; nama file acak (UUID) sehingga tidak bisa ditebak.
- Supabase sendiri menolak berkas selain JPEG/PNG/WebP dan > 15 MB; server memvalidasi bentuk path dan memeriksa berkas benar-benar ada sebelum link ditulis ke Spreadsheet.
- Hapus laporan oleh admin ikut menghapus foto di Supabase.
- `SUPABASE_URL` selain `*.supabase.co` ditolak (mencegah kunci service terkirim ke server lain).
- Kunci anon memang publik (dirancang begitu); tanpa policy ia tidak bisa membaca apa pun.
- **Sisa risiko:** orang yang mendapat URL lihat (berlaku 15 menit) bisa meneruskannya; sesi login halaman foto disimpan di perangkat sampai kedaluwarsa atau tombol *Keluar* ditekan.

---

## 5. Kuota & biaya — baca ini

Estimasi kasar (asumsi, bukan hasil ukur): 5 cabang × ±10 foto/hari × ±0,8 MB ≈ **40 MB/hari ≈ 1,2 GB/bulan**. Paket gratis Supabase (±1 GB storage) bisa **penuh dalam kurang dari sebulan**. Pilihan:
1. Paket **Pro** (storage jauh lebih besar; periksa harga terbaru di halaman Supabase), atau
2. Turunkan kualitas (bagian 1: `1600` / `0.85` ≈ 0,3 MB per foto → ±12 MB/hari), dan/atau
3. Hapus foto lama berkala dari Supabase (Storage → pilih folder tanggal → Delete).

Proyek gratis juga bisa di-*pause* bila lama tidak ada aktivitas. Periksa ketentuan terbaru.

---

## 6. Foto lama di Google Drive

Tidak dipindahkan otomatis. Laporan lama tetap menampilkan fotonya lewat jalur Google Drive (aplikasi mendukung keduanya sekaligus). Jika kelak ingin memindahkan, itu pekerjaan terpisah (unduh dari Drive → unggah ke Supabase → perbarui link di sheet).

## 7. Tentang "file"

Bucket dikonfigurasi untuk **gambar** (JPEG/PNG/WebP). Jika Anda juga ingin menyimpan PDF/Excel (mis. hasil ekspor) di Supabase, beri tahu saya jenis dan alurnya — perlu menambah tipe MIME di bucket dan satu jalur unggah lagi.

---

## 8. Jika bermasalah

| Gejala | Penyebab / solusi |
|---|---|
| Toast "Foto gagal diunggah … kode 401/403" | `SUPABASE_ANON_KEY` salah, atau URL unggah kedaluwarsa. Periksa kunci di Script Properties lalu deploy ulang. |
| "Foto gagal diunggah … kode 415" | Berkas bukan JPEG/PNG/WebP. |
| "Foto gagal diunggah … kode 413" | Berkas > 15 MB (tidak seharusnya terjadi dengan pengaturan standar). |
| Toast "Foto gagal diunggah … Failed to fetch" + error CSP di Console | CSP memblokir `*.supabase.co`: pastikan `vercel.json` terbaru sudah ter-deploy. |
| "Gagal menyiapkan unggahan foto" (kode `SB_ERROR`) | Kunci service/URL/bucket salah → jalankan `testSupabaseStorage()`. |
| Foto tampil tapi buram | Kemungkinan memakai pratinjau kecil di HP kru. Buka dari link/dashboard admin untuk versi penuh. |
| Link di Spreadsheet "foto belum ada di penyimpanan" | Unggahan gagal/terlambat. Kirim ulang laporan. |
| Foto Drive lama tidak tampil | Tidak terkait Supabase; lihat catatan `lockdownExistingSharing()` di `SECURITY_FIX_README.md`. |

## 9. Yang belum teruji

Semua logika server dan browser diuji (Code.gs: 133 pemeriksaan; browser Chromium: 78 pemeriksaan termasuk ukuran piksel hasil unggah) **terhadap tiruan** Supabase Storage. Belum diuji terhadap Supabase asli: format permintaan unggah bertanda tangan (`PUT` multipart seperti `supabase-js`), kebijakan CORS, dan respons endpoint daftar/tanda tangan. `testSupabaseStorage()` memverifikasi sisi server; langkah **3h** memverifikasi sisi browser. Jika salah satu gagal, kirim teks error-nya kepada saya.

## Foto WAJIB ke Supabase (tidak ada fallback diam-diam ke Drive)

- Server menolak laporan yang masih membawa data foto mentah (base64) dengan kode `SB_REQUIRED`. Tidak ada foto yang disimpan ke Google Drive.
- Akibatnya: selama `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, dan `PHOTO_VIEWER_URL` belum diisi di Script Properties, laporan berfoto **tidak bisa dikirim**. Isi dulu, lalu jalankan `testSupabaseStorage()` sampai keluar "SEMUA OK".
- Darurat saja: Script Property `ALLOW_DRIVE_PHOTO_FALLBACK = true` mengaktifkan kembali jalur lama (foto ke Drive). Hapus properti itu setelah Supabase normal.
- Laporan (teks/angka + tautan foto) tetap ditulis ke Google Spreadsheet tiap cabang.
