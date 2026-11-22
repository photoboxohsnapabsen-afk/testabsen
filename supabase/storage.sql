-- ============================================================================
-- SUPABASE — hanya PENYIMPANAN FOTO (laporan tetap di Google Spreadsheet)
-- Jalankan sekali di Supabase > SQL Editor.
--
-- Bucket PRIVAT "ohsnap-photos":
--   * tidak publik (public = false)
--   * maks. 15 MB per berkas (foto resolusi tinggi ±0,4–1,5 MB)
--   * hanya JPEG / PNG / WebP (berkas lain ditolak oleh Supabase)
--
-- TIDAK ada policy untuk anon/authenticated: semua akses (buat URL unggah, URL lihat, hapus)
-- dilakukan oleh Apps Script memakai kunci service_role yang disimpan di Script Properties.
-- Browser hanya memakai URL unggah sekali pakai dan URL lihat berumur 15 menit.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ohsnap-photos', 'ohsnap-photos', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Pemeriksaan: harus menghasilkan 1 baris dengan public = false dan TANPA policy
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'ohsnap-photos';
select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects';
