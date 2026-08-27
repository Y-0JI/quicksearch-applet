# SearXNG Local — Quick Search Backend

SearXNG adalah metasearch engine open-source yang bisa dijalankan lokal.
Quick Search dapat menggunakannya sebagai backend web search — gratis, tanpa API key, tanpa batasan query.

## Requirements

- Docker atau Podman terinstall
- Port 8080 tersedia (default)

## Cara Menjalankan

### Docker

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng
```

### Podman

```bash
podman run -d --name searxng -p 8080:8080 searxng/searxng
```

### Verifikasi

Buka browser atau gunakan curl:

```bash
curl "http://127.0.0.1:8080/search?q=BMRI&format=json"
```

Response harus berisi JSON dengan field `results` yang berisi array hasil pencarian.

## Pengaturan di Quick Search

1. Buka Settings applet (klik kanan → Configure)
2. Di bagian **Search**, pilih **"SearXNG (Local)"** dari dropdown "Web search engine"
3. Isi field **"Local SearXNG instance URL"** dengan URL instance Anda
   - Default: `http://127.0.0.1:8080`
   - Ubah jika SearXNG berjalan di port/host lain
4. Tutup Settings — perubahan berlaku langsung

## Cara Menghentikan

```bash
docker stop searxng
docker rm searxng
```

atau

```bash
podman stop searxng
podman rm searxng
```

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| "SearXNG lokal tidak tersedia" | Pastikan container berjalan: `docker ps` |
| Hasil kosong | Cek `curl http://127.0.0.1:8080/search?q=test&format=json` |
| Port sudah dipakai | Ganti port di perintah docker, lalu update URL di Settings |
| Error JSON | Pastikan SearXNG versi terbaru (format=json support) |

## Keamanan

- Default hanya listening di localhost (127.0.0.1)
- Tidak ada API key yang dikirim atau disimpan
- Tidak ada data yang dikirim ke server external
- Tidak ada shell atau command execution
- Semua request menggunakan HTTP transport yang sudah ada (Soup/GJS)
