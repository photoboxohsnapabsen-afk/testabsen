# 🔐 Panduan Penerapan Perbaikan Keamanan — Oh Snap! Photobox

> **Status versi lama: TIDAK AMAN untuk dipublikasikan.** Password 14 kru dan PIN admin tertulis di kode & dokumen publik, dan Google Apps Script menjawab siapa pun tanpa login. Detail temuan ada di `SECURITY_AUDIT.md`.
> Versi ini memindahkan verifikasi login ke **server (Apps Script)**, sehingga browser tidak lagi memegang/memeriksa password.

> 📷 **Foto ke Supabase Storage (kualitas lebih tajam, laporan tetap di Spreadsheet):** lihat `SUPABASE_FOTO.md`. Fitur ini opsional dan baru aktif setelah Script Properties Supabase diisi.

---

## ⚠️ Lakukan dulu: anggap SEMUA rahasia lama sudah bocor

Repositori Anda (GitHub Pages) kemungkinan publik, dan riwayat Git menyimpan versi lama. Karena itu:

1. **Semua password kru lama dan `admin123` / `1234` WAJIB diganti** (langkah 7 di bawah). Mengedit file saja tidak cukup — versi lama masih bisa dibaca dari riwayat commit.
2. Pilih salah satu untuk riwayat Git: (a) jadikan repo **Private** (GitHub Pages untuk repo private perlu paket berbayar), atau (b) buat repo baru dengan commit bersih dari paket ini (jangan `git push` riwayat lama).
3. Buka Google Drive → folder pusat Oh Snap → lihat **Aktivitas** / **Dibagikan**. Foto & spreadsheet versi lama bisa dibuka siapa pun yang punya link (lihat langkah 5).

---

## Langkah penerapan (urut, ±15 menit)

### 1. Ganti kode Google Apps Script
Buka proyek Apps Script → hapus isi `Code.gs` → tempel seluruh isi **`Code.gs`** dari paket ini → Simpan.

### 2. Atur password Admin (di server, bukan di kode)
Ikon ⚙️ **Project Settings** → *Script Properties* → **Add script property**
- Nama: `ADMIN_PASSWORD`
- Nilai: password admin baru, **minimal 10 karakter** (campur huruf, angka, simbol; jangan pakai nama/tanggal lahir)

### 3. Jalankan `setupSecurity()`
Di editor, pilih fungsi **`setupSecurity`** pada dropdown → ▶ Run → izinkan akses. Lalu buka *Execution log*; harus muncul `SETUP KEAMANAN SELESAI` dan `Password admin terkonfigurasi : YA`.
Fungsi ini: membuat kunci rahasia server, mengubah `ADMIN_PASSWORD` menjadi **hash** lalu menghapus nilai polosnya, membuang password polos & PIN lama dari Cloud Config (dan cadangannya di Drive), serta mencabut semua sesi lama.

### 4. Deploy versi baru (URL tidak berubah)
**Deploy → Manage deployments → ✏️ (edit) → Version: *New version* → Deploy.**
Pengaturan tetap: *Execute as: Me*, *Who has access: Anyone* (akses dikendalikan oleh login server, bukan oleh setelan ini).

### 5. (Disarankan) Tutup link publik lama
Jalankan **`lockdownExistingSharing()`**. Fungsi ini mengubah semua file/folder di Folder Pusat dari "siapa saja dengan link" menjadi **privat**. Jika log menulis `BELUM SELESAI`, jalankan lagi sampai `SELESAI`.
*Dampak:* link Drive lama tidak bisa dibuka orang luar. Dashboard admin tetap menampilkan foto/spreadsheet karena kini dimuat lewat server dengan token login. Foto yang dibuka admin dari link "🔗 Drive" memerlukan akun Google yang punya akses.

### 6. Upload file web baru ke GitHub
Ganti `index.html`, `admin.html`, `laporan_keuangan_harian.html`, **`foto.html`** (dan salinan di `frontend/`, serta `frontend/vercel.json`) dengan versi di paket ini. Tambahkan `.gitignore`. **Hapus** file `.lnk`, serta `backend/storage/*.json` lama dari repo.
Minta semua kru melakukan *refresh keras* (atau hapus cache) agar tidak memakai halaman lama.

### 7. Isi ulang password kru (wajib)
Login sebagai **ADMIN** (pilih "ADMIN" di kotak cabang, isi password dari langkah 2) → tab **Kelola** → **Kru** → isi password **baru** untuk setiap kru (**min. 8 karakter, tidak boleh sama dengan kru lain di cabang yang sama**) → **Simpan**.
Password tidak pernah ditampilkan lagi setelah disimpan; kolomnya kosong dengan keterangan *tersimpan*. Untuk mengganti, cukup ketik yang baru.

### 8. Beri tahu kru password baru mereka lewat chat pribadi (bukan grup/dokumen).

---

## Yang berubah bagi pengguna

| Hal | Sebelum | Sesudah |
|---|---|---|
| Login | Dicek di browser | Dicek **server**; browser hanya menyimpan token |
| Sesi | Selamanya | Kru **14 jam**, Admin **4 jam** (ditutup saat tab ditutup) |
| Salah password | Tak terbatas | **6x gagal → terkunci 10 menit** (per cabang / admin) |
| Password kru | Terlihat admin, ada di setiap HP | Hanya hash di server; admin hanya bisa **mengganti** |
| Ganti password admin | PIN bebas | Wajib password lama, min. **10 karakter** |
| Data yang dilihat kru | Semua cabang | **Hanya cabangnya sendiri** |
| Laporan | Kru bisa mengisi nama/cabang apa pun | Nama & cabang dipaksa dari sesi login |

Jika sesi habis saat mengirim laporan, aplikasi menampilkan pesan **"laporan BELUM terkirim"** — login ulang lalu kirim lagi (data tidak hilang diam-diam seperti dulu).

---

## Batasan & hal yang belum bisa saya tuntaskan

- **Belum diuji di Google Apps Script sungguhan.** Pengujian saya memakai sandbox yang meniru layanan Apps Script + Chromium dengan server tiruan. Alur POST→redirect Apps Script (`script.googleusercontent.com`) tidak ikut tersimulasi. *Lakukan uji asap setelah deploy:* login kru, kirim 1 absen, login admin, buka riwayat, buka 1 foto. Jika login gagal dengan "Respons server tidak valid", pastikan deployment memakai *New version*.
- **Kunci login bersifat global per cabang/admin** (Apps Script tidak memberi alamat IP). Penyerang dapat sengaja mengunci login 10 menit; admin tetap bisa masuk lagi setelah kunci berakhir.
- **SRI (Subresource Integrity) belum dipasang** untuk jsPDF, autoTable, dan SheetJS di CDN — hash-nya harus dihitung dari file asli dan saya tidak bisa mengunduhnya dari lingkungan ini. Hitung dengan: `curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A`, lalu tambahkan `integrity="sha384-..." crossorigin="anonymous"`.
- **Tailwind Play CDN** (`cdn.tailwindcss.com`) hanya untuk pengembangan dan tidak bisa diberi SRI. Untuk produksi, kompilasi CSS sekali (`npx tailwindcss -o ...`) dan sajikan sebagai file sendiri.
- **SheetJS 0.18.5** memiliki kerentanan yang diketahui (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363) saat membaca file Excel. Risikonya terbatas pada admin yang mengunggah Excel; hanya unggah file yang Anda buat sendiri, atau perbarui ke SheetJS ≥ 0.20.2 (dari situs resmi SheetJS).
- **GitHub Pages tidak bisa mengirim header HTTP** (`X-Frame-Options`, `Content-Security-Policy` sebagai header). Saya memakai tag `<meta>` CSP dan pemecah-iframe JavaScript sebagai gantinya; perlindungannya sedikit lebih lemah daripada header sungguhan. CSP masih mengizinkan `'unsafe-inline'` karena seluruh aplikasi berupa satu skrip inline.
- **Nama kru dan cabang** masih ada di HTML publik (nama depan saja, sebagai data awal). Jika ingin dihapus, kosongkan `defaultEmployees` — tetapi lakukan uji menyeluruh karena beberapa layar mengandaikan daftar kru tidak kosong.
- Folder `backend/` (server Node lokal) **bukan** bagian produksi. Sudah diperketat (lihat audit), tetapi sebaiknya tidak dijalankan di internet.

---

## Menjalankan tes

```bash
node security-tests/test_codegs.js     # 89 pemeriksaan otorisasi/login/token/upload pada Code.gs
```
Tes ini memuat `Code.gs` ke sandbox Node dengan tiruan layanan Apps Script dan menyerangnya (tanpa login, token dipalsukan, lintas cabang, formula injection, file Drive di luar folder, brute-force, dll.).
