import { invoke } from "@tauri-apps/api/core";

const tree = document.getElementById("tree");
const title = document.getElementById("explorer-title");

let root = null;
let expanded = new Set();
let activePath = null;
let onOpen = () => {};
let onChange = () => {};

const signature = (container) =>
  [...container.querySelectorAll(".node")].map((n) => n.title + n.querySelector(".chevron")?.className).join("|");

const baseName = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

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
  el.title = entry.path;
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
      el.onclick = () => toggle(entry.path, el, kids, depth + 1);
      if (expanded.has(entry.path)) await renderDir(entry.path, depth + 1, kids);
    } else {
      el.onclick = () => onOpen(entry.path);
    }
  }
}

async function toggle(path, el, kids, depth) {
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
    btn.onclick = () => document.querySelector('[data-cmd="openFolder"]').click();
    tree.append(btn);
    return;
  }
  title.textContent = baseName(root);
  title.title = root;
  const scroll = tree.scrollTop;
  const fresh = document.createElement("div");
  await renderDir(root, 0, fresh);
  // Leave the tree alone if nothing changed, so a click that is in progress isn't lost.
  if (tree.querySelector(".node") && signature(fresh) === signature(tree)) return;
  tree.replaceChildren(...fresh.childNodes);
  tree.scrollTop = scroll;
}

export function init({ openFile, changed }) {
  onOpen = openFile;
  onChange = changed;
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
