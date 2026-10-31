import { invoke } from "@tauri-apps/api/core";

const tree = document.getElementById("tree");
const title = document.getElementById("explorer-title");

let root = null;
let expanded = new Set();
let activePath = null;
let onOpen = () => {};
let onChange = () => {};
let actions = {}; // hooks into the editor: tabs, saving, terminal (see init)
let selected = null; // the highlighted row, target of F2 / Del / Ctrl+C / X / V
let clipboard = null; // { path, cut }
let changes = 0; // counts folder expands/collapses, so a slow refresh doesn't undo one made meanwhile

const signature = (container) =>
  [...container.querySelectorAll(".node")].map((n) => n.dataset.path + n.querySelector(".chevron")?.className).join("|");

const baseName = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const parentDir = (p) => p.replace(/[\\/][^\\/]*$/, "");

const ICON_COLORS = {
  py: "#3b82f6", js: "#eab308", mjs: "#eab308", ts: "#3178c6", tsx: "#3178c6", jsx: "#06b6d4",
  json: "#ca8a04", md: "#60a5fa", html: "#f97316", htm: "#f97316", css: "#a855f7", scss: "#ec4899",
  rs: "#f97316", c: "#2563eb", h: "#7c3aed", cpp: "#2563eb", java: "#ef4444", xml: "#f97316",
  sql: "#14b8a6", sh: "#22c55e", bat: "#22c55e", ps1: "#3b82f6", txt: "#9ca3af", toml: "#9ca3af",
  yml: "#ef4444", yaml: "#ef4444",
};

function fileIcon(name) {
  const span = document.createElement("span");
  span.className = "icon";
  if (/^\.env/.test(name)) {
    span.textContent = "⚙";
    span.classList.add("gear");
    return span;
  }
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  span.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 1.5h6.5L13 5v9.5H3z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  span.style.color = ICON_COLORS[ext] || "var(--muted)";
  return span;
}

function row(entry, depth) {
  const el = document.createElement("div");
  el.className = "node" + (entry.name.startsWith(".") ? " hidden-file" : "");
  el.style.paddingLeft = 8 + depth * 14 + "px";
  el.dataset.path = entry.path;
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  if (entry.is_dir) {
    chevron.textContent = "›";
    if (expanded.has(entry.path)) chevron.classList.add("open");
  }
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.name;
  el.append(chevron);
  if (!entry.is_dir) el.append(fileIcon(entry.name));
  el.append(label);
  if (entry.path === activePath) el.classList.add("active");
  if (entry.path === selected) el.classList.add("selected");
  if (clipboard?.cut && clipboard.path === entry.path) el.classList.add("cut");
  return el;
}

async function renderDir(path, depth, container) {
  let entries;
  try {
    entries = await invoke("list_dir", { path });
  } catch (e) {
    const err = document.createElement("div");
    err.className = "node error";
    err.style.paddingLeft = 8 + depth * 14 + "px";
    err.textContent = String(e);
    container.append(err);
    return;
  }
  for (const entry of entries) {
    const el = row(entry, depth);
    container.append(el);
    if (entry.is_dir) {
      const kids = document.createElement("div");
      container.append(kids);
      el.onclick = () => {
        select(entry.path);
        toggle(entry.path, el, kids, depth + 1);
      };
      el.oncontextmenu = (e) => showMenu(e, entry);
      if (expanded.has(entry.path)) await renderDir(entry.path, depth + 1, kids);
    } else {
      el.onclick = () => {
        select(entry.path);
        onOpen(entry.path);
      };
      el.oncontextmenu = (e) => showMenu(e, entry);
    }
  }
}

async function toggle(path, el, kids, depth) {
  changes++;
  const chevron = el.querySelector(".chevron");
  if (expanded.has(path)) {
    expanded.delete(path);
    chevron.classList.remove("open");
    kids.replaceChildren();
  } else {
    expanded.add(path);
    chevron.classList.add("open");
    await renderDir(path, depth, kids);
  }
  onChange();
}

export async function render() {
  if (!root) {
    title.textContent = "No folder opened";
    tree.replaceChildren();
    const btn = document.createElement("button");
    btn.className = "open-folder";
    btn.textContent = "Open Folder";
    btn.onclick = () => actions.openFolder();
    tree.append(btn);
    return;
  }
  title.textContent = baseName(root);
  title.title = root;
  const scroll = tree.scrollTop;
  const fresh = document.createElement("div");
  const before = changes;
  await renderDir(root, 0, fresh);
  if (changes !== before) return render(); // a folder was opened or closed while listing: list again
  // Leave the tree alone if nothing changed, so a click that is in progress isn't lost.
  if (tree.querySelector(".node") && signature(fresh) === signature(tree)) return;
  tree.replaceChildren(...fresh.childNodes);
  tree.scrollTop = scroll;
}

function select(path) {
  selected = path;
  for (const el of tree.querySelectorAll(".node")) el.classList.toggle("selected", el.dataset.path === path);
}

function relativePath(path) {
  if (!root) return path;
  if (path === root) return ".";
  const r = root.replace(/[\\/]+$/, "");
  if (!path.startsWith(r + "/") && !path.startsWith(r + "\\")) return path;
  return path.slice(r.length + 1);
}

// ---------- Small text prompt (rename, new file, new folder) ----------

function askText(label, initial = "", selectStem = false) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.id = "ask-box";
    box.innerHTML = `<label></label><input spellcheck="false" />`;
    box.querySelector("label").textContent = label;
    const input = box.querySelector("input");
    input.value = initial;
    document.body.append(box);
    input.focus();
    // Select the name without its extension, like Windows Explorer.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
    let finished = false;
    const done = (value) => {
      // Removing the box fires blur in Chromium (Windows' WebView2), which would call done again
      // and answer "cancelled": settle first, and only once.
      if (finished) return;
      finished = true;
      resolve(value);
      box.remove();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    };
    input.onblur = () => done(null);
  });
}

// ---------- File operations ----------

async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    actions.showError("Lightpad", e);
    return null;
  }
}

async function refreshAndReveal(dir, path) {
  if (dir && dir !== root) expanded.add(dir);
  await render();
  if (path) select(path);
  onChange();
}

async function newItem(dir, kind) {
  const name = await askText(kind === "file" ? "New file name" : "New folder name");
  if (!name) return;
  const path = await run(() => invoke(kind === "file" ? "create_file" : "create_dir", { dir, name }));
  if (!path) return;
  await refreshAndReveal(dir, path);
  if (kind === "file") onOpen(path);
}

async function rename(path) {
  const name = await askText("Rename to", baseName(path), true);
  if (!name || name === baseName(path)) return;
  const to = await run(() => invoke("rename_path", { path, newName: name }));
  if (!to) return;
  if (expanded.has(path)) {
    expanded.delete(path);
    expanded.add(to);
  }
  if (clipboard?.path === path) clipboard = null;
  actions.renamed(path, to);
  await refreshAndReveal(null, to);
}

async function remove(path, isDir) {
  if (!(await actions.confirm(`Move "${baseName(path)}"${isDir ? " and everything in it" : ""} to the Recycle Bin?`, "Delete"))) return;
  // delete_path returns nothing, so map success to true; run() gives null on failure.
  if (!(await run(async () => (await invoke("delete_path", { path }), true)))) return;
  if (clipboard?.path === path) clipboard = null;
  actions.deleted(path);
  await render();
}

async function paste(targetDir) {
  if (!clipboard) return;
  const { path, cut } = clipboard;
  const to = await run(() => invoke("paste_path", { src: path, destDir: targetDir, cut }));
  if (!to) return;
  if (cut) {
    clipboard = null;
    actions.renamed(path, to);
  }
  await refreshAndReveal(targetDir, to);
}

function setClipboard(path, cut) {
  clipboard = { path, cut };
  for (const el of tree.querySelectorAll(".node")) el.classList.toggle("cut", cut && el.dataset.path === path);
}

const copyText = (text) => navigator.clipboard.writeText(text).catch(() => {});

// ---------- Right-click menu ----------

const menu = document.createElement("ul");
menu.id = "ctx-menu";
menu.hidden = true;
document.body.append(menu);
document.addEventListener("click", () => (menu.hidden = true));
document.addEventListener("keydown", (e) => e.key === "Escape" && (menu.hidden = true));

function menuFor(entry) {
  const { path, is_dir: isDir, isRoot } = entry;
  const dir = isDir ? path : parentDir(path);
  const tab = !isDir && actions.tabFor(path);
  const common = [
    "-",
    ...(isRoot ? [] : [
      { label: "Cut", key: "Ctrl+X", run: () => setClipboard(path, true) },
      { label: "Copy", key: "Ctrl+C", run: () => setClipboard(path, false) },
    ]),
    { label: "Paste", key: "Ctrl+V", disabled: !clipboard, run: () => paste(dir) },
    "-",
    { label: "Copy Path", key: "Shift+Alt+C", run: () => copyText(path) },
    { label: "Copy Relative Path", key: "Ctrl+Shift+Alt+C", run: () => copyText(relativePath(path)) },
    ...(isRoot ? [] : [
      "-",
      { label: "Rename...", key: "F2", run: () => rename(path) },
      { label: "Delete", key: "Del", run: () => remove(path, isDir) },
    ]),
  ];
  if (isDir) {
    return [
      { label: "New File...", run: () => newItem(dir, "file") },
      { label: "New Folder...", run: () => newItem(dir, "folder") },
      { label: "Open in Terminal", run: () => actions.openTerminal(dir) },
      ...common,
      ...(isRoot ? ["-", { label: "Refresh", run: render }] : []),
    ];
  }
  return [
    { label: "Open", run: () => onOpen(path) },
    { label: "Open in Terminal", run: () => actions.openTerminal(dir) },
    ...common,
    "-",
    { label: "Save", key: "Ctrl+S", disabled: !tab, run: () => actions.save(tab) },
    { label: "Save As...", key: "Ctrl+Shift+S", disabled: !tab, run: () => actions.saveAs(tab) },
    { label: tab?.pinned ? "Unpin Tab" : "Pin Tab", run: () => actions.togglePin(path) },
    { label: "Close", key: "Ctrl+W", disabled: !tab, run: () => actions.close(tab) },
  ];
}

function showMenu(e, entry) {
  e.preventDefault();
  e.stopPropagation();
  if (!entry.isRoot) select(entry.path);
  menu.replaceChildren(
    ...menuFor(entry).map((item) => {
      const li = document.createElement("li");
      if (item === "-") {
        li.className = "ctx-sep";
        return li;
      }
      li.innerHTML = `<span></span><small></small>`;
      li.firstChild.textContent = item.label;
      li.lastChild.textContent = item.key || "";
      if (item.disabled) li.className = "disabled";
      else li.onclick = item.run;
      return li;
    })
  );
  menu.hidden = false;
  menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4)) + "px";
}

title.oncontextmenu = (e) => root && showMenu(e, { path: root, is_dir: true, isRoot: true });
tree.oncontextmenu = (e) => root && e.target === tree && showMenu(e, { path: root, is_dir: true, isRoot: true });

// Keyboard shortcuts while the explorer has focus.
tree.tabIndex = 0;
tree.addEventListener("keydown", (e) => {
  if (!selected || e.target !== tree) return;
  const el = tree.querySelector(`.node[data-path="${CSS.escape(selected)}"]`);
  const isDir = !!el?.querySelector(".chevron")?.textContent;
  const ctrl = e.ctrlKey || e.metaKey;
  let act = null;
  if (e.key === "F2") act = () => rename(selected);
  else if (e.key === "Delete") act = () => remove(selected, isDir);
  else if (ctrl && e.altKey && e.shiftKey && e.code === "KeyC") act = () => copyText(relativePath(selected));
  else if (e.altKey && e.shiftKey && e.code === "KeyC") act = () => copyText(selected);
  else if (ctrl && !e.shiftKey && e.code === "KeyC") act = () => setClipboard(selected, false);
  else if (ctrl && !e.shiftKey && e.code === "KeyX") act = () => setClipboard(selected, true);
  else if (ctrl && !e.shiftKey && e.code === "KeyV") act = () => paste(isDir ? selected : parentDir(selected));
  else if (e.key === "Enter") act = () => el?.click();
  if (act) {
    e.preventDefault();
    e.stopPropagation();
    act();
  }
});

export function init(hooks) {
  onOpen = hooks.openFile;
  onChange = hooks.changed;
  actions = hooks;
  // Pick up files created or deleted outside the app.
  window.addEventListener("focus", () => root && render());
}

export function setRoot(path, keepExpanded = []) {
  root = path;
  expanded = new Set(keepExpanded);
  return render();
}

export function collapseAll() {
  expanded.clear();
  onChange();
  return render();
}

export function setActive(path) {
  activePath = path;
  for (const el of tree.querySelectorAll(".node")) el.classList.toggle("active", el.dataset.path === path);
}

export const getRoot = () => root;
export const getExpanded = () => [...expanded];
