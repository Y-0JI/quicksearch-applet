# Quick Search — Cinnamon Applet

Launcher/search universal ringan untuk Cinnamon Linux: satu search box di tengah
layar untuk aplikasi, file, web, URL, dan kalkulator.

![uuid](https://img.shields.io/badge/uuid-quicksearch%40yoji-blue)

## Fitur

| Query | Hasil |
|-------|-------|
| `firefox` | Aplikasi Firefox (Cinnamon AppSystem, tiered scoring) |
| `document` | File/folder via `plocate → locate → find` (async, cancellable) |
| `125*8` | Kalkulasi instan (parser ketat, tanpa `eval`) |
| `github.com` | Buka URL langsung (auto `https://`) |
| `best linux terminal` | Fallback "Search the web" + instant answers DuckDuckGo |

## Instalasi

```bash
# sudah berada di ~/.local/share/cinnamon/applets/quicksearch@yoji
# tambahkan ke panel: System Settings → Applets → Quick Search → +
# atau tekan Super+F
```

## Shortcut

Default `Super+F` (dapat diubah di pengaturan applet).

## Arsitektur

```
Input → debounce 150ms → Query Classifier
      → Providers (App | File | Web | Calculator | URL)
      → normalize → dedupe → rank → limit → render sections
```

- Semua operasi berat async (`Gio.Subprocess.communicate_utf8_async`, Soup 3)
- Generation ID + cancellation: hasil query lama tidak pernah menimpa yang baru
- Provider isolation: satu provider gagal tidak mematikan yang lain
- Cleanup total saat applet dihapus dari panel

## Pengujian

```bash
node --test tests/*.js   # unit test modul pure (16 tests)
```

Matrix pengujian live (race, cancellation, provider failure, dll):
lihat `docs/test-report.md`.

## Catatan

Jika panel memakai autohide "Intelligent", ikon applet tersembunyi bersama
panel saat ada jendela fullscreen — gunakan `Super+F`.
