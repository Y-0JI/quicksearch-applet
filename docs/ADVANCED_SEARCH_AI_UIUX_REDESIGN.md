# UI/UX REDESIGN --- ADVANCED SEARCH + AI MODE

## 1. Tujuan Redesign

Redesign UI/UX aplikasi search agar terasa sebagai **advanced desktop
search launcher modern**, bukan dashboard, file manager, atau command
center yang kompleks.

Desain harus:

-   Minimal dan cepat.
-   Keyboard-first.
-   Fokus pada pencarian.
-   Modern dan premium.
-   Cocok dengan Linux Cinnamon.
-   Mempertahankan fungsi utama aplikasi yang sudah ada.
-   Tidak menambahkan kompleksitas visual yang tidak diperlukan.

Inspirasi visual utama:

-   Modern command palette.
-   GNOME/desktop launcher.
-   Spotlight-style search.
-   Raycast-style hierarchy, tetapi lebih sederhana dan tidak terlalu
    ramai.

------------------------------------------------------------------------

# 2. KONSEP UTAMA

Aplikasi memiliki dua mode yang jelas:

-   🔎 **SEARCH MODE**
-   ✨ **AI MODE**

Keduanya menggunakan bahasa visual yang sama, tetapi **tidak
mencampurkan konten dan fungsi**.

------------------------------------------------------------------------

# 3. SEARCH MODE

## Tujuan

Search Mode digunakan untuk mencari dan membuka:

-   Applications
-   Files
-   Folders
-   Settings
-   Web results

Search Mode harus tetap terasa seperti launcher/search tool.

## Layout

``` text
╭──────────────────────────────────────────────────────╮
│ 🔍  Search apps, files, folders...            ✕     │
├──────────────────────────────────────────────────────┤
│ [ All ] [ Apps ] [ Files ] [ Folders ] [ Settings ] │
│                                         [ Web ]      │
│                                                      │
│ Best Match                                           │
│ ┌──────────────────────────────────────────────────┐ │
│ │  ICON   Telegram                          Enter │ │
│ │         Application · New era of messaging       │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ Applications                                         │
│ ICON    Telegram                                  › │
│         Application                                 │
│ ICON    Hypnotix                                  › │
│         Watch TV                                    │
│                                                      │
│ Files                                                │
│ ICON    filename.pem                              › │
│         /etc/ssl/certs                              │
│ ICON    archive.tar.xz                            › │
│         /home/user                                  │
├──────────────────────────────────────────────────────┤
│ ↑ ↓ Navigate     Enter Open     Ctrl New Window      │
│                                           Esc Close  │
╰──────────────────────────────────────────────────────╯
```

------------------------------------------------------------------------

# 4. SEARCH BAR

Search bar adalah elemen visual utama.

Karakteristik:

-   Besar tetapi tetap compact.
-   Posisi di bagian paling atas.
-   Icon search di kiri.
-   Text input jelas dan mudah dibaca.
-   Tombol close di kanan.
-   Tidak terlalu banyak tombol tambahan.

Contoh:

``` text
🔍   tele                                      ✕
```

Search bar harus terasa cepat dan langsung.

------------------------------------------------------------------------

# 5. CATEGORY FILTER

Gunakan filter horizontal di bawah search bar:

``` text
[ All ] [ Apps ] [ Files ] [ Folders ] [ Settings ] [ Web ]
```

Aturan:

-   `All` aktif secara default.
-   Filter aktif memiliki highlight lembut.
-   Filter lain tetap minimal.
-   Jangan gunakan sidebar permanen.
-   Jangan membuat kategori terlalu besar atau seperti navigation menu.

Tujuannya agar area hasil tetap menjadi fokus utama.

------------------------------------------------------------------------

# 6. BEST MATCH

Best Match harus menjadi hasil paling menonjol.

``` text
Best Match

┌─────────────────────────────────────────────┐
│  ICON   Telegram                     Enter │
│         Application · New era of messaging │
└─────────────────────────────────────────────┘
```

Karakteristik:

-   Highlight lembut.
-   Border tipis.
-   Accent color digunakan secara terbatas.
-   Tidak terlalu besar seperti card dashboard.
-   Keyboard hint `Enter` dapat ditampilkan di kanan.

Best Match harus terasa sebagai:

> Ini hasil yang paling mungkin kamu cari.

------------------------------------------------------------------------

# 7. SEARCH RESULT LIST

Hasil biasa harus sederhana.

Struktur:

``` text
ICON     Result Name                         ›
         Secondary information
```

Contoh:

``` text
📱  Telegram                              ›
    Application

📺  Hypnotix                              ›
    Watch TV
```

Untuk file:

``` text
📄  filename.pem                          ›
    /etc/ssl/certs
```

Aturan:

-   Jangan gunakan card terpisah untuk setiap hasil.
-   Gunakan list dengan spacing yang nyaman.
-   Hover dan keyboard selection harus jelas.
-   Secondary text lebih redup.
-   Icon membantu scanning.
-   Chevron hanya sebagai indikator aksi/detail bila memang diperlukan.

------------------------------------------------------------------------

# 8. AI MODE

## Prinsip utama

AI Mode adalah **mode terpisah dari Search Mode**.

AI Mode **TIDAK boleh** menampilkan:

-   Local Applications.
-   Local Files.
-   Local Folders.
-   Best Match dari search engine lokal.
-   Hasil launcher.

Jangan mencampurkan AI dengan:

``` text
Related Results
Telegram Application
telegram.tar.xz
local files
```

AI Mode harus fokus sepenuhnya pada pertanyaan dan jawaban AI.

------------------------------------------------------------------------

# 9. LAYOUT AI

``` text
╭──────────────────────────────────────────────────────╮
│ 🔍  bagaimana cara install telegram di linux         │
│                                          [ AI ]  ✕   │
├──────────────────────────────────────────────────────┤
│                                                      │
│ ✨ AI Answer                                         │
│                                                      │
│ Telegram bisa diinstall di Linux dengan beberapa     │
│ cara. Berikut cara yang paling umum dan mudah:       │
│                                                      │
│ 1. Menggunakan package manager                       │
│ ┌──────────────────────────────────────────────────┐ │
│ │ sudo apt install telegram-desktop           📋 │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ 2. Menggunakan Flatpak                              │
│ ┌──────────────────────────────────────────────────┐ │
│ │ flatpak install flathub org.telegram.desktop 📋 │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ Setelah selesai, Telegram dapat dibuka dari menu.    │
│                                                      │
│ ──────────────────────────────────────────────────── │
│ 🔗 Sources                                  View more│
│ [ Source 1 ]  [ Source 2 ]  [ Source 3 ]             │
├──────────────────────────────────────────────────────┤
│ +  Ask a follow-up...                           ➤    │
│ Enter Send                                Esc Close  │
╰──────────────────────────────────────────────────────╯
```

------------------------------------------------------------------------

# 10. AI ANSWER

AI Answer harus menjadi fokus utama.

Gunakan:

``` text
✨ AI Answer
```

sebagai heading kecil.

Jawaban harus:

-   Mudah dibaca.
-   Tidak terlalu padat.
-   Memiliki line spacing yang nyaman.
-   Mendukung heading.
-   Mendukung numbered list.
-   Mendukung bullet list.
-   Mendukung code block.
-   Mendukung inline code.
-   Mendukung citation/source.

Jangan membuat setiap paragraf menjadi card.

------------------------------------------------------------------------

# 11. CODE BLOCK

Code block harus jelas tetapi tetap minimal.

``` text
┌─────────────────────────────────────────────┐
│ sudo apt install telegram-desktop       📋 │
└─────────────────────────────────────────────┘
```

Karakteristik:

-   Background sedikit berbeda.
-   Border halus.
-   Font monospace.
-   Tombol copy kecil.
-   Tidak menggunakan warna berlebihan.

------------------------------------------------------------------------

# 12. SOURCES

Sources hanya muncul jika AI menggunakan source.

Contoh:

``` text
────────────────────────────────────

🔗 Sources                       View more

[ Telegram Desktop ]
[ Ubuntu Packages ]
[ Flathub ]
```

Sources harus:

-   Compact.
-   Tidak mengambil terlalu banyak ruang.
-   Bisa berupa small cards atau pills.
-   Menampilkan favicon/icon bila tersedia.
-   Menampilkan domain atau nama sumber.

Jangan membuat Sources terlihat seperti search results lokal.

------------------------------------------------------------------------

# 13. FOLLOW-UP INPUT

Bagian bawah AI Mode:

``` text
+   Ask a follow-up...                       ➤
```

Fungsi:

-   User dapat langsung melanjutkan pertanyaan.
-   Follow-up tetap berada dalam AI context.
-   Tidak mengembalikan UI menjadi Search Mode.

Input harus:

-   Compact.
-   Rounded.
-   Jelas sebagai input.
-   Tidak sebesar chat composer aplikasi messenger.

AI Mode tetap harus terasa sebagai:

> AI-powered search tool

bukan aplikasi chat penuh.

------------------------------------------------------------------------

# 14. MODE SWITCHING

Mode switching harus jelas tetapi sederhana.

Contoh:

``` text
[ 🔎 Search ]   [ ✨ AI ]
```

Aturan:

### Search aktif

``` text
[ 🔎 Search ]
```

Highlighted.

### AI aktif

``` text
[ ✨ AI ]
```

Highlighted.

Switch harus:

-   Cepat.
-   Tidak mengubah window secara kasar.
-   Menggunakan animasi transisi ringan.
-   Mempertahankan query bila masuk akal.

Namun hasil Search dan konten AI harus tetap dipisahkan.

------------------------------------------------------------------------

# 15. ADAPTIVE WINDOW SIZE

Window harus adaptive.

### Idle

Compact:

``` text
┌─────────────────────────────┐
│ 🔍 Search anything...       │
└─────────────────────────────┘
```

### Search results

Window bertambah tinggi sesuai hasil.

### AI short answer

Window lebih kecil.

### AI long answer

Window bertambah sampai batas maksimum.

Jika melebihi tinggi maksimum:

-   Area content scrollable.
-   Search bar tetap sticky.
-   Follow-up tetap sticky di bawah.

------------------------------------------------------------------------

# 16. KEYBOARD-FIRST UX

Aplikasi harus tetap sangat nyaman tanpa mouse.

Shortcut hint di bagian bawah:

``` text
↑ ↓     Navigate
Enter   Open / Send
Ctrl    Secondary action
Esc     Close
```

Aturan:

-   Hint tidak terlalu dominan.
-   Hanya tampilkan shortcut yang relevan.
-   Shortcut dapat berubah sesuai context.

Contoh Search:

``` text
↑ ↓ Navigate
Enter Open
Esc Close
```

Contoh AI:

``` text
Enter Send
Esc Close
```

------------------------------------------------------------------------

# 17. VISUAL STYLE

Gunakan:

### Background

Dark neutral, bukan hitam pekat.

Arah warna:

``` text
deep charcoal
dark blue-gray
```

### Border

Tipis dan subtle.

### Accent

Gunakan satu warna accent utama secara konsisten.

Contoh:

``` text
soft blue
```

Accent digunakan untuk:

-   Selected result.
-   Active filter.
-   Active mode.
-   Primary action.
-   Focus state.

Jangan gunakan terlalu banyak warna.

------------------------------------------------------------------------

# 18. SPACING

Prioritas:

``` text
Breathing room > information density
```

Tetapi jangan membuat window terlalu besar.

Target:

-   Compact.
-   Mudah discan.
-   Tidak terasa kosong.
-   Tidak terasa seperti dashboard.

------------------------------------------------------------------------

# 19. HIERARKI VISUAL

### Search Mode

``` text
1. Search input
2. Category filters
3. Best Match
4. Result name
5. Category / secondary metadata
6. Keyboard hints
```

### AI Mode

``` text
1. User question
2. AI Answer
3. Code/content
4. Sources
5. Follow-up input
6. Keyboard hints
```

------------------------------------------------------------------------

# 20. JANGAN DILAKUKAN

Jangan:

-   Membuat sidebar permanen.
-   Membuat dashboard dengan banyak panel.
-   Menampilkan detail pane aplikasi secara default.
-   Membuat setiap search result menjadi card besar.
-   Menambahkan terlalu banyak tombol.
-   Menampilkan local apps/files di AI Mode.
-   Mengubah AI Mode menjadi aplikasi chat penuh.
-   Menggunakan terlalu banyak warna.
-   Menggunakan animasi berat.
-   Mengorbankan kecepatan hanya demi visual.

------------------------------------------------------------------------

# 21. PRINSIP IMPLEMENTASI

Redesign ini adalah **UI/UX upgrade**, bukan rewrite besar.

Pertahankan sebanyak mungkin:

-   Search engine.
-   Provider.
-   Ranking.
-   Best Match logic.
-   Keyboard navigation.
-   Context menu/actions.
-   AI generation pipeline.
-   Sources.
-   Streaming lifecycle.
-   Follow-up history.

Prioritas implementasi:

1.  Perbaiki struktur layout.
2.  Pisahkan Search Mode dan AI Mode secara visual dan fungsional.
3.  Tambahkan category filter horizontal.
4.  Sederhanakan search result list.
5.  Perbaiki Best Match hierarchy.
6.  Redesign AI answer view.
7.  Tambahkan adaptive sizing.
8.  Polish keyboard hints, focus states, hover states, dan transitions.

------------------------------------------------------------------------

# 22. DEFINISI HASIL AKHIR

Hasil akhir harus terasa seperti:

> **A fast, modern, advanced desktop search tool with a separate AI
> answer mode.**

Bukan:

> Dashboard.

Bukan:

> File manager.

Bukan:

> Chat application.

Bukan:

> Complex command center.

Kata kunci desain:

**Minimal · Fast · Focused · Keyboard-first · Modern · Advanced**
