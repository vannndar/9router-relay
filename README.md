# Solver.me — Block Blast Solver & 9Router Relay

Relay HTTP dengan tujuan tetap ke 9Router. Agent di laptop memakai domain Vercel;
Vercel meneruskan request ke origin 9Router Anda (`https://9router.example.com`).

Deployment utama: `https://your-project.vercel.app`.
Base URL client: `https://your-project.vercel.app/v1`.
Token client serta model contoh tersedia di file lokal `client.env` (tidak di-commit).

## Block Blast Solver

Halaman `/` adalah solver Classic 8×8. Unggah atau tempel screenshot PNG/JPG/WebP
(maksimal 15 MB), periksa hasil deteksi, koreksi sel papan serta bentuk 1–3 balok,
lalu centang konfirmasi dan tekan **Cari langkah terbaik**. Screenshot harus
menampilkan papan dalam posisi diam dan semua balok yang tersisa.

Papan dan editor bentuk mendukung klik, drag mouse, dan sapuan sentuh. Mulai dari
sel kosong untuk mengisi semua sel yang dilintasi; mulai dari sel terisi untuk
menghapus. Sel yang dilewati kembali dalam satu sapuan tidak dibalik lagi.
Gerakan cepat tetap mencakup sel di antara posisi pointer. Enter/Space dan
navigasi tombol panah tetap tersedia untuk pengoperasian keyboard.

**Sisa kesempatan combo** dapat dipilih 3 (default), 2, atau 1. Nilai kosong atau
tidak diberikan juga memakai 3. Setiap penempatan tanpa pecahan mengurangi sisa
kesempatan; pecahan mengembalikannya ke 3. Melewati kesempatan terakhir tanpa
pecahan dihitung sebagai putus combo dan memulai jendela baru 3 penempatan.
Hitungan berjalan per balok dan melewati batas pergantian tray. **Lanjut dari
papan akhir** otomatis membawa sisa kesempatan hasil perhitungan. Screenshot
tidak dapat menentukan riwayat combo; pengguna dapat menyesuaikan pilihan ini.

Pembacaan gambar memakai Canvas dan analisis warna lokal. Area papan dan tiap
balok dapat dipilih ulang dengan menggeser pada screenshot. Tema/gambar yang tidak
terbaca tetap bisa diisi manual. Pratinjau langkah menandai posisi sudut kiri atas
bentuk yang sudah dinormalisasi, menggunakan koordinat baris/kolom mulai dari 1.

Pencarian menyeluruh berjalan di Web Worker: semua urutan dan penempatan legal
dicoba, dengan penghapusan baris dan kolom penuh secara bersamaan setelah setiap
penempatan. Balok tidak diputar, tidak ditumpuk, dan tidak jatuh setelah garis
dihapus. Pencarian ini tetap memastikan jumlah maksimum balok saat ini yang bisa
dipasang. Di antara urutan dengan jumlah balok maksimum, mesin lebih dahulu
memilih yang paling sedikit memutus combo. Default 3 berarti mencari minimal
satu pecahan dari tiga balok ketika tersedia urutan lengkap yang memenuhinya.
Jika tidak memungkinkan, hasil legal tetap ditampilkan dengan pemberitahuan
singkat. Keadaan memoization dan kandidat mencakup sisa kesempatan: papan yang
sama setelah pecahan awal dan pecahan akhir tidak disamakan.

Mesin produksi di `web/solver-strategy.mjs` kemudian memilih sampai
8 kandidat papan akhir yang kuat dan berbeda, berdasarkan ruang yang dapat
digunakan, fragmen kecil, penempatan berbagai bentuk, dan potensi penghapusan.

Setiap kandidat dibandingkan pada sampai 20 skenario bersama dengan kedalaman
3 giliran berikutnya. Katalog simulasi berisi 41 orientasi; sampel memakai
keluarga bentuk yang seimbang serta skenario tekanan balok besar/tidak beraturan.
Ini asumsi model, bukan distribusi resmi generator balok Hungry Studio.
Seed diturunkan dari input yang dinormalisasi agar hasil dapat diulang.

Dalam simulasi, setiap giliran dipilih lewat beam search per himpunan balok
terpakai, sisa kesempatan, dan putus combo (lebar 3 per kelompok). Jika pencarian
terbatas gagal memasang seluruh balok atau menjaga combo yang mungkin dipenuhi,
pencarian eksak memeriksa kembali giliran tersebut. Sisa kesempatan dibawa
sepanjang simulasi; putus combo mendapat penalti. Simulasi tidak
mengintip balok pada giliran yang belum terlihat oleh pemain simulasi dan berhenti
saat satu giliran tidak bisa dituntaskan.

Penilaian kelanjutan mengutamakan giliran yang berhasil dilalui, kemudian
penempatan, penghapusan, dan kualitas papan. Skor akhir menggabungkan rata-rata
hasil (65%) dan rata-rata seperempat skenario terburuk (35%). Hanya putaran
perbandingan yang selesai untuk SEMUA kandidat yang boleh memengaruhi pilihan.
Anggaran analisis lanjutan 2,6 detik setelah pencarian eksak awal. Hasil yang belum
selesai tidak pernah ditampilkan sebagai rekomendasi final.

Rekomendasi bertahan adalah perkiraan untuk papan berikutnya: solver tidak tahu
balok yang akan muncul. Booster, revive, target Adventure, serta formula skor dan
pengali poin combo resmi tidak dimodelkan. Jika hanya urutan parsial yang legal, hasil
ditampilkan dengan jumlah balok yang berhasil dipasang.

Gambar dan papan hanya ada di memori tab. Solver tidak mengunggah gambar, memanggil
model AI, memakai token relay, atau menyimpan data browser. Chat serta papan teks
tetap terpisah di `/chat` dan `/paste`; relay `/v1/...` tetap memerlukan token.

Tes `node --test` mencakup pembanding enumerasi independen, pembacaan gambar
sintetis, screenshot Classic nyata, kompatibilitas tautan ruang, routing, dan
interaksi antarmuka tanpa penyimpanan atau pengiriman data solver, pencarian
lanjutan, determinisme input, dan worker produksi. Pemeriksaan pembanding internal
opsional: `node scripts/benchmark-strategy.mjs`; kedua kebijakan menerima urutan
balok holdout yang sama tanpa diberi akses ke giliran masa depan.

## Papan teks bersama

Halaman `/paste` adalah papan teks tanpa login. Kode ruang baru berupa **6 angka**
yang ditampilkan utuh. Tekan **Salin kode**, lalu masukkan kode itu di perangkat lain,
atau gunakan **Salin tautan** untuk membuka ruang langsung. Semua perangkat di ruang yang sama
akan menerima perubahan otomatis, biasanya dalam sekitar tiga detik. Membuka
halaman tanpa tautan menampilkan input kode; tombol **Generate room** membuat ruang baru.

Tautan ruang memakai `/paste#r=123456`, berisi kode ruang dalam fragment URL.
Kode dan tautan lama sepanjang 22 karakter tetap diterima. Penulisan seperti
`123 456` dan `123-456` juga diterima. Kode pendek ditujukan untuk berbagi teks
sementara; siapa pun yang mengetahui atau menebak kodenya dapat membuka ruang.
Tautan lama `/#r=...` dialihkan oleh browser ke `/paste#r=...`, dengan kode yang sama.
Siapa pun yang
memiliki tautan dapat membaca, menambah, dan menghapus teks di ruang itu. Kode ruang
tidak ditempatkan di path request backend; SQLite hanya menyimpan hash kode ruang.
Tidak ada akun atau cookies. Tombol **Generate room** membuat tautan terpisah.

Setiap memo memiliki subject opsional (maksimal 120 karakter). Subject kosong
mendapat nomor `Memo 1`, `Memo 2`, dan seterusnya dalam ruang yang sama. Pencarian
memfilter subject, isi memo, dan nama file di ruang aktif tanpa memperluas akses ke ruang lain.
Draft tetap ada saat pindah ruang. Produksi menyimpan memo di Supabase.

Isi memo dibatasi 1 MB = 1.000.000 byte UTF-8, dengan penghitung ukuran di editor.
Tampilan awal teks panjang diringkas; membuka atau menyalin memo tetap memakai isi
lengkap. Pembacaan memo dikirim sebagai streaming JSON. Polling yang tidak berubah
hanya membaca metadata dan membalas 304, tanpa mengunduh ulang isi memo.

Satu memo dapat membawa satu file hingga 5 MB = 5.000.000 byte, dengan atau tanpa
isi teks. Pilih **Lampirkan file**, lalu **Kirim memo**. Perangkat lain di room yang
sama mendapat tombol **Unduh** dengan nama asli file. Format yang didukung:
Word, Excel, PowerPoint, PDF, TXT, CSV, PNG, JPG, WebP, dan GIF. Berkas diteruskan
utuh; aplikasi tidak mengubah isi atau formatnya.

File berada di bucket private Supabase `paste-files`. Browser mengunggah langsung
ke URL khusus untuk satu file; secret key tetap di server. File baru terlihat
setelah ukuran unggahan diverifikasi. URL unduhan berlaku maksimal 60 detik dan
tidak melewati waktu kedaluwarsa memo. Hapus memo juga menghapus objek Storage;
antrian cleanup mencoba ulang tiap menit jika Storage sedang tidak tersedia.
Unggahan yang ditinggalkan dibersihkan setelah 10 menit. Karena token upload
Supabase berlaku dua jam, cleanup mengulang penghapusan setelah token berakhir
untuk menghapus kemungkinan unggahan terlambat. Salinan yang telah diunduh tetap
berada di perangkat penerima. Kuota aplikasi untuk file aktif/pending adalah 250 MB.

### Backend Docker (opsional)

Teks papan disimpan sementara di SQLite dalam container **relay-paste** pada PC
backend, terpisah dari database 9Router. Masa berlaku dapat dipilih: 10 menit,
1 jam (default), atau 24 jam. Teks kedaluwarsa dihapus saat dibaca/ditulis dan oleh
pembersih setiap menit. Batasnya 1 MB per teks dan 25 teks per ruang.

Tidak diperlukan database pihak ketiga. PC, Docker, Nginx, dan Cloudflare Tunnel
harus hidup agar sinkronisasi tersedia. Format ini berbeda dengan chat sementara:
sinkronisasi antarperangkat memang memerlukan penyimpanan teks di server.

Backend memakai compose terpisah di `clipboard/compose.yaml`, volume
`relay-paste_paste-data`, dan tidak membuka port ke host. Nginx meneruskan
`https://9router.example.com/_paste/` ke container itu. Endpoint backend memerlukan
`PASTE_BACKEND_KEY` yang hanya tersedia di server dan environment Vercel.

```powershell
docker compose -f clipboard/compose.yaml up -d --build
npm run check:paste
npm run check:paste-ui
```

Source serta `.env` backend dikecualikan dari upload Vercel. Jangan commit
`clipboard/.env`. Untuk setup baru, salin `clipboard/.env.example`, gunakan key acak
minimal 32 karakter, dan set `PASTE_BACKEND_KEY` serta `PASTE_UPSTREAM_URL` di Vercel.

## Penyimpanan Supabase untuk papan teks

Produksi memakai proyek Supabase (ref `<project-ref>`) di region `ap-southeast-1`,
paket Free.
Tabel pertama adalah `public.paste_notes`. Penghitung batas kiriman disimpan terpisah
di `paste_private.rate_limits`, tanpa membuka akses ke browser. Tabel proyek lain
bisa ditambahkan kemudian dengan awalan masing-masing.

Untuk setup ulang pada proyek Supabase baru:

1. Jalankan seluruh file `supabase/migrations/` sesuai urutan tanggal, termasuk
   migrasi subject, 1 MB, file, dan cron, melalui SQL Editor atau Supabase CLI.
2. Simpan `SUPABASE_URL` dan `SUPABASE_SECRET_KEY` di environment Vercel.
   Gunakan secret key server (`sb_secret_...`); jangan gunakan publishable key.
3. Set `PASTE_STORAGE=supabase`, deploy ulang, lalu jalankan `npm run check:paste`
   dan `npm run check:paste-ui` pada alamat produksi.

Cleanup file memakai Edge Function `supabase/functions/paste-file-cleanup`.
Deploy dengan `supabase functions deploy paste-file-cleanup --use-api --no-verify-jwt`;
wrapper `withSupabase({auth:'secret'})` tetap memvalidasi secret API key.
Cron membaca `paste-files-project-url` dan `paste-files-secret-key` dari Vault.
Pada proyek yang sudah terhubung, `node scripts/setup-paste-files.mjs` menyiapkan
Vault, Edge Function, migrasi, dan jadwal tanpa mencetak key. Script tersebut
memeriksa identitas proyek yang telah digunakan. Uji transfer produksi:
`node scripts/check-paste-files.mjs --production`. Semua fixture berupa data buatan
dan script menghapus memo uji setelah selesai.

API Vercel tetap sama. Kode 6 angka dan tautan lama diterima. Database menyimpan
hash ruang; secret key hanya dipakai server Vercel. RLS dan izin tabel menolak
akses langsung dari `anon`/`authenticated`. Cron menghapus teks kedaluwarsa setiap
menit; teks yang sudah kedaluwarsa langsung disaring dari hasil baca. Batas 1 MB,
25 teks per ruang, 1.000 teks total, serta 20 kiriman per menit per ruang tetap berlaku.

Sebelum environment tersebut dipasang, `PASTE_STORAGE=docker` atau nilai kosong
tetap memakai backend yang sudah berjalan. Peralihan ini memulai papan Supabase
kosong; isi SQLite lama tidak dipindahkan otomatis.

Pengujian SQL lokal: `npm run check:supabase-sql`. Pengujian ini memakai container
PostgreSQL sementara tanpa akses jaringan dan membersihkannya setelah selesai.
Pada proyek produksi, cron sudah diverifikasi aktif dan berhasil berjalan.

## Chat sementara

Buka `/chat`, masukkan `RELAY_API_KEY`, pilih model, lalu
kirim pertanyaan. Chat mendukung streaming, tombol Hentikan, Chat baru, dan
penyalinan jawaban. Semua aset berasal dari domain Vercel yang sama.

Percakapan dan token hanya ada di memori tab. Aplikasi tidak memakai localStorage,
sessionStorage, cookies, IndexedDB, atau database chat. Refresh, tutup tab, atau
Putuskan koneksi menghapus sesi. Chat baru menghapus percakapan dan mempertahankan
koneksi dalam tab yang sama. Konteks percakapan dikirim bersama pertanyaan berikutnya
selama sesi itu masih aktif.

`/health` tetap menjadi endpoint JSON untuk pemeriksaan status; `/` menampilkan
solver, `/paste` papan teks, dan `/chat` chatbot. Pencatatan penggunaan token dan kebijakan provider adalah bagian backend;
no-storage di sini berarti tidak ada penyimpanan riwayat chat oleh aplikasi ini.
Pada backend Docker yang diperiksa, `ENABLE_REQUEST_LOGS=false` dan detail request
terakhir berasal dari data lama, bukan sesi chat baru.

```text
Agent di laptop → project.vercel.app → 9router.example.com → 9Router Docker → provider
```

Relay mengganti token client dengan API key 9Router di server, meneruskan body JSON
dan streaming SSE tanpa mengubah format, serta membatasi akses ke endpoint model.
Dashboard, pengelolaan akun, dan pengaturan 9Router tetap di backend asal.

## Konfigurasi

Salin `.env.example` ke `.env.local`, lalu isi:

| Variable | Isi |
| --- | --- |
| `UPSTREAM_ORIGIN` | `https://9router.example.com`, tanpa `/v1` |
| `UPSTREAM_API_KEY` | API key khusus dari dashboard 9Router |
| `RELAY_API_KEY` | Token acak minimal 32 karakter untuk client relay |

`.env.local`, `client.env`, dan metadata lokal deployment diabaikan Git dan upload
Vercel. Simpan ketiga variable di environment Production Vercel; simpan kedua key
sebagai Secret. Relay berjalan di Node.js 24, region Singapore, dengan durasi
function 300 detik dan timeout upstream 285 detik per request.

## Jalankan dan deploy

Tidak ada dependency aplikasi tambahan.

```powershell
npm test
npm run dev
npm run smoke
vercel link --yes --scope your-vercel-scope --project 9router-relay
vercel env add UPSTREAM_ORIGIN --environment production
vercel env add UPSTREAM_API_KEY --environment production --sensitive
vercel env add RELAY_API_KEY --environment production --sensitive
vercel deploy --prod
```

Project baru perlu dibuat/dilink terlebih dahulu. Gunakan akses Production tanpa
halaman login Vercel agar client API bisa terhubung; autentikasi request model
ditangani `RELAY_API_KEY`. Jangan menonaktifkan autentikasi relay.

## Konfigurasi client

Untuk client OpenAI-compatible:

```text
Base URL: https://PROJECT.vercel.app/v1
API key: nilai RELAY_API_KEY
Model: nama model atau combo yang ada di 9Router
```

Client Anthropic-compatible memakai origin `https://PROJECT.vercel.app` dan
`RELAY_API_KEY` melalui header `x-api-key`. Header versi/beta diteruskan.
Protokol endpoint yang dipilih harus didukung client dan backend 9Router.

## Endpoint

- `GET /health` — status konfigurasi relay, tanpa memanggil provider.
- `GET /v1/models` — daftar model dari 9Router.
- `POST /v1/chat/completions`, `/v1/completions`, `/v1/responses`.
- `POST /v1/messages`, `/v1/messages/count_tokens`, `/v1/embeddings`.
- `GET|DELETE /v1/responses/{id}`, `POST /v1/responses/{id}/cancel` diteruskan;
  dukungannya bergantung pada backend/provider.

Endpoint model memerlukan `Authorization: Bearer RELAY_API_KEY` atau `x-api-key`.
Relay tidak menyediakan CORS untuk browser lintas origin atau WebSocket.
HTTP SSE dan tool calls dalam JSON diteruskan. Redirect backend ditolak.

## Pengujian

```powershell
npm test
npm run smoke -- --url https://PROJECT.vercel.app
npm run smoke -- --url https://PROJECT.vercel.app --model NAMA_MODEL
npm run smoke -- --url https://PROJECT.vercel.app --model NAMA_MODEL --tools
```

Smoke test biasa memeriksa health, penolakan akses tanpa token, pemblokiran
endpoint dashboard, dan daftar model. Opsi `--model` melakukan satu request model
singkat untuk memeriksa stream sampai marker selesai (`[DONE]` atau
`finish_reason` dari adapter 9Router); ini memakai kuota provider.
Opsi `--tools` menambahkan satu putaran tool call dan pengiriman hasil tool kembali
ke model, untuk memeriksa alur agent secara lengkap.

Vercel memiliki batas durasi, bandwidth, dan ukuran payload. File/gambar besar
tetap tunduk pada batas platform. PC backend dan Cloudflare Tunnel perlu hidup.
Tes jaringan dari laptop kantor harus dijalankan di laptop/jaringan itu sendiri.
