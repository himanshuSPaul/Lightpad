// A Notepad++-style menu bar. Each menu's items are built when it opens, so checkmarks
// and lists like Open Recent are always current.
//
// Item: { label, shortcut?, run?, checked?, disabled?, submenu?: () => Item[] } or "-" for a separator.

const bar = document.getElementById("menubar");
let openIndex = -1;
let buttons = [];
let menus = [];

function close() {
  bar.querySelectorAll(".menu-pop").forEach((p) => p.remove());
  buttons.forEach((b) => b.classList.remove("open"));
  openIndex = -1;
}

function renderItems(items, parent) {
  const pop = document.createElement("ul");
  pop.className = "menu-pop";
  for (const item of items) {
    const li = document.createElement("li");
    if (item === "-") {
      li.className = "menu-sep";
      pop.append(li);
      continue;
    }
    li.className = "menu-item" + (item.disabled ? " disabled" : "");
    li.tabIndex = -1;
    const check = document.createElement("span");
    check.className = "menu-check";
    check.textContent = item.checked ? "✓" : "";
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    const key = document.createElement("span");
    key.className = "menu-key";
    key.textContent = item.submenu ? "›" : item.shortcut || "";
    li.append(check, label, key);
    if (item.submenu) {
      li.classList.add("has-sub");
      li.onmouseenter = li.onfocus = () => {
        pop.querySelectorAll(":scope > li > .menu-pop").forEach((p) => p.remove());
        const sub = renderItems(item.submenu(), li);
        sub.classList.add("sub");
      };
      li.onmouseleave = (e) => {
        if (!li.contains(e.relatedTarget)) li.querySelector(".menu-pop")?.remove();
      };
    } else if (!item.disabled) {
      li.onclick = (e) => {
        e.stopPropagation();
        close();
        item.run?.();
      };
    }
    pop.append(li);
  }
  parent.append(pop);
  return pop;
}

function open(i) {
  close();
  openIndex = i;
  buttons[i].classList.add("open");
  const wrap = buttons[i].parentElement;
  renderItems(menus[i].items(), wrap);
}

export function createMenubar(spec) {
  menus = spec;
  buttons = spec.map((m, i) => {
    const wrap = document.createElement("div");
    wrap.className = "menu";
    const b = document.createElement("button");
    b.className = "menu-title";
    // Underline the first letter: Alt+that letter opens the menu.
    b.innerHTML = `<u>${m.label[0]}</u>${m.label.slice(1)}`;
    b.onmousedown = (e) => {
      e.preventDefault();
      openIndex === i ? close() : open(i);
    };
    b.onmouseenter = () => openIndex !== -1 && openIndex !== i && open(i);
    wrap.append(b);
    bar.append(wrap);
    return b;
  });
  document.addEventListener("mousedown", (e) => !bar.contains(e.target) && close());
  window.addEventListener("blur", close);

  document.addEventListener(
    "keydown",
    (e) => {
      // Alt+F, Alt+E, ... opens a menu.
      if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Key[A-Z]$/.test(e.code)) {
        const i = menus.findIndex((m) => m.label[0].toUpperCase() === e.code.slice(3));
        if (i !== -1) {
          e.preventDefault();
          e.stopPropagation();
          open(i);
          bar.querySelector(".menu-pop .menu-item:not(.disabled)")?.focus();
          return;
        }
      }
      if (openIndex === -1) return;
      const active = document.activeElement?.closest?.(".menu-pop");
      const items = [...(active || bar.querySelector(".menu-pop")).children].filter(
        (li) => li.classList.contains("menu-item") && !li.classList.contains("disabled")
      );
      const at = items.indexOf(document.activeElement);
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        handled();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        handled();
        const n = items.length;
        items[(at + (e.key === "ArrowDown" ? 1 : n - 1) + (at === -1 && e.key === "ArrowUp" ? 1 : 0)) % n]?.focus();
      } else if (e.key === "ArrowRight") {
        handled();
        if (document.activeElement?.classList.contains("has-sub")) {
          document.activeElement.querySelector(".menu-pop .menu-item")?.focus();
        } else open((openIndex + 1) % menus.length);
      } else if (e.key === "ArrowLeft") {
        handled();
        if (active?.classList.contains("sub")) active.parentElement.focus();
        else open((openIndex - 1 + menus.length) % menus.length);
      } else if (e.key === "Enter") {
        handled();
        document.activeElement?.click();
      }
    },
    true
  );
}

// Show the Alt+letter hints while Alt is held, like Windows menus.
document.addEventListener("keydown", (e) => e.key === "Alt" && document.body.classList.add("alt-held"));
document.addEventListener("keyup", (e) => e.key === "Alt" && document.body.classList.remove("alt-held"));
window.addEventListener("blur", () => document.body.classList.remove("alt-held"));
