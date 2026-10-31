# Release log

## v0.1.1 (2026-10-31)

### New
- **Switch between open files from the keyboard.** Ctrl+Tab goes back to the file you used
  before, like Alt+Tab. Hold Ctrl and tap Tab to pick from a list of open files, most recently
  used first, then let go of Ctrl to open it. Ctrl+Shift+Tab moves up the list and Escape cancels.
- **Ctrl+PgDn / Ctrl+PgUp** go to the next or previous tab. **Ctrl+1 to Ctrl+8** open that tab, and
  **Ctrl+9** opens the last one.
- **Window menu** (Alt+W) listing every open file.
- **Changes made by other programs are noticed.** When you switch back to Lightpad, a file
  without unsaved edits reloads by itself. If it has unsaved edits, Lightpad asks first. Saving
  over a file that changed on disk also asks first.

### Fixed
- Rename, New File and New Folder did nothing on Windows: pressing Enter cancelled the name box.
- Saving silently overwrote changes another program had made to the same file.
- On Linux, renaming `a.txt` to `A.txt` overwrote an existing `A.txt`.
- Copying a folder that contains a link to itself recursed and left a half-made copy.
  Links are now copied as links.
- Delete left the deleted file's tab open, and the explorer still listed the file.
- In the terminal, Ctrl+W, Ctrl+B, Ctrl+N and Ctrl+O now reach the shell. Before, they closed tabs,
  hid the explorer, and so on.
- Typing an extension in the language picker (`rs`) now picks that language (Rust) first.
- Opening a folder in the explorer as the window regained focus could close it again.
- A very large unsaved file no longer stops the session (open tabs) from being saved.
- Copy Relative Path gave a wrong path for folders with similar names (`app` and `app2`).
- A failed save of a read-only file on Windows could leave a hidden temp file behind.
- One busy terminal could freeze typing in the other terminals.

### Testing
- 68 automated end-to-end tests drive the real app (in `tests/e2e`), plus Rust unit tests and
  dependency security audits on every build.

## v0.1.0 (2026-10-26)

First release: a lightweight Notepad++-style editor with a file explorer, Document List, syntax
highlighting for 140+ languages, Notepad++-style folding, find and replace, encodings
(UTF-8, UTF-8 BOM, UTF-16, Windows-1252), crash-safe saves, session restore, a built-in terminal,
and separate zoom for the editor and the terminal.
