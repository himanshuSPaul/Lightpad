import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab, undo, redo, selectAll, toggleComment } from "@codemirror/commands";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { LANGUAGES, detectLanguage, languageByName, loadLanguage } from "./languages.js";
import * as terminal from "./terminal.js";
import * as explorer from "./explorer.js";
import { createMenubar } from "./menu.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem("lightpad." + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem("lightpad." + k, JSON.stringify(v));
    } catch {}
  },
};

const settings = {
  theme: store.get("theme", "dark"),
  wrap: store.get("wrap", false),
  sidebar: store.get("sidebar", true),
  editorFont: store.get("editorFont", 14),
  termFont: store.get("termFont", 13),
};
const DEFAULT_FONT = { editor: 14, terminal: 13 };
const langConf = new Compartment();
const themeConf = new Compartment();
const wrapConf = new Compartment();

let tabs = [];
let current = null;
let untitledCount = 0;
let nextTabId = 1;

// ---------- Editor ----------

const view = new EditorView({ parent: $("editor") });

function makeState(text) {
  return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        langConf.of([]),
        themeConf.of(settings.theme === "dark" ? oneDark : []),
        wrapConf.of(settings.wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            renderTabs();
            saveSessionSoon();
          }
          if (u.docChanged || u.selectionSet) renderStatus();
        }),
      ],
    });
}

// Sets a tab's syntax highlighting. `manual` marks a choice made from the Language menu.
async function setLanguage(tab, desc, manual = false) {
  tab.lang = desc.name;
  tab.langManual = manual;
  if (tab === current) renderStatus();
  const support = await loadLanguage(desc).catch(() => []);
  if (tab.lang !== desc.name) return; // changed again while loading
  const effects = langConf.reconfigure(support);
  if (tab === current) view.dispatch({ effects });
  else tab.state = tab.state.update({ effects }).state;
  saveSessionSoon();
}

const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, "");
const tabState = (t) => (t === current ? view.state : t.state);
const isDirty = (t) => !tabState(t).doc.eq(t.saved);

function newTab({ path = null, text = "", saved = text, lang = null, encoding = "UTF-8" } = {}) {
  const tab = {
    id: nextTabId++,
    path,
    name: path ? baseName(path) : `new ${++untitledCount}`,
    state: makeState(text),
    lang: null,
    saved: EditorState.create({ doc: saved }).doc,
    eol: /\r\n/.test(saved) ? "\r\n" : "\n",
    encoding,
  };
  tabs.push(tab);
  const chosen = lang && languageByName(lang);
  setLanguage(tab, chosen || detectLanguage(path), !!chosen);
  return tab;
}

function activate(tab) {
  if (current) current.state = view.state;
  current = tab;
  view.setState(tab.state);
  // Settings may have changed while this tab was in the background.
  view.dispatch({
    effects: [
      themeConf.reconfigure(settings.theme === "dark" ? oneDark : []),
      wrapConf.reconfigure(settings.wrap ? EditorView.lineWrapping : []),
    ],
  });
  renderTabs();
  renderStatus();
  explorer.setActive(tab.path);
  view.focus();
  saveSessionSoon();
}

// ---------- Files ----------

async function openPath(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) return activate(existing);
  let file;
  try {
    file = await invoke("read_file", { path });
  } catch (e) {
    return showError(`Could not open ${baseName(path)}`, e);
  }
  // Replace a single empty untitled tab, like Notepad++ does.
  if (tabs.length === 1 && current && !current.path && view.state.doc.length === 0) {
    tabs = [];
    current = null;
  }
  activate(newTab({ path, text: file.text, encoding: file.encoding }));
  addRecent(path);
}

async function openFiles() {
  const picked = await openDialog({ multiple: true, defaultPath: current?.path ? dirName(current.path) : undefined });
  if (!picked) return;
  for (const p of [].concat(picked)) await openPath(p);
}

async function openFolder() {
  const dir = await openDialog({ directory: true, defaultPath: explorer.getRoot() || undefined });
  if (!dir) return;
  await explorer.setRoot(dir);
  explorer.setActive(current?.path);
  toggleSidebar(true);
  saveSessionSoon();
}

// Where new terminals start: the current file's folder, else the open folder.
const workingDir = () => (current?.path ? dirName(current.path) : explorer.getRoot());

async function save(tab = current, forceDialog = false) {
  let path = tab.path;
  if (!path || forceDialog) {
    path = await saveDialog({ defaultPath: tab.path || tab.name + ".txt" });
    if (!path) return false;
  }
  const state = tabState(tab);
  const text = state.doc.toJSON().join(tab.eol);
  try {
    await invoke("write_file", { path, contents: text, encoding: tab.encoding });
  } catch (e) {
    showError(`Could not save ${baseName(path)}`, e);
    return false;
  }
  tab.saved = state.doc;
  if (path !== tab.path) {
    tab.path = path;
    tab.name = baseName(path);
    if (!tab.langManual) setLanguage(tab, detectLanguage(path));
  }
  addRecent(path);
  renderTabs();
  renderStatus();
  saveSessionSoon();
  return true;
}

function showError(title, err) {
  message(String(err), { title, kind: "error" }).catch(() => {});
}

async function closeTab(tab) {
  if (isDirty(tab)) {
    const answer = await message(`Do you want to save the changes to ${tab.name}?`, {
      title: "Lightpad",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
    if (answer === "Cancel") return;
    if ((answer === "Yes" || answer === "Save") && !(await save(tab))) return;
  }
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (tab === current) {
    current = null;
    activate(tabs[Math.min(i, tabs.length - 1)] || newTab());
  } else {
    renderTabs();
    saveSessionSoon();
  }
}

function addRecent(path) {
  const list = store.get("recent", []).filter((p) => p !== path);
  list.unshift(path);
  store.set("recent", list.slice(0, 15));
}

// ---------- Session (restores open tabs, including unsaved edits) ----------

let sessionTimer;
function saveSessionSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 400);
}

function saveSession() {
  if (current) current.state = view.state;
  store.set("session", {
    folder: explorer.getRoot(),
    expanded: explorer.getExpanded(),
    active: tabs.indexOf(current),
    tabs: tabs.map((t) => ({
      path: t.path,
      name: t.name,
      content: isDirty(t) ? t.state.doc.toString() : null,
      lang: t.langManual ? t.lang : null,
    })),
  });
}

async function restoreSession() {
  const s = store.get("session", null);
  if (s?.folder) await explorer.setRoot(s.folder, s.expanded || []);
  else explorer.render();
  if (s?.tabs?.length) {
    for (const t of s.tabs) {
      if (t.path) {
        let file = null;
        try {
          file = await invoke("read_file", { path: t.path });
        } catch {}
        if (file === null && t.content === null) continue; // file is gone
        const saved = file?.text ?? "";
        newTab({ path: t.path, text: t.content ?? saved, saved, lang: t.lang, encoding: file?.encoding });
      } else {
        const tab = newTab({ text: t.content ?? "", saved: "", lang: t.lang });
        tab.name = t.name || tab.name;
      }
    }
    untitledCount = Math.max(0, ...tabs.map((t) => +(/^new (\d+)$/.exec(t.name)?.[1] || 0)));
  }
  activate(tabs[s?.active] || tabs[0] || newTab());
}

// ---------- UI ----------

function renderTabs() {
  const bar = $("tabs");
  bar.replaceChildren(
    ...tabs.map((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t === current ? " active" : "") + (isDirty(t) ? " dirty" : "");
      el.title = t.path || t.name;
      el.onmousedown = (e) => {
        if (e.button === 1) return closeTab(t), e.preventDefault();
        if (e.button === 0) activate(t);
      };
      const label = document.createElement("span");
      label.textContent = t.name;
      const x = document.createElement("button");
      x.className = "close";
      x.textContent = "×";
      x.onmousedown = (e) => e.stopPropagation();
      x.onclick = () => closeTab(t);
      el.append(label, x);
      return el;
    })
  );
  bar.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (current) {
    getCurrentWindow()
      .setTitle(`${isDirty(current) ? "*" : ""}${current.path || current.name} - Lightpad`)
      .catch(() => {});
  }
}

function renderStatus() {
  if (!current) return;
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const chosen = sel.empty ? "" : `  Sel ${sel.to - sel.from}`;
  $("st-pos").textContent = `Ln ${line.number}, Col ${sel.head - line.from + 1}${chosen}`;
  $("st-lang").textContent = current.lang;
  $("st-eol").textContent = current.eol === "\r\n" ? "CRLF" : "LF";
  $("st-enc").textContent = current.encoding;
  $("st-path").textContent = current.path || "";
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  view.dispatch({ effects: themeConf.reconfigure(settings.theme === "dark" ? oneDark : []) });
  terminal.setTerminalTheme(settings.theme);
}

function toggleWrap() {
  settings.wrap = !settings.wrap;
  store.set("wrap", settings.wrap);
  view.dispatch({ effects: wrapConf.reconfigure(settings.wrap ? EditorView.lineWrapping : []) });
}

// ---------- Zoom (editor and terminal are zoomed separately) ----------

let lastPane = "editor";
$("editor").addEventListener("focusin", () => (lastPane = "editor"));
$("terminal-panel").addEventListener("focusin", () => (lastPane = "terminal"));

function applyZoom() {
  document.documentElement.style.setProperty("--editor-font-size", settings.editorFont + "px");
  view.requestMeasure();
  terminal.setTerminalFontSize(settings.termFont);
  const pct = (px, def) => Math.round((px / def) * 100) + "%";
  const ed = settings.editorFont !== DEFAULT_FONT.editor ? `Editor ${pct(settings.editorFont, DEFAULT_FONT.editor)}` : "";
  const te = settings.termFont !== DEFAULT_FONT.terminal ? `Terminal ${pct(settings.termFont, DEFAULT_FONT.terminal)}` : "";
  $("st-zoom").textContent = [ed, te].filter(Boolean).join(" · ");
}

// step: +1 / -1 to zoom, 0 to restore the default size.
function zoom(pane, step) {
  const key = pane === "terminal" ? "termFont" : "editorFont";
  settings[key] = step === 0 ? DEFAULT_FONT[pane] : Math.max(8, Math.min(40, settings[key] + step));
  store.set(key, settings[key]);
  applyZoom();
}

// Ctrl+mouse wheel zooms the pane under the mouse.
for (const [id, pane] of [["editor", "editor"], ["term-hosts", "terminal"]]) {
  $(id).addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      zoom(pane, e.deltaY < 0 ? 1 : -1);
    },
    { passive: false, capture: true }
  );
}

function showTerminalPanel(show) {
  $("terminal-panel").hidden = !show;
  $("resizer").hidden = !show;
}

async function toggleTerminal(force) {
  const show = force ?? $("terminal-panel").hidden;
  showTerminalPanel(show);
  if (!show) return view.focus();
  if (!terminal.hasTerminals()) await terminal.newTerminal(workingDir());
  else {
    terminal.fitActive();
    terminal.focusTerminal();
  }
}

function toggleSidebar(force) {
  settings.sidebar = force ?? !settings.sidebar;
  store.set("sidebar", settings.sidebar);
  $("sidebar").hidden = !settings.sidebar;
  $("side-resizer").hidden = !settings.sidebar;
}

// Language picker: type to filter, Enter or click to apply to the current tab.
const picker = $("lang-picker");
const pickerInput = $("lang-filter");
const pickerList = $("lang-list");

function renderLanguageList() {
  const q = pickerInput.value.trim().toLowerCase();
  const matches = LANGUAGES.filter(
    (l) => !q || l.name.toLowerCase().includes(q) || l.extensions.some((e) => e.toLowerCase() === q.replace(/^\./, ""))
  );
  pickerList.replaceChildren(
    ...matches.map((l, i) => {
      const li = document.createElement("li");
      li.textContent = l.name;
      if (l.extensions.length) {
        const ext = document.createElement("small");
        ext.textContent = l.extensions.slice(0, 4).map((e) => "." + e).join(" ");
        li.append(ext);
      }
      if (l.name === current.lang) li.classList.add("current");
      if (i === 0 && q) li.classList.add("sel");
      li.onclick = () => chooseLanguage(l);
      li._lang = l;
      return li;
    })
  );
  (pickerList.querySelector(".sel") || pickerList.querySelector(".current"))?.scrollIntoView({ block: "nearest" });
}

function chooseLanguage(l) {
  picker.hidden = true;
  setLanguage(current, l, true);
  view.focus();
}

function openLanguagePicker() {
  picker.hidden = false;
  pickerInput.value = "";
  renderLanguageList();
  pickerInput.focus();
}

pickerInput.oninput = renderLanguageList;
pickerInput.onkeydown = (e) => {
  const items = [...pickerList.children];
  let i = items.findIndex((li) => li.classList.contains("sel"));
  if (e.key === "Escape") {
    picker.hidden = true;
    view.focus();
  } else if (e.key === "Enter" && items[Math.max(i, 0)]) {
    chooseLanguage(items[Math.max(i, 0)]._lang);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[i]?.classList.remove("sel");
    i = Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    items[i]?.classList.add("sel");
    items[i]?.scrollIntoView({ block: "nearest" });
  }
};
picker.onclick = (e) => e.stopPropagation();
document.addEventListener("click", () => (picker.hidden = true));
$("st-lang").onclick = (e) => {
  e.stopPropagation();
  openLanguagePicker();
};

const commands = {
  language: openLanguagePicker,
  new: () => activate(newTab()),
  open: openFiles,
  openFolder,
  explorer: () => toggleSidebar(),
  refreshTree: () => explorer.render(),
  collapseTree: () => explorer.collapseAll(),
  save: () => save(),
  saveAs: () => save(current, true),
  find: () => openSearchPanel(view),
  wrap: toggleWrap,
  theme: () => {
    settings.theme = settings.theme === "dark" ? "light" : "dark";
    store.set("theme", settings.theme);
    applyTheme();
  },
  terminal: () => toggleTerminal(),
};

document.querySelectorAll("[data-cmd]").forEach((b) => (b.onclick = () => commands[b.dataset.cmd]()));

function newTerminalHere() {
  showTerminalPanel(true);
  terminal.newTerminal(workingDir());
}
$("term-new").onclick = newTerminalHere;
$("term-close-panel").onclick = () => toggleTerminal(false);

// ---------- Menu bar ----------

const editorCmd = (fn) => () => {
  view.focus();
  fn(view);
};

async function saveAll() {
  for (const t of [...tabs]) if (isDirty(t) && !(await save(t))) return;
}

async function closeAll() {
  for (const t of [...tabs]) {
    const before = tabs.length;
    await closeTab(t);
    if (tabs.length === before) return; // cancelled
  }
}

function openReplace() {
  openSearchPanel(view);
  requestAnimationFrame(() => document.querySelector(".cm-search input[name=replace]")?.focus());
}

async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    view.focus();
    view.dispatch(view.state.replaceSelection(text));
  } catch {
    showError("Paste", "Use Ctrl+V to paste.");
  }
}

function copy(cut) {
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) return view.focus();
  navigator.clipboard.writeText(ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n")).catch(() => {});
  if (cut) view.dispatch(view.state.replaceSelection(""));
  view.focus();
}

const MENU_LANGUAGES = [
  "Plain Text", "Batch File", "C", "C#", "C++", "CSS", "Go", "HTML", "Java", "JavaScript", "JSON", "Markdown",
  "PHP", "PowerShell", "Python", "Ruby", "Rust", "Shell", "SQL", "TypeScript", "XML", "YAML",
];

createMenubar([
  {
    label: "File",
    items: () => {
      const recent = store.get("recent", []);
      return [
        { label: "New", shortcut: "Ctrl+N", run: commands.new },
        { label: "Open File...", shortcut: "Ctrl+O", run: commands.open },
        { label: "Open Folder...", shortcut: "Ctrl+Shift+O", run: commands.openFolder },
        {
          label: "Open Recent",
          submenu: () =>
            recent.length
              ? [...recent.map((p) => ({ label: p, run: () => openPath(p) })), "-", { label: "Clear Recent Files", run: () => store.set("recent", []) }]
              : [{ label: "No recent files", disabled: true }],
        },
        "-",
        { label: "Save", shortcut: "Ctrl+S", run: commands.save },
        { label: "Save As...", shortcut: "Ctrl+Shift+S", run: commands.saveAs },
        { label: "Save All", shortcut: "Ctrl+Alt+S", run: saveAll },
        "-",
        { label: "Close Tab", shortcut: "Ctrl+W", run: () => closeTab(current) },
        { label: "Close All", run: closeAll },
        "-",
        { label: "Exit", shortcut: "Alt+F4", run: () => getCurrentWindow().close() },
      ];
    },
  },
  {
    label: "Edit",
    items: () => [
      { label: "Undo", shortcut: "Ctrl+Z", run: editorCmd(undo) },
      { label: "Redo", shortcut: "Ctrl+Y", run: editorCmd(redo) },
      "-",
      { label: "Cut", shortcut: "Ctrl+X", run: () => copy(true) },
      { label: "Copy", shortcut: "Ctrl+C", run: () => copy(false) },
      { label: "Paste", shortcut: "Ctrl+V", run: paste },
      { label: "Select All", shortcut: "Ctrl+A", run: editorCmd(selectAll) },
      "-",
      { label: "Find...", shortcut: "Ctrl+F", run: commands.find },
      { label: "Replace...", shortcut: "Ctrl+H", run: openReplace },
      { label: "Go to Line...", shortcut: "Ctrl+G", run: editorCmd(gotoLine) },
      "-",
      { label: "Toggle Comment", shortcut: "Ctrl+/", run: editorCmd(toggleComment) },
    ],
  },
  {
    label: "View",
    items: () => [
      { label: "Explorer", shortcut: "Ctrl+B", checked: settings.sidebar, run: commands.explorer },
      { label: "Terminal", shortcut: "Ctrl+`", checked: !$("terminal-panel").hidden, run: commands.terminal },
      "-",
      { label: "Word Wrap", shortcut: "Alt+Z", checked: settings.wrap, run: commands.wrap },
      { label: "Dark Theme", checked: settings.theme === "dark", run: commands.theme },
      "-",
      { label: "Zoom In (Ctrl+Mouse Wheel Up)", shortcut: "Ctrl+=", run: () => zoom("editor", 1) },
      { label: "Zoom Out (Ctrl+Mouse Wheel Down)", shortcut: "Ctrl+-", run: () => zoom("editor", -1) },
      { label: "Restore Default Zoom", shortcut: "Ctrl+0", run: () => zoom("editor", 0) },
    ],
  },
  {
    label: "Language",
    items: () => [
      ...MENU_LANGUAGES.map((name) => ({
        label: name,
        checked: current?.lang === name,
        run: () => chooseLanguage(languageByName(name)),
      })),
      "-",
      { label: "All Languages...", shortcut: "Ctrl+Shift+L", run: commands.language },
    ],
  },
  {
    label: "Terminal",
    items: () => [
      { label: "New Terminal", shortcut: "Ctrl+Shift+`", run: newTerminalHere },
      { label: "Show / Hide Terminal", shortcut: "Ctrl+`", run: commands.terminal },
      { label: "Close Terminal", run: () => terminal.closeActiveTerminal() },
      "-",
      { label: "Zoom In (Ctrl+Mouse Wheel Up)", shortcut: "Ctrl+=", run: () => zoom("terminal", 1) },
      { label: "Zoom Out (Ctrl+Mouse Wheel Down)", shortcut: "Ctrl+-", run: () => zoom("terminal", -1) },
      { label: "Restore Default Zoom", shortcut: "Ctrl+0", run: () => zoom("terminal", 0) },
    ],
  },
]);

// Drag the bar between editor and terminal to resize.
$("resizer").onpointerdown = (e) => {
  const panel = $("terminal-panel");
  const startY = e.clientY;
  const startH = panel.offsetHeight;
  e.target.setPointerCapture(e.pointerId);
  e.target.onpointermove = (m) => {
    const h = Math.max(80, Math.min(window.innerHeight - 160, startH - (m.clientY - startY)));
    panel.style.height = h + "px";
  };
  e.target.onpointerup = () => {
    e.target.onpointermove = null;
    store.set("termHeight", panel.offsetHeight);
  };
};
$("terminal-panel").style.height = store.get("termHeight", 240) + "px";

// Drag the bar beside the explorer to resize it.
$("side-resizer").onpointerdown = (e) => {
  const side = $("sidebar");
  const startX = e.clientX;
  const startW = side.offsetWidth;
  e.target.setPointerCapture(e.pointerId);
  e.target.onpointermove = (m) => {
    side.style.width = Math.max(140, Math.min(window.innerWidth - 300, startW + m.clientX - startX)) + "px";
  };
  e.target.onpointerup = () => {
    e.target.onpointermove = null;
    store.set("sidebarWidth", side.offsetWidth);
    terminal.fitActive();
  };
};
$("sidebar").style.width = store.get("sidebarWidth", 240) + "px";

// Global shortcuts
window.addEventListener(
  "keydown",
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    let cmd = null;
    if (ctrl && e.code === "Backquote") cmd = e.shiftKey ? newTerminalHere : commands.terminal;
    else if (ctrl && !e.altKey && ["Equal", "NumpadAdd"].includes(e.code)) cmd = () => zoom(lastPane, 1);
    else if (ctrl && !e.altKey && ["Minus", "NumpadSubtract"].includes(e.code)) cmd = () => zoom(lastPane, -1);
    else if (ctrl && !e.altKey && ["Digit0", "Numpad0", "NumpadDivide"].includes(e.code)) cmd = () => zoom(lastPane, 0);
    else if (ctrl && e.altKey && e.code === "KeyS") cmd = saveAll;
    else if (ctrl && !e.shiftKey && e.code === "KeyH" && lastPane === "editor") cmd = openReplace;
    else if (ctrl && !e.shiftKey && e.code === "KeyG" && lastPane === "editor") cmd = editorCmd(gotoLine);
    else if (ctrl && !e.shiftKey && e.code === "KeyN") cmd = commands.new;
    else if (ctrl && e.code === "KeyO") cmd = e.shiftKey ? commands.openFolder : commands.open;
    else if (ctrl && !e.shiftKey && e.code === "KeyB") cmd = commands.explorer;
    else if (ctrl && e.code === "KeyS") cmd = e.shiftKey ? commands.saveAs : commands.save;
    else if (ctrl && !e.shiftKey && e.code === "KeyW") cmd = () => closeTab(current);
    else if (e.altKey && e.code === "KeyZ") cmd = commands.wrap;
    else if (ctrl && e.shiftKey && e.code === "KeyL") cmd = commands.language;
    else if (ctrl && e.code === "Tab" && tabs.length > 1) {
      const i = tabs.indexOf(current) + (e.shiftKey ? -1 : 1);
      cmd = () => activate(tabs[(i + tabs.length) % tabs.length]);
    }
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      cmd();
    }
  },
  true
);

// Open files dropped onto the window.
getCurrentWebview()
  .onDragDropEvent(async (e) => {
    if (e.payload.type !== "drop") return;
    for (const p of e.payload.paths) {
      if (await invoke("file_exists", { path: p })) await openPath(p);
      else {
        await explorer.setRoot(p);
        toggleSidebar(true);
        saveSessionSoon();
      }
    }
  })
  .catch(() => {});

getCurrentWindow()
  .onCloseRequested(() => saveSession())
  .catch(() => {});
window.addEventListener("beforeunload", saveSession);

applyZoom();
document.documentElement.dataset.theme = settings.theme;
terminal.setTerminalTheme(settings.theme);
explorer.init({
  openFile: openPath,
  changed: saveSessionSoon,
  openTerminal: (dir) => {
    showTerminalPanel(true);
    terminal.newTerminal(dir);
  },
});
toggleSidebar(settings.sidebar);
restoreSession();
