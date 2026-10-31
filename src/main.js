import {
  lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
} from "@codemirror/view";
import { indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from "@codemirror/language";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { folding, foldAll, unfoldAll, foldCurrent, unfoldCurrent, foldLevel, unfoldLevel } from "./folding.js";
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
      return true;
    } catch {
      return false; // storage full
    }
  },
};

const settings = {
  theme: store.get("theme", "dark"),
  wrap: store.get("wrap", false),
  sidebar: store.get("sidebar", true),
  docList: store.get("docList", false),
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

// CodeMirror's basicSetup, with Notepad++-style folding in place of the default fold gutter.
const editorSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  folding,
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
];

function makeState(text) {
  return EditorState.create({
      doc: text,
      extensions: [
        editorSetup,
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

function newTab({ path = null, text = "", saved = text, lang = null, encoding = "UTF-8", mtime = null } = {}) {
  const tab = {
    id: nextTabId++,
    path,
    name: path ? baseName(path) : `new ${++untitledCount}`,
    state: makeState(text),
    lang: null,
    saved: EditorState.create({ doc: saved }).doc,
    eol: /\r\n/.test(saved) ? "\r\n" : "\n",
    encoding,
    mtime, // the file's modified time when last read or saved, to notice changes by other programs
  };
  tabs.push(tab);
  const chosen = lang && languageByName(lang);
  setLanguage(tab, chosen || detectLanguage(path), !!chosen);
  return tab;
}

let useClock = 0; // orders tabs by when they were last shown, for the Ctrl+Tab switcher

function activate(tab) {
  if (current) current.state = view.state;
  current = tab;
  tab.lastUsed = ++useClock;
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
  activate(newTab({ path, text: file.text, encoding: file.encoding, mtime: file.modified }));
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

let saving = 0; // while a save is running, its dialogs mustn't trigger the disk-change check

async function save(tab = current, forceDialog = false) {
  saving++;
  try {
    return await saveTab(tab, forceDialog);
  } finally {
    saving--;
  }
}

async function saveTab(tab, forceDialog) {
  let path = tab.path;
  if (!path || forceDialog) {
    path = await saveDialog({ defaultPath: tab.path || tab.name + ".txt" });
    if (!path) return false;
  }
  if (path === tab.path && tab.mtime) {
    const onDisk = await invoke("file_modified", { path }).catch(() => null);
    if (onDisk && onDisk !== tab.mtime && !(await ask(
      `${tab.name} was changed by another program since you opened it.\n\nReplace it with your version?`, "Replace"))) return false;
  }
  const state = tabState(tab);
  const text = state.doc.toJSON().join(tab.eol);
  try {
    tab.mtime = await invoke("write_file", { path, contents: text, encoding: tab.encoding });
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

const ask = async (text, okLabel) =>
  (await message(text, { title: "Lightpad", kind: "warning", buttons: { ok: okLabel, cancel: "Cancel" } })) !== "Cancel";

// Picks up changes other programs made to open files: reloads files without unsaved edits, and
// asks before replacing unsaved edits.
let checkingDisk = false;
async function checkDiskChanges() {
  if (checkingDisk || saving) return;
  checkingDisk = true;
  try {
    for (const tab of [...tabs]) {
      if (!tab.path || !tab.mtime || !tabs.includes(tab)) continue;
      const onDisk = await invoke("file_modified", { path: tab.path }).catch(() => null);
      if (!onDisk || onDisk === tab.mtime) continue; // unchanged, or deleted (keep the tab so nothing is lost)
      if (isDirty(tab) && !(await ask(`${tab.name} was changed by another program.\n\nReload it and lose your unsaved changes?`, "Reload"))) {
        tab.mtime = onDisk; // keep the user's version; don't ask again for this change
        continue;
      }
      let file;
      try {
        file = await invoke("read_file", { path: tab.path });
      } catch {
        continue;
      }
      const state = tabState(tab);
      const update = { changes: { from: 0, to: state.doc.length, insert: file.text },
        selection: { anchor: Math.min(state.selection.main.head, file.text.length) } };
      if (tab === current) view.dispatch(update);
      else tab.state = tab.state.update(update).state;
      tab.saved = tabState(tab).doc;
      tab.mtime = file.modified;
      tab.encoding = file.encoding;
      tab.eol = /\r\n/.test(file.text) ? "\r\n" : "\n";
    }
  } finally {
    checkingDisk = false;
  }
  renderTabs();
  renderStatus();
}
window.addEventListener("focus", checkDiskChanges);

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
  const session = {
    folder: explorer.getRoot(),
    expanded: explorer.getExpanded(),
    active: tabs.indexOf(current),
    tabs: tabs.map((t) => ({
      path: t.path,
      name: t.name,
      content: isDirty(t) ? t.state.doc.toString() : null,
      lang: t.langManual ? t.lang : null,
      pinned: !!t.pinned,
    })),
  };
  if (store.set("session", session)) return;
  // Too big for storage: keep the tabs, but drop the largest unsaved texts.
  for (const t of session.tabs) if (t.content?.length > 1_000_000) t.content = null;
  store.set("session", session);
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
        newTab({ path: t.path, text: t.content ?? saved, saved, lang: t.lang, encoding: file?.encoding, mtime: file?.modified }).pinned = !!t.pinned;
      } else {
        const tab = newTab({ text: t.content ?? "", saved: "", lang: t.lang });
        tab.pinned = !!t.pinned;
        tab.name = t.name || tab.name;
      }
    }
    untitledCount = Math.max(0, ...tabs.map((t) => +(/^new (\d+)$/.exec(t.name)?.[1] || 0)));
  }
  activate(tabs[s?.active] || tabs[0] || newTab());
}

// ---------- UI ----------

// ---------- Document List (all open tabs, in a pane under the explorer) ----------

let docSort = store.get("docSort", { key: null, dir: 1 });

function splitName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

const diskIcon = (color) =>
  `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 2h10l2 2v10H2z" fill="${color}"/><path d="M4.5 2h6v4h-6z" fill="#fff" opacity=".9"/><path d="M4 9h8v5H4z" fill="#fff" opacity=".35"/></svg>`;

function renderDocList() {
  if (!settings.docList) return;
  let list = [...tabs];
  if (docSort.key) {
    const pick = (t) => splitName(t.name)[docSort.key === "ext" ? 1 : 0].toLowerCase();
    list.sort((a, b) => pick(a).localeCompare(pick(b), undefined, { numeric: true }) * docSort.dir);
  }
  for (const b of document.querySelectorAll("#doclist-cols button")) {
    b.querySelector("span").textContent = b.dataset.sort === docSort.key ? (docSort.dir > 0 ? "▲" : "▼") : "";
  }
  $("doclist").replaceChildren(
    ...list.map((t) => {
      const [name, ext] = splitName(t.name);
      const row = document.createElement("div");
      const dirty = isDirty(t);
      row.className = "doc-row" + (t === current ? " active" : "");
      row.title = (t.path || t.name) + (dirty ? " (unsaved changes)" : "");
      row.innerHTML = `<span class="doc-icon">${diskIcon(dirty ? "#dc2626" : "#3b82f6")}</span>`;
      const n = document.createElement("span");
      n.className = "doc-name";
      n.textContent = name;
      const x = document.createElement("span");
      x.className = "doc-ext";
      x.textContent = ext;
      row.append(n, x);
      row.onmousedown = (e) => {
        if (e.button === 1) return closeTab(t), e.preventDefault();
        if (e.button === 0) activate(t);
      };
      return row;
    })
  );
  $("doclist").querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

for (const b of document.querySelectorAll("#doclist-cols button")) {
  b.onclick = () => {
    // Click cycles: ascending, descending, back to tab order.
    if (docSort.key !== b.dataset.sort) docSort = { key: b.dataset.sort, dir: 1 };
    else if (docSort.dir > 0) docSort.dir = -1;
    else docSort = { key: null, dir: 1 };
    store.set("docSort", docSort);
    renderDocList();
  };
}

function renderTabs() {
  renderDocList();
  const bar = $("tabs");
  bar.replaceChildren(
    ...tabs.map((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t === current ? " active" : "") + (isDirty(t) ? " dirty" : "") + (t.pinned ? " pinned" : "");
      el.title = t.path || t.name;
      el.onmousedown = (e) => {
        if (e.button === 1) return closeTab(t), e.preventDefault();
        if (e.button === 0) activate(t);
      };
      const label = document.createElement("span");
      label.textContent = t.name;
      if (t.pinned) {
        const pin = document.createElement("i");
        pin.className = "pin";
        pin.title = "Pinned (right-click the file in the explorer to unpin)";
        pin.textContent = "📌";
        el.append(pin);
      }
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

// The left side holds the explorer and/or the document list; it hides when both are off.
function layoutSidebar() {
  const any = settings.sidebar || settings.docList;
  $("sidebar").hidden = !any;
  $("side-resizer").hidden = !any;
  $("explorer-pane").hidden = !settings.sidebar;
  $("doclist-pane").hidden = !settings.docList;
  $("doclist-resizer").hidden = !(settings.sidebar && settings.docList);
  $("doclist-pane").classList.toggle("fill", !settings.sidebar);
  renderDocList();
}

function toggleSidebar(force) {
  settings.sidebar = force ?? !settings.sidebar;
  store.set("sidebar", settings.sidebar);
  layoutSidebar();
}

function toggleDocList(force) {
  settings.docList = force ?? !settings.docList;
  store.set("docList", settings.docList);
  layoutSidebar();
}

// Language picker: type to filter, Enter or click to apply to the current tab.
const picker = $("lang-picker");
const pickerInput = $("lang-filter");
const pickerList = $("lang-list");

function renderLanguageList() {
  const q = pickerInput.value.trim().toLowerCase();
  const ext = q.replace(/^\./, "");
  // Best matches first: the file extension typed exactly, then names that start with the text.
  const rank = (l) =>
    l.extensions.some((e) => e.toLowerCase() === ext) ? 0 : l.name.toLowerCase().startsWith(q) ? 1 : l.name.toLowerCase().includes(q) ? 2 : 3;
  const matches = LANGUAGES.filter((l) => !q || rank(l) < 3).sort((a, b) => (q ? rank(a) - rank(b) : 0));
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

// ---------- File switcher (Ctrl+Tab), most recently used first, like Notepad++ ----------

const switcher = document.createElement("div");
switcher.id = "switcher";
switcher.hidden = true;
document.body.append(switcher);
let switchList = [];
let switchAt = 0;

function renderSwitcher() {
  switcher.replaceChildren(
    ...switchList.map((t, i) => {
      const row = document.createElement("div");
      row.className = "sw-row" + (i === switchAt ? " sel" : "") + (isDirty(t) ? " dirty" : "");
      const name = document.createElement("span");
      name.textContent = t.name;
      const dir = document.createElement("small");
      dir.textContent = t.path ? dirName(t.path) : "";
      row.append(name, dir);
      row.onmousedown = (e) => {
        e.preventDefault();
        switchAt = i;
        finishSwitch();
      };
      return row;
    })
  );
  switcher.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

// Each Ctrl+Tab moves one file down the list (Shift moves up); letting go of Ctrl opens it.
function stepSwitcher(back) {
  if (tabs.length < 2) return;
  if (switcher.hidden) {
    switchList = [...tabs].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    switchAt = 0;
    switcher.hidden = false;
  }
  switchAt = (switchAt + (back ? -1 : 1) + switchList.length) % switchList.length;
  renderSwitcher();
}

function finishSwitch() {
  if (switcher.hidden) return;
  switcher.hidden = true;
  const tab = switchList[switchAt];
  switchList = [];
  if (tab && tabs.includes(tab)) activate(tab);
}

window.addEventListener("keyup", (e) => (e.key === "Control" || e.key === "Meta") && finishSwitch(), true);
window.addEventListener("blur", () => (switcher.hidden = true));

// Ctrl+PageDown / Ctrl+PageUp: the next / previous tab in tab-bar order.
function stepTab(back) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(current) + (back ? -1 : 1);
  activate(tabs[(i + tabs.length) % tabs.length]);
}

// Ctrl+1..8 opens that tab, Ctrl+9 the last one.
function goToTab(n) {
  const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (tab) activate(tab);
}

const commands = {
  language: openLanguagePicker,
  new: () => activate(newTab()),
  open: openFiles,
  openFolder,
  explorer: () => toggleSidebar(),
  docList: () => toggleDocList(),
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

// Pinned tabs stay at the start of the tab bar and are kept by Close All.
function togglePin(tab) {
  tab.pinned = !tab.pinned;
  tabs = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  renderTabs();
  saveSessionSoon();
}

async function closeAll() {
  for (const t of tabs.filter((t) => !t.pinned)) {
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

const levelItems = (fn, keys) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: String(n), shortcut: keys + n, run: editorCmd((v) => fn(v, n)) }));

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
      { label: "Document List", checked: settings.docList, run: commands.docList },
      { label: "Terminal", shortcut: "Ctrl+`", checked: !$("terminal-panel").hidden, run: commands.terminal },
      "-",
      { label: "Word Wrap", shortcut: "Alt+Z", checked: settings.wrap, run: commands.wrap },
      "-",
      { label: "Fold All", shortcut: "Alt+0", run: editorCmd(foldAll) },
      { label: "Unfold All", shortcut: "Alt+Shift+0", run: editorCmd(unfoldAll) },
      { label: "Fold Current Level", shortcut: "Ctrl+Alt+F", run: editorCmd(foldCurrent) },
      { label: "Unfold Current Level", shortcut: "Ctrl+Alt+Shift+F", run: editorCmd(unfoldCurrent) },
      { label: "Fold Level", submenu: () => levelItems(foldLevel, "Alt+") },
      { label: "Unfold Level", submenu: () => levelItems(unfoldLevel, "Alt+Shift+") },
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
  {
    label: "Window",
    items: () => [
      { label: "Switch Files (recently used)", shortcut: "Ctrl+Tab", disabled: tabs.length < 2, run: () => {
        stepSwitcher(false);
        finishSwitch();
      } },
      { label: "Next Tab", shortcut: "Ctrl+PgDn", disabled: tabs.length < 2, run: () => stepTab(false) },
      { label: "Previous Tab", shortcut: "Ctrl+PgUp", disabled: tabs.length < 2, run: () => stepTab(true) },
      "-",
      ...tabs.map((t, i) => ({
        label: t.name + (isDirty(t) ? " •" : ""),
        shortcut: i < 8 ? `Ctrl+${i + 1}` : i === tabs.length - 1 ? "Ctrl+9" : "",
        checked: t === current,
        run: () => activate(t),
      })),
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

// Drag the bar between the explorer and the document list to resize them.
$("doclist-resizer").onpointerdown = (e) => {
  const pane = $("doclist-pane");
  const startY = e.clientY;
  const startH = pane.offsetHeight;
  e.target.setPointerCapture(e.pointerId);
  e.target.onpointermove = (m) => {
    const max = $("sidebar").offsetHeight - 120;
    pane.style.height = Math.max(80, Math.min(max, startH - (m.clientY - startY))) + "px";
  };
  e.target.onpointerup = () => {
    e.target.onpointermove = null;
    store.set("docListHeight", pane.offsetHeight);
  };
};
$("doclist-pane").style.height = store.get("docListHeight", 220) + "px";

// Global shortcuts
window.addEventListener(
  "keydown",
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    // In the terminal, leave the shell its own Ctrl+letter keys (Ctrl+W deletes a word, Ctrl+B moves back, ...).
    const inTerminal = $("terminal-panel").contains(e.target);
    if (inTerminal && ctrl && !e.shiftKey && !e.altKey && ["KeyB", "KeyN", "KeyO", "KeyW"].includes(e.code)) return;
    let cmd = null;
    if (ctrl && e.code === "Backquote") cmd = e.shiftKey ? newTerminalHere : commands.terminal;
    else if (ctrl && !e.altKey && ["Equal", "NumpadAdd"].includes(e.code)) cmd = () => zoom(lastPane, 1);
    else if (ctrl && !e.altKey && ["Minus", "NumpadSubtract"].includes(e.code)) cmd = () => zoom(lastPane, -1);
    else if (ctrl && !e.altKey && ["Digit0", "Numpad0", "NumpadDivide"].includes(e.code)) cmd = () => zoom(lastPane, 0);
    else if (ctrl && e.altKey && e.code === "KeyS") cmd = saveAll;
    else if (ctrl && e.altKey && e.code === "KeyF") cmd = editorCmd(e.shiftKey ? unfoldCurrent : foldCurrent);
    else if (e.altKey && !ctrl && /^Digit[0-8]$/.test(e.code) && lastPane === "editor") {
      const n = +e.code.slice(5);
      if (n === 0) cmd = editorCmd(e.shiftKey ? unfoldAll : foldAll);
      else cmd = editorCmd((v) => (e.shiftKey ? unfoldLevel : foldLevel)(v, n));
    }
    else if (ctrl && !e.shiftKey && e.code === "KeyH" && lastPane === "editor") cmd = openReplace;
    else if (ctrl && !e.shiftKey && e.code === "KeyG" && lastPane === "editor") cmd = editorCmd(gotoLine);
    else if (ctrl && !e.shiftKey && e.code === "KeyN") cmd = commands.new;
    else if (ctrl && e.code === "KeyO") cmd = e.shiftKey ? commands.openFolder : commands.open;
    else if (ctrl && !e.shiftKey && e.code === "KeyB") cmd = commands.explorer;
    else if (ctrl && e.code === "KeyS") cmd = e.shiftKey ? commands.saveAs : commands.save;
    else if (ctrl && !e.shiftKey && e.code === "KeyW") cmd = () => closeTab(current);
    else if (e.altKey && e.code === "KeyZ") cmd = commands.wrap;
    else if (ctrl && e.shiftKey && e.code === "KeyL") cmd = commands.language;
    else if (ctrl && e.code === "Tab") cmd = () => stepSwitcher(e.shiftKey);
    else if (ctrl && !e.shiftKey && !e.altKey && ["PageDown", "PageUp"].includes(e.code)) cmd = () => stepTab(e.code === "PageUp");
    else if (ctrl && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) cmd = () => goToTab(+e.code.slice(5));
    else if (e.key === "Escape" && !switcher.hidden) cmd = () => (switcher.hidden = true);
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
// Paths under `dir` (or `dir` itself), whichever separator the OS uses.
const isUnder = (path, dir) => path === dir || path.startsWith(dir + "/") || path.startsWith(dir + "\\");

explorer.init({
  openFile: openPath,
  changed: saveSessionSoon,
  openTerminal: (dir) => {
    showTerminalPanel(true);
    terminal.newTerminal(dir);
  },
  openFolder,
  showError,
  focusEditor: () => view.focus(),
  confirm: ask,
  tabFor: (path) => tabs.find((t) => t.path === path),
  save: (tab) => save(tab),
  saveAs: (tab) => save(tab, true),
  close: (tab) => closeTab(tab),
  togglePin: async (path) => {
    let tab = tabs.find((t) => t.path === path);
    if (!tab) {
      await openPath(path);
      tab = tabs.find((t) => t.path === path);
    }
    if (tab) togglePin(tab);
  },
  // A file or folder was renamed or moved: keep its open tabs pointing at the new place.
  renamed: (from, to) => {
    for (const t of tabs) {
      if (!t.path || !isUnder(t.path, from)) continue;
      t.path = to + t.path.slice(from.length);
      t.name = baseName(t.path);
      if (!t.langManual) setLanguage(t, detectLanguage(t.path));
    }
    renderTabs();
    renderStatus();
    saveSessionSoon();
  },
  // Deleted: close its tabs, except ones with unsaved edits, which stay open so nothing is lost.
  deleted: (path) => {
    for (const t of tabs.filter((t) => t.path && isUnder(t.path, path) && !isDirty(t))) {
      tabs.splice(tabs.indexOf(t), 1);
      if (t === current) current = null;
    }
    if (!current) activate(tabs[0] || newTab());
    else renderTabs();
    saveSessionSoon();
  },
});
layoutSidebar();
restoreSession();
