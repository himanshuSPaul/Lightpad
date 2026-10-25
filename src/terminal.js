import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const THEMES = {
  dark: { background: "#1e1f22", foreground: "#d4d4d4", cursor: "#d4d4d4", selectionBackground: "#3a4a6b" },
  light: { background: "#ffffff", foreground: "#1f2328", cursor: "#1f2328", selectionBackground: "#b6d3ff" },
};

const sessions = new Map(); // pty id -> { term, fit, host, tab }
let active = null;
let theme = "dark";
const tabList = document.getElementById("term-tab-list");
const hosts = document.getElementById("term-hosts");

listen("pty-output", ({ payload }) => sessions.get(payload.id)?.term.write(payload.data));
listen("pty-exit", ({ payload }) => {
  const s = sessions.get(payload);
  if (s) s.term.write("\r\n\x1b[90m[process exited — press any key to close]\x1b[0m");
  if (s) s.exited = true;
});

new ResizeObserver(() => fitActive()).observe(hosts);

export function fitActive() {
  const s = sessions.get(active);
  if (!s || hosts.offsetParent === null) return;
  s.fit.fit();
  invoke("pty_resize", { id: active, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
}

export async function newTerminal(cwd) {
  const term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEMES[theme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement("div");
  host.className = "term-host";
  hosts.appendChild(host);
  term.open(host);
  fit.fit();

  let id;
  try {
    id = await invoke("pty_spawn", { cwd: cwd || null, shell: null, cols: term.cols, rows: term.rows });
  } catch (e) {
    term.write(`\x1b[31mCould not start shell: ${e}\x1b[0m`);
    return;
  }
  const tab = document.createElement("button");
  tab.className = "term-tab";
  // Name each terminal after the folder it started in.
  tab.textContent = cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd : `Terminal ${id + 1}`;
  tab.title = cwd || "Home folder";
  tab.onclick = () => activate(id);
  tabList.appendChild(tab);

  const s = { term, fit, host, tab, exited: false };
  sessions.set(id, s);
  term.onData((data) => {
    if (s.exited) return closeTerminal(id);
    invoke("pty_write", { id, data });
  });
  // Ctrl+Shift+C / Ctrl+Shift+V copy and paste, like most terminals.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === "KeyC") {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.code === "KeyV") {
      navigator.clipboard.readText().then((t) => invoke("pty_write", { id, data: t }));
      return false;
    }
    return true;
  });
  activate(id);
}

function activate(id) {
  active = id;
  for (const [sid, s] of sessions) {
    s.host.hidden = sid !== id;
    s.tab.classList.toggle("active", sid === id);
  }
  requestAnimationFrame(() => {
    fitActive();
    sessions.get(id)?.term.focus();
  });
}

function closeTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  invoke("pty_kill", { id });
  s.term.dispose();
  s.host.remove();
  s.tab.remove();
  sessions.delete(id);
  const next = [...sessions.keys()].pop();
  if (next !== undefined) activate(next);
  else active = null;
}

export function hasTerminals() {
  return sessions.size > 0;
}

export function focusTerminal() {
  sessions.get(active)?.term.focus();
}

export function setTerminalTheme(name) {
  theme = name;
  for (const s of sessions.values()) s.term.options.theme = THEMES[name];
}

export function closeActiveTerminal() {
  if (active !== null) closeTerminal(active);
}
