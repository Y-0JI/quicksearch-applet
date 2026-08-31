# Comment — Implement Context Action Menu

Implementasikan **Context Action Menu** pada hasil Quick Search sebelum lanjut ke fitur AI.

## Referensi UI

Gunakan screenshot yang diberikan sebagai referensi visual. Behavior yang diinginkan adalah **popup context menu kecil seperti menu aplikasi Cinnamon**, bukan FAB berupa tombol melayang.

Menu muncul ketika user **klik kanan pada icon result**.

## 1. Application result

Untuk `result.type === "app"`, tampilkan:

```text
┌─────────────────────────┐
│  +   Add to panel       │
│  🖥   Add to desktop    │
│  ☆   Add to favorites   │
│  🗑   Uninstall         │
└─────────────────────────┘
```

Gunakan **icon native Cinnamon/GNOME/St.Icon** yang tersedia, **jangan emoji**.

Action:

- **Add to panel** → gunakan mekanisme Cinnamon yang benar untuk menambahkan aplikasi ke panel.
- **Add to desktop** → buat/gunakan launcher desktop yang valid.
- **Add to favorites** → tambahkan aplikasi ke favorites Cinnamon.
- **Uninstall** → gunakan mekanisme uninstall/package-manager yang sudah didukung sistem; jangan menggunakan shell command yang tidak aman.

`appProvider` saat ini sudah menyediakan `appId` dan objek Cinnamon app, jadi manfaatkan data yang sudah ada. Jangan merombak provider kalau tidak diperlukan.

## 2. File result

Untuk `result.type === "file"`, tampilkan:

```text
┌─────────────────────────┐
│  📂  Open file location │
│  🖥  Add to panel       │
│  🖥  Add to desktop     │
│  ☆   Add to favorites   │
└─────────────────────────┘
```

Gunakan **icon native yang sesuai dengan action**, bukan emoji:

- `Open file location` → folder/open-folder icon.
- `Add to panel` → panel/launcher icon.
- `Add to desktop` → desktop/computer icon.
- `Add to favorites` → star icon.

Action pertama harus benar-benar bekerja menggunakan `Gio.File` / native Cinnamon API.

File provider saat ini sudah membawa `path`, jadi gunakan `result.path`. Jangan melakukan shell concatenation atau `exec("...")`.

## 3. Trigger

**Hanya klik kanan pada icon result** yang membuka context menu.

Jangan mengubah behavior:

```text
Left click row → existing action
```

Tetap:

```text
App  → launch application
File → open file
```

Klik kanan pada title/description row tidak perlu membuka menu.

## 4. UI

Context menu harus:

- dark/translucent mengikuti UI Quick Search sekarang
- rounded corners
- shadow
- compact seperti screenshot
- icon di kiri
- text di kanan
- spacing konsisten
- muncul dekat icon yang diklik
- tidak mengubah ukuran/posisi searchbox
- tidak mengubah layout result yang sekarang
- menu harus berada di atas result layer (`raise_top()` bila diperlukan)
- klik di luar menu → menu ditutup
- Escape → menu ditutup
- setelah action dijalankan → menu ditutup

Tambahkan hover state yang konsisten dengan existing `.quicksearch-row-selected`.

## 5. Arsitektur

Jangan memasukkan seluruh logic menu ke `_buildRow()`.

Buat helper/component terpisah, misalnya:

```text
QuickSearchContextMenu
```

atau helper yang setara.

Struktur yang diharapkan:

```text
_buildRow()
   │
   ├── normal click
   │      └── activateRow()
   │
   └── icon right-click
          └── showContextMenu(result)
                    │
                    ├── app actions
                    └── file actions
```

Context menu harus menentukan action berdasarkan:

```js
result.type
```

Jangan menggunakan title/description untuk menentukan jenis result.

## 6. Jangan merusak Phase 15

**Jangan mengubah logic berikut kecuali benar-benar diperlukan:**

- global ranking / Best Match
- `processResults`
- scoring
- dedupe
- keyboard navigation
- selection preservation
- search engine
- app provider search logic
- file search backend
- searchbox size/position
- existing left-click behavior

Fitur ini adalah **UI/action layer tambahan**.

## 7. Testing wajib

Setelah implementasi:

```bash
node --check applet.js
node --check result.js
node --check providers/appProvider.js
node --check providers/fileProvider.js
node --test
```

Tambahkan test untuk logic yang bisa dites tanpa Cinnamon UI, terutama:

- app menghasilkan action menu yang benar
- file menghasilkan action menu yang benar
- `type === "app"` tidak mendapatkan file action
- `type === "file"` tidak mendapatkan uninstall action
- path file tetap aman
- tidak ada shell injection
- existing result/action behavior tidak berubah

Lakukan juga grep/security scan untuk memastikan implementasi baru tidak memasukkan `eval`, shell interpolation, unsafe `exec`, atau command construction dari user-controlled path.

## Acceptance criteria

### Application

> Klik kanan icon → muncul 4-item context menu → semua action menggunakan icon native → menu bisa ditutup → existing left click tetap launch.

### File

> Klik kanan icon → muncul 4-item context menu → `Open file location` benar-benar membuka parent location → action lainnya menggunakan mekanisme Cinnamon yang valid → existing left click tetap open file.

### UI

> Menu terlihat seperti context menu pada screenshot, bukan FAB besar dan bukan menu GTK default yang mengubah layout Quick Search.

## Laporan setelah implementasi

Setelah selesai, laporkan:

1. File yang diubah.
2. Alasan setiap perubahan.
3. Hasil seluruh test.
4. Hasil security/grep scan.
5. Potensi limitation khusus action Cinnamon:
   - Add to panel
   - Add to desktop
   - Add to favorites
   - Uninstall
6. Jika ada action yang tidak bisa dibuat 100% native pada environment Cinnamon saat ini, jelaskan penyebabnya dan jangan membuat fake/mock action.
