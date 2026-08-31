# Implementation Comment — Context Action Menu

Implementasikan fitur **Context Action Menu** pada hasil Quick Search sebelum lanjut ke fitur AI.

Gunakan screenshot yang diberikan sebagai referensi visual. Yang dimaksud adalah **popup context menu kecil seperti menu aplikasi Cinnamon**, BUKAN FAB berupa tombol-tombol melayang.

## 1. Behavior utama

Context menu hanya muncul ketika user melakukan:

```text
Right-click pada ICON result
        ↓
Context Action Menu
```

Jangan membuat right-click pada seluruh row.

Behavior existing harus tetap:

```text
Left click row
    ↓
activateRow()
    ├── app  → launch application
    └── file → open file
```

**Jangan mengubah existing left-click behavior.**

Right-click pada title/description/area row selain icon tidak melakukan apa-apa.

## 2. Application Context Menu

Untuk `result.type === "app"` tampilkan 4 action:

```text
┌─────────────────────────┐
│  [icon] Add to panel    │
│  [icon] Add to desktop  │
│  [icon] Add to favorites│
│  [icon] Uninstall       │
└─────────────────────────┘
```

Gunakan **icon native Cinnamon/GNOME/St.Icon**, jangan emoji.

### Add to panel
- Gunakan mekanisme native Cinnamon.
- Gunakan identity aplikasi dari `result.appId`.
- Ikuti mekanisme `panel-launchers@cinnamon.org` / `PANEL_LAUNCHER` seperti Cinnamon upstream.
- Jangan membuat fake action.
- Jangan menggunakan raw `sudo`, `apt`, atau shell command yang tidak diperlukan.

### Add to desktop
- Gunakan desktop entry aplikasi yang sudah ada.
- Ikuti mekanisme Cinnamon upstream.
- Gunakan `appInfo.get_filename()` bila tersedia.
- Destination menggunakan user desktop directory melalui API Cinnamon/FileUtils.
- Jangan membuat launcher berdasarkan title secara manual jika desktop entry asli tersedia.

### Add to favorites
- Gunakan Cinnamon `AppFavorites`.
- Identity harus `result.appId`, bukan title/executable.
- Jika sudah favorite:
  - label → `Remove from favorites`
  - icon → native non-starred icon.
- Jika belum:
  - label → `Add to favorites`
  - icon → native starred icon.

### Uninstall
- Hanya tampilkan jika uninstall memang tersedia.
- Check keberadaan `/usr/bin/cinnamon-remove-application`.
- Pastikan `appInfo.get_filename()` valid.
- Ikuti mekanisme Cinnamon upstream.
- Jika tidak supported → jangan tampilkan fake/disabled action.
- Jangan menggunakan `sudo`/raw package manager.

## 3. File Context Menu

Untuk `result.type === "file"` target UI:

```text
┌─────────────────────────┐
│  [folder] Open file location │
│  [panel]  Add to panel       │
│  [desktop] Add to desktop    │
│  [star]   Add to favorites   │
└─────────────────────────┘
```

Gunakan native symbolic icons:
- `Open file location` → folder/open-folder icon
- `Add to panel` → panel/launcher icon
- `Add to desktop` → desktop/computer icon
- `Add to favorites` → star icon

Jangan menggunakan emoji.

## 4. File — Open file location

Gunakan `result.path` dan native Gio API.

Jika path adalah file:
```text
file → get_parent() → open parent directory
```

Jika path adalah directory:
```text
directory → open directory itself
```

Gunakan default file manager melalui:
```js
Gio.AppInfo.launch_default_for_uri_async(...)
```

Jangan mengasumsikan file manager harus Nemo.

Jangan menggunakan `exec()`, `spawnCommandLine() + path`, shell interpolation, atau `eval()`.

Path dianggap **untrusted input**.

Harus aman untuk path seperti:
```text
/home/user/test file.txt
/home/user/a;b.txt
/home/user/$(whoami).txt
/home/user/`whoami`.txt
/home/user/"quoted".txt
unicode filename
```

Tidak boleh menjadi command injection.

Jika path tidak ada atau parent tidak tersedia:
- jangan crash
- return false/no-op atau tampilkan error ringan.

## 5. File — Add to desktop

Untuk file, boleh membuat `.desktop` launcher permanen di Desktop jika memang dibutuhkan.

Tetapi:
- jangan membuat temporary `.desktop` yang langsung dihapus.
- launcher harus valid dan persistent.
- gunakan Gio.File untuk path/URI.
- jangan melakukan shell interpolation terhadap path.
- escape desktop-entry fields dengan benar.
- launcher harus menunjuk ke file yang benar.

Jika environment/API Cinnamon tidak memungkinkan implementasi yang benar, jangan memalsukan keberhasilan.

## 6. File — Add to panel / favorites

**Jangan menganggap arbitrary file sama dengan Cinnamon application.**

Cinnamon `Add to panel` dan `Add to favorites` secara native berorientasi pada launcher/application identity.

Karena itu:
- jangan membuat `.desktop` temporary hanya agar action terlihat berhasil.
- jangan memasukkan arbitrary filesystem path sebagai fake application ID.
- jangan membuat action yang terlihat berhasil tetapi sebenarnya tidak persist.

Jika bisa dibuat dengan launcher `.desktop` yang valid dan persistent, gunakan mekanisme native yang benar.

Jika tidak didukung:
- hide/disable action secara aman,
- atau jelaskan limitation.

Prioritas:

```text
Native valid action
    >
Safe graceful limitation
    >
Fake/mock action ❌
```

## 7. Context Actions helper

Buat helper terpisah:

```text
providers/contextActions.js
```

API:

```js
getContextActions(result, env)
```

Return:

```js
[
    {
        id,
        label,
        iconName,
        enabled,
        run
    }
]
```

Action ditentukan **HANYA berdasarkan `result.type`**.

Expected:
```text
app  → application actions
file → file actions
web  → []
url  → []
calc → []
```

Helper sebisa mungkin pure/testable dengan dependency injection.

## 8. QuickSearchContextMenu UI

Di `applet.js`, buat component/helper terpisah:

```text
QuickSearchContextMenu
```

Jangan memasukkan seluruh logic menu langsung ke `_buildRow()`.

Gunakan custom `St.BoxLayout`, bukan `PopupMenu.PopupMenu`, agar konsisten dengan floating `St` UI existing.

Setiap action:
```text
St.Button
 ├── St.Icon
 └── St.Label
```

## 9. Right-click icon

Di `_buildRow()` pastikan icon reactive:

```js
icon.reactive = true;
```

Tambahkan handler:

```js
icon.connect("button-press-event", (actor, event) => {
    if (event.get_button() === 3) {
        this._showContextMenu(result, icon, event);
        return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
});
```

Pastikan:
- right-click icon → context menu
- right-click tidak memanggil `activateRow()`
- left-click tetap existing behavior.

## 10. Menu hanya satu instance

Gunakan:

```js
this._contextMenu
```

Jangan membuat popup baru setiap right-click tanpa membersihkan yang lama.

Jika right-click result lain saat menu terbuka:
- reuse menu
- replace actions
- reposition.

## 11. Positioning

Gunakan:
```js
icon.get_transformed_position()
icon.get_transformed_size()
```

Menu default muncul dekat icon.

Jika tidak cukup ruang di kanan, pindahkan ke kiri.

Clamp:
```text
x >= screen left
x + menu width <= screen right
y >= screen top
y + menu height <= screen bottom
```

Menu tidak boleh keluar layar.

Gunakan `raise_top()` atau equivalent sesuai actor hierarchy.

## 12. Visual styling

Tambahkan CSS saja, jangan merusak styling existing.

```css
.quicksearch-context-menu {
    background: rgba(36,39,46,0.97);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    padding: 6px;
}

.quicksearch-context-item {
    padding: 6px 10px;
    border-radius: 8px;
    spacing: 8px;
}

.quicksearch-context-item:hover,
.quicksearch-context-item:selected {
    background: rgba(255,255,255,0.14);
}
```

Menu harus compact, dark/translucent, rounded, shadow, icon kiri + label kanan, dan mirip screenshot.

## 13. Outside click

Jika context menu terbuka:

```text
click menu
    → action

click outside menu
    → hide context menu
    → Quick Search tetap terbuka
```

Jangan langsung `close()` Quick Search saat menu masih terbuka.

## 14. Escape priority

Jika context menu terbuka:

```text
Escape
 ↓
hide context menu
 ↓
Quick Search tetap terbuka
```

Jika menu tidak terbuka:

```text
Escape
 ↓
existing close()
```

## 15. Action click

```text
click action
 ↓
run()
 ↓
hide context menu
```

Jika action gagal:
- jangan crash applet
- gunakan error handling existing
- menu tetap ditutup setelah action attempt.

## 16. Lifecycle

Pada `close()` dan `on_applet_removed_from_panel()`:
- hide
- disconnect signals
- destroy context menu
- remove timeout/source IDs

Jangan ada orphan actor, dangling signal, atau timeout.

## 17. Security

Path/query adalah untrusted input.

Dilarang:
```js
eval(...)
exec(...)
exec("..." + path)
spawnCommandLine("..." + path)
shell command interpolation
```

Gunakan:
- Gio.File
- Gio.AppInfo
- native Cinnamon APIs
- argv arrays bila subprocess benar-benar diperlukan.

Jangan gunakan `sudo apt ...`.

## 18. Tests

Buat:

```text
tests/context-actions.test.js
```

Test minimal:

### Application
- app → correct actions
- native icon names
- appId digunakan

### File
- file → correct actions
- open_location
- native icon names

### Type isolation
- app → tidak mendapat open_location
- file → tidak mendapat uninstall
- web/url/calc → []

### Favorites
- not favorite → Add to favorites
- favorite → Remove from favorites

### Security
Test path:
```text
/home/user/test file.txt
/home/user/a;b.txt
/home/user/$(whoami).txt
/home/user/`whoami`.txt
/home/user/"quoted".txt
```

Pastikan tidak menjadi shell command.

### UI behavior
Jika memungkinkan:
- right-click icon → context menu
- right-click title → no context menu
- left-click row → activateRow
- right-click → activateRow NOT called
- Escape with menu → menu closes only
- Escape without menu → Quick Search closes
- right-click another result → menu reused/repositioned
- screen edge → menu remains visible

## 19. Regression

Jalankan:

```bash
node --check applet.js
node --check result.js
node --check providers/appProvider.js
node --check providers/fileProvider.js
node --check providers/contextActions.js
node --test
```

Security scan:

```bash
grep -R "eval\|exec(\|shell.*interpol" --include="*.js" .
```

Review hasil grep manual agar false positive tidak dianggap bug.

## 20. Jangan merusak Phase 15

Fitur ini adalah **UI/action layer tambahan**.

Jangan mengubah:
- result.js
- searchEngine.js
- ranking
- scoring
- dedupe
- Best Match
- keyboard navigation
- selection preservation
- searchbox
- search layout
- app search
- file search backend
- web search

Jangan mengubah `_sortedResults`, `_syncSelection`, `activateRow()`, atau `processResults()` kecuali benar-benar diperlukan untuk integrasi event dan behavior existing tetap sama.

## 21. Files

New:
```text
providers/contextActions.js
tests/context-actions.test.js
```

Modify:
```text
applet.js
stylesheet.css
```

Minimal modification:
```text
providers/appProvider.js
providers/fileProvider.js
```

Read-only bila memungkinkan:
```text
result.js
searchEngine.js
```

## 22. Live verification

Setelah unit/regression test hijau:

```text
Super+F
 ↓
ketik "files"
 ↓
right-click icon application
 ↓
context menu muncul
 ↓
4 action sesuai application
```

Test action yang tersedia:
- Add to panel
- Add to desktop
- Add/remove favorites
- Uninstall

Kemudian:

```text
search file
 ↓
right-click icon file
 ↓
context menu muncul
 ↓
Open file location
```

Pastikan parent directory dibuka menggunakan default file manager.

Test juga:
- Escape
- click outside
- left-click
- right-click icon lain
- screen edge positioning
- searchbox tetap sama
- ranking tetap sama
- keyboard navigation tetap sama.

## 23. Acceptance criteria

### Application

Right-click icon → context menu 4 item → native icons → Cinnamon actions.

Left click tetap launch.

### File

Right-click icon → file context menu → Open file location → default file manager membuka lokasi yang benar.

Action file lainnya hanya digunakan jika implementasinya benar-benar valid/persistent.

### UI

Menu:
- compact
- dark
- rounded
- shadow
- icon kiri
- label kanan
- muncul dekat icon
- tidak mengubah layout Quick Search.

## 24. Final report

Setelah selesai laporkan:

1. File yang diubah.
2. Perubahan setiap file.
3. API Cinnamon/Gio yang digunakan.
4. Action yang benar-benar supported.
5. Action yang memiliki limitation dan alasannya.
6. Hasil `node --check`.
7. Hasil `node --test`.
8. Hasil security scan.
9. Hasil live Cinnamon verification.
10. Konfirmasi Phase 15 ranking/Best Match/selection/search behavior tidak berubah.

Jika action Cinnamon tidak bisa dilakukan secara native pada environment saat ini, **jangan membuat workaround palsu**. Jelaskan limitation tersebut dan pertahankan behavior yang aman.
