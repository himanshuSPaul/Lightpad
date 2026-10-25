import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import { languageFor } from "./languages.js";
import * as terminal from "./terminal.js";
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

const settings = { theme: store.get("theme", "dark"), wrap: store.get("wrap", false) };
const langConf = new Compartment();
const themeConf = new Compartment();
const wrapConf = new Compartment();

let tabs = [];
let current = null;
let untitledCount = 0;
let nextTabId = 1;

// ---------- Editor ----------

const view = new EditorView({ parent: $("editor") });

function makeState(text, path) {
  const lang = languageFor(path);
  return {
    lang: lang.name,
    state: EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        langConf.of(lang.support),
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
    }),
  };
}

const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, "");
const tabState = (t) => (t === current ? view.state : t.state);
const isDirty = (t) => !tabState(t).doc.eq(t.saved);

function newTab({ path = null, text = "", saved = text } = {}) {
  const { state, lang } = makeState(text, path);
  const tab = {
    id: nextTabId++,
    path,
    name: path ? baseName(path) : `new ${++untitledCount}`,
    state,
    lang,
    saved: EditorState.create({ doc: saved }).doc,
    eol: /\r\n/.test(saved) ? "\r\n" : "\n",
  };
  tabs.push(tab);
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
  view.focus();
  saveSessionSoon();
}

// ---------- Files ----------

async function openPath(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) return activate(existing);
  let text;
  try {
    text = await invoke("read_file", { path });
  } catch (e) {
    return alert(`Could not open ${path}\n${e}`);
  }
  // Replace a single empty untitled tab, like Notepad++ does.
  if (tabs.length === 1 && current && !current.path && view.state.doc.length === 0) {
    tabs = [];
    current = null;
  }
  activate(newTab({ path, text }));
  addRecent(path);
}

async function openFiles() {
  const picked = await openDialog({ multiple: true, defaultPath: current?.path ? dirName(current.path) : undefined });
  if (!picked) return;
  for (const p of [].concat(picked)) await openPath(p);
}

async function save(tab = current, forceDialog = false) {
  let path = tab.path;
  if (!path || forceDialog) {
    path = await saveDialog({ defaultPath: tab.path || tab.name + ".txt" });
    if (!path) return false;
  }
  const state = tabState(tab);
  const text = state.doc.toJSON().join(tab.eol);
  try {
    await invoke("write_file", { path, contents: text });
  } catch (e) {
    alert(`Could not save ${path}\n${e}`);
    return false;
  }
  tab.saved = state.doc;
  if (path !== tab.path) {
    tab.path = path;
    tab.name = baseName(path);
    const lang = languageFor(path);
    tab.lang = lang.name;
    if (tab === current) view.dispatch({ effects: langConf.reconfigure(lang.support) });
    else tab.state = tab.state.update({ effects: langConf.reconfigure(lang.support) }).state;
  }
  addRecent(path);
  renderTabs();
  renderStatus();
  saveSessionSoon();
  return true;
}

async function closeTab(tab) {
  if (isDirty(tab)) {
    const keep = await ask(`Save changes to ${tab.name}?`, { title: "Lightpad", kind: "warning", okLabel: "Save", cancelLabel: "Don't save" });
    if (keep && !(await save(tab))) return;
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
    active: tabs.indexOf(current),
    tabs: tabs.map((t) => ({
      path: t.path,
      name: t.name,
      content: isDirty(t) ? t.state.doc.toString() : null,
    })),
  });
}

async function restoreSession() {
  const s = store.get("session", null);
  if (s?.tabs?.length) {
    for (const t of s.tabs) {
      if (t.path) {
        let saved = null;
        try {
          saved = await invoke("read_file", { path: t.path });
        } catch {}
        if (saved === null && t.content === null) continue; // file is gone
        newTab({ path: t.path, text: t.content ?? saved, saved: saved ?? "" });
      } else {
        const tab = newTab({ text: t.content ?? "", saved: "" });
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
  $("wrap-btn").classList.toggle("on", settings.wrap);
}

async function toggleTerminal(force) {
  const panel = $("terminal-panel");
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  $("resizer").hidden = !show;
  $("term-btn").classList.toggle("on", show);
  if (!show) return view.focus();
  if (!terminal.hasTerminals()) await terminal.newTerminal(current?.path ? dirName(current.path) : null);
  else {
    terminal.fitActive();
    terminal.focusTerminal();
  }
}

const commands = {
  new: () => activate(newTab()),
  open: openFiles,
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

$("term-new").onclick = () => terminal.newTerminal(current?.path ? dirName(current.path) : null);
$("term-close-panel").onclick = () => toggleTerminal(false);

// Recent files dropdown
const recentList = $("recent-list");
$("recent-btn").onclick = (e) => {
  e.stopPropagation();
  const list = store.get("recent", []);
  recentList.replaceChildren(
    ...(list.length ? list : [null]).map((p) => {
      const li = document.createElement("li");
      li.textContent = p || "(no recent files)";
      if (p) li.onclick = () => openPath(p);
      return li;
    })
  );
  recentList.hidden = !recentList.hidden;
};
document.addEventListener("click", () => (recentList.hidden = true));

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

// Global shortcuts
window.addEventListener(
  "keydown",
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    let cmd = null;
    if (ctrl && e.code === "Backquote") cmd = commands.terminal;
    else if (ctrl && !e.shiftKey && e.code === "KeyN") cmd = commands.new;
    else if (ctrl && !e.shiftKey && e.code === "KeyO") cmd = commands.open;
    else if (ctrl && e.code === "KeyS") cmd = e.shiftKey ? commands.saveAs : commands.save;
    else if (ctrl && !e.shiftKey && e.code === "KeyW") cmd = () => closeTab(current);
    else if (e.altKey && e.code === "KeyZ") cmd = commands.wrap;
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
    for (const p of e.payload.paths) if (await invoke("file_exists", { path: p })) await openPath(p);
  })
  .catch(() => {});

getCurrentWindow()
  .onCloseRequested(() => saveSession())
  .catch(() => {});
window.addEventListener("beforeunload", saveSession);

$("wrap-btn").classList.toggle("on", settings.wrap);
document.documentElement.dataset.theme = settings.theme;
terminal.setTerminalTheme(settings.theme);
restoreSession();
