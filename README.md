# Lightpad

A lightweight, Notepad++-style text editor with a built-in terminal. Built with
[Tauri 2](https://tauri.app) (Rust + the OS webview), CodeMirror 6 and xterm.js.
The release binary is about 4 MB.

![Lightpad](docs/screenshots/03-overview.png)

See the **[user guide](docs/USER_GUIDE.md)** for a tour of every menu and feature, with screenshots.

## Download

Get the latest installer from the [Releases page](https://github.com/himanshuSPaul/Lightpad/releases/latest):

- `Lightpad_x.y.z_x64-setup.exe` or `Lightpad_x.y.z_x64_en-US.msi`: Windows installer
- `Lightpad-portable-windows-x64.zip`: Windows, no install, just unzip and run `lightpad.exe`
- `.dmg` for macOS, `.AppImage` or `.deb` for Linux

To make a new release, bump `version` in `src-tauri/tauri.conf.json`, then push a tag:
`git tag v0.1.1 && git push origin v0.1.1`. The build attaches the installers to the release.

## Features

- File explorer sidebar: open a folder, expand folders, click a file to open it.
  Right-click for New File/Folder, Cut, Copy, Paste, Rename (F2), Delete (to the Recycle Bin),
  Copy Path, Copy Relative Path, Open in Terminal, Save, Save As, Pin Tab and Close
- Tabs, open / save / save as, recent files, drag-and-drop files or folders to open
- Syntax highlighting for 140+ languages, picked automatically from the file name.
  Change it from the Language menu or by clicking the language in the status bar.
- Notepad++-style code folding (click the boxes in the margin, or View > Fold All / Fold Level)
- Document List pane (View > Document List) showing every open file
- Line numbers, find/replace (Ctrl+F), word wrap, light/dark theme
- Keeps CRLF/LF line endings and the file's encoding (UTF-8, UTF-8 BOM, UTF-16, Windows-1252)
- Saves are crash-safe: written to a temp file, then swapped in
- Remembers open tabs, including unsaved edits, between runs
- Terminal panel with real shells (cmd on Windows, your login shell on macOS/Linux),
  multiple terminals, opens in the current file's folder (or the open folder), resizable

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+N / Ctrl+O | New / Open file |
| Ctrl+Shift+O | Open folder |
| Ctrl+B | Show / hide explorer |
| Ctrl+Shift+L | Choose language |
| Ctrl+S / Ctrl+Shift+S | Save / Save As |
| Ctrl+W, middle-click tab | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+F | Find and replace |
| Alt+Z | Toggle word wrap |
| Ctrl+` / Ctrl+Shift+` | Show / hide terminal, new terminal |
| Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+mouse wheel | Zoom in / out / reset the editor or terminal (whichever has focus, or is under the mouse) |
| Ctrl+H / Ctrl+G / Ctrl+/ | Replace, go to line, toggle comment |
| Ctrl+Alt+S | Save all |
| Alt+0 / Alt+Shift+0 | Fold all / unfold all |
| Alt+1..8 / Alt+Shift+1..8 | Fold / unfold a level |
| Ctrl+Alt+F / Ctrl+Alt+Shift+F | Fold / unfold the current block |
| Alt+F, Alt+E, Alt+V, Alt+L, Alt+T | Open the File, Edit, View, Language, Terminal menus |
| Ctrl+Shift+C / V | Copy / paste in terminal |

## Build and run

Prerequisites: [Node.js 18+](https://nodejs.org), [Rust](https://rustup.rs), and the
[Tauri system prerequisites](https://tauri.app/start/prerequisites/) for your OS
(on Windows: Microsoft C++ Build Tools and WebView2, which Windows 10/11 already has).

```sh
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # installer in src-tauri/target/release/bundle/
```

## Tests and checks

```sh
cargo test --manifest-path src-tauri/Cargo.toml   # file encoding and safe-save tests
npm audit                                         # JS dependency advisories
cargo audit --file src-tauri/Cargo.lock           # Rust dependency advisories (cargo install cargo-audit)
```

`.github/workflows/build.yml` runs all of these and builds Windows, macOS and Linux
installers on every push once the code is on GitHub.

## Layout

- `src/main.js` – tabs, files, toolbar, shortcuts, session restore
- `src/explorer.js` – folder tree sidebar
- `src/folding.js` – code folding (fold boxes, bracket folding, fold levels)
- `src/menu.js` – the menu bar
- `src/terminal.js` – xterm.js terminal panel
- `src/languages.js` – language list (CodeMirror language-data plus Windows batch files)
- `src-tauri/src/lib.rs` – app setup and folder listing
- `src-tauri/src/fsops.rs` – explorer file operations (never overwrite; delete goes to the Recycle Bin)
- `src-tauri/src/files.rs` – reading and saving files (encodings, crash-safe saves, size limit)
- `src-tauri/src/pty.rs` – shell sessions on a real pseudo-terminal (ConPTY on Windows)
