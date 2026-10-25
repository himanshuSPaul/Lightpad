# Lightpad

A lightweight, Notepad++-style text editor with a built-in terminal. Built with
[Tauri 2](https://tauri.app) (Rust + the OS webview), CodeMirror 6 and xterm.js.
The release binary is about 4 MB.

## Features

- Tabs, open / save / save as, recent files, drag-and-drop to open
- Syntax highlighting (JS/TS, Python, HTML, CSS, JSON, Markdown, Rust, C/C++, Java, XML, SQL)
- Line numbers, find/replace (Ctrl+F), word wrap, light/dark theme
- Keeps CRLF/LF line endings as found in the file
- Remembers open tabs, including unsaved edits, between runs
- Terminal panel with real shells (cmd on Windows, your login shell on macOS/Linux),
  multiple terminals, opens in the current file's folder, resizable

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+N / Ctrl+O | New / Open |
| Ctrl+S / Ctrl+Shift+S | Save / Save As |
| Ctrl+W, middle-click tab | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+F | Find and replace |
| Alt+Z | Toggle word wrap |
| Ctrl+` | Show / hide terminal |
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

## Layout

- `src/main.js` – tabs, files, toolbar, shortcuts, session restore
- `src/terminal.js` – xterm.js terminal panel
- `src/languages.js` – file extension to syntax highlighting
- `src-tauri/src/lib.rs` – file read/write commands
- `src-tauri/src/pty.rs` – shell sessions on a real pseudo-terminal (ConPTY on Windows)
