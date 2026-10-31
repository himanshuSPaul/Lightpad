// UI checks in Chromium, the engine behind WebView2 on Windows. They catch problems that only show
// there (the end-to-end suite runs on Linux's WebKit). The Rust backend is replaced by an in-memory
// file system, so these check the page, not file access.
//
//   npx vite --port 1420 &   then   node tests/chromium/smoke.cjs
const { chromium } = require("playwright");

const SEP = "\\";
const ROOT = "C:\\proj";

function mockBackend(root) {
  // Runs inside the page.
  const files = new Map([
    [root + "\\hello.py", "import os\n\nclass A:\n    def f(self):\n        return 1\n\n    def g(self):\n        return 2\n"],
    [root + "\\notes.txt", "cat dog cat\n"],
    [root + "\\data.json", '{\n  "a": [1, 2],\n  "b": 3\n}\n'],
    [root + "\\sub\\inner.md", "# Inner\n"],
  ]);
  const dirs = new Set([root, root + "\\sub"]);
  const parent = (p) => p.replace(/\\[^\\]*$/, "");
  const base = (p) => p.split("\\").pop();
  window.__calls = [];
  window.__dialogAnswer = "Cancel";
  window.__dialogs = [];
  localStorage.setItem("lightpad.session", JSON.stringify({ folder: root, tabs: [] }));
  let cb = 0;
  const cmds = {
    list_dir: ({ path }) =>
      [...[...dirs].filter((d) => parent(d) === path && d !== path).map((d) => ({ name: base(d), path: d, is_dir: true })),
       ...[...files.keys()].filter((f) => parent(f) === path).map((f) => ({ name: base(f), path: f, is_dir: false }))]
        .sort((a, b) => b.is_dir - a.is_dir || a.name.localeCompare(b.name)),
    read_file: ({ path }) => {
      if (!files.has(path)) throw "not found";
      return { text: files.get(path), encoding: "UTF-8", modified: 1 };
    },
    write_file: ({ path, contents }) => (files.set(path, contents), 1),
    file_modified: ({ path }) => (files.has(path) ? 1 : null),
    file_exists: ({ path }) => files.has(path),
    create_file: ({ dir, name }) => {
      const p = dir + "\\" + name;
      if (files.has(p)) throw `"${name}" already exists.`;
      files.set(p, "");
      return p;
    },
    create_dir: ({ dir, name }) => (dirs.add(dir + "\\" + name), dir + "\\" + name),
    rename_path: ({ path, newName }) => {
      const to = parent(path) + "\\" + newName;
      if (files.has(to)) throw `"${newName}" already exists.`;
      files.set(to, files.get(path));
      files.delete(path);
      return to;
    },
    delete_path: ({ path }) => void files.delete(path),
    paste_path: ({ src, destDir }) => {
      const to = destDir + "\\" + base(src).replace(/(\.[^.]*)?$/, " - Copy$1");
      files.set(to, files.get(src));
      return to;
    },
    pty_spawn: () => 0,
    pty_write: () => null,
    pty_resize: () => null,
    pty_kill: () => null,
    "plugin:dialog|message": (args) => (window.__dialogs.push(args.message), window.__dialogAnswer),
  };
  window.__files = files;
  window.__TAURI_INTERNALS__ = {
    transformCallback: (f) => {
      const id = ++cb;
      window["_" + id] = f;
      return id;
    },
    unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      window.__calls.push(cmd);
      const fn = cmds[cmd];
      return fn ? fn(args || {}) : null;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name, String(e.message || e).split("\n")[0]]);
  }
  console.log(results.at(-1).join("  "));
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(mockBackend, ROOT);
  await page.goto(process.env.LIGHTPAD_URL || "http://localhost:1420");
  await page.waitForTimeout(1200);

  const node = (name) => page.locator(".node", { has: page.locator(".label", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) });
  const ctx = async (name, item) => {
    await node(name).click({ button: "right" });
    await page.click(`#ctx-menu li:has(span:text-is("${item}"))`);
    await page.waitForTimeout(250);
  };
  const tabNames = () => page.$$eval("#tabs .tab span", (e) => e.map((x) => x.textContent));
  const active = () => page.textContent("#tabs .tab.active span");
  const disk = (p) => page.evaluate((p) => window.__files.get(p), p);
  const prompt = async (text) => {
    await page.keyboard.press("Control+a");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  };

  await check("Explorer lists the folder", async () => {
    assert((await node("hello.py").count()) === 1, "hello.py not listed");
  });
  await check("Clicking a file opens it with the right language", async () => {
    await node("hello.py").click();
    await page.waitForTimeout(400);
    assert((await active()) === "hello.py", await active());
    assert((await page.textContent("#st-lang")) === "Python", await page.textContent("#st-lang"));
  });
  await check("Typing then Ctrl+S saves", async () => {
    await page.click(".cm-content");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("# end");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(300);
    assert((await disk(ROOT + "\\hello.py")).endsWith("# end"), "not saved");
  });
  await check("Rename an open file from the right-click menu", async () => {
    await ctx("hello.py", "Rename...");
    const sel = await page.evaluate(() => {
      const i = document.querySelector("#ask-box input");
      return i && i.value.slice(i.selectionStart, i.selectionEnd);
    });
    assert(sel === "hello", `selected ${sel}`);
    await page.keyboard.type("app");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    assert((await tabNames()).includes("app.py"), JSON.stringify(await tabNames()));
    assert(await disk(ROOT + "\\app.py"), "not renamed on disk");
  });
  await check("Rename with F2", async () => {
    await node("notes.txt").click();
    await page.waitForTimeout(300);
    await page.focus("#tree");
    await page.keyboard.press("F2");
    await prompt("todo.txt");
    assert(await disk(ROOT + "\\todo.txt"), "F2 rename failed");
  });
  await check("Escape cancels the name box", async () => {
    await ctx("todo.txt", "Rename...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert(!(await page.$("#ask-box")), "box still open");
    assert(await disk(ROOT + "\\todo.txt"), "file changed");
  });
  await check("Rename to an existing name shows an error", async () => {
    await ctx("todo.txt", "Rename...");
    await prompt("app.py");
    const msgs = await page.evaluate(() => window.__dialogs);
    assert(msgs.some((m) => /already exists/.test(m)), JSON.stringify(msgs));
  });
  await check("New File in a folder opens the new file", async () => {
    await ctx("sub", "New File...");
    await prompt("made.rs");
    assert((await disk(ROOT + "\\sub\\made.rs")) === "", "not created");
    assert((await active()) === "made.rs" && (await page.textContent("#st-lang")) === "Rust", await active());
  });
  await check("New Folder", async () => {
    await ctx("sub", "New Folder...");
    await prompt("lib");
    assert(await page.evaluate((r) => window.__calls.includes("create_dir"), ROOT), "create_dir not called");
  });
  await check("Copy and Paste", async () => {
    await ctx("todo.txt", "Copy");
    await ctx("todo.txt", "Paste");
    assert(await disk(ROOT + "\\todo - Copy.txt"), "no copy");
  });
  await check("Delete asks, Cancel keeps the file", async () => {
    await page.evaluate(() => (window.__dialogAnswer = "Cancel"));
    await ctx("todo - Copy.txt", "Delete");
    assert(await disk(ROOT + "\\todo - Copy.txt"), "deleted after Cancel");
  });
  await check("Delete confirmed removes the file and its tab", async () => {
    await node("todo - Copy.txt").click();
    await page.waitForTimeout(300);
    await page.evaluate(() => (window.__dialogAnswer = "Delete"));
    await ctx("todo - Copy.txt", "Delete");
    await page.waitForTimeout(300);
    assert((await disk(ROOT + "\\todo - Copy.txt")) === undefined, "not deleted");
    assert(!(await tabNames()).includes("todo - Copy.txt"), "tab left open");
  });
  await check("Click a file, press Delete: deletes the file, not text in it", async () => {
    await page.evaluate(() => window.__files.set("C:\\proj\\gone.txt", "keep my text"));
    await page.click("[data-cmd=refreshTree]");
    await page.waitForTimeout(300);
    await page.evaluate(() => (window.__dialogAnswer = "Delete"));
    await node("gone.txt").click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(400);
    assert((await disk(ROOT + "\\gone.txt")) === undefined, "file not deleted");
    assert(!(await tabNames()).includes("gone.txt"), "tab left open");
  });
  await check("Click a file, press F2: renames it", async () => {
    await node("data.json").click();
    await page.waitForTimeout(300);
    await page.keyboard.press("F2");
    await prompt("info.json");
    assert(await disk(ROOT + "\\info.json"), "not renamed");
  });
  await check("Double-click a file moves the cursor into the editor", async () => {
    await node("info.json").dblclick();
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.activeElement.classList.contains("cm-content")), "editor not focused");
  });
  await check("Every menu opens with Alt+letter and closes with Escape", async () => {
    for (const k of ["f", "e", "v", "l", "t", "w"]) {
      await page.keyboard.press("Alt+" + k);
      await page.waitForTimeout(150);
      assert(await page.$("#menubar .menu-pop"), "menu Alt+" + k + " did not open");
      await page.keyboard.press("Escape");
    }
  });
  await check("Ctrl+Tab switches to the previous file", async () => {
    await node("info.json").click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+Tab");
    await page.waitForTimeout(250);
    const now = await active();
    assert(now !== "info.json", now);
    await page.keyboard.press("Control+Tab");
    await page.waitForTimeout(250);
    assert((await active()) === "info.json", await active());
  });
  await check("Holding Ctrl shows the switcher list; releasing opens the pick", async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    const shown = await page.isVisible("#switcher");
    const pick = await page.textContent("#switcher .sel span");
    await page.keyboard.up("Control");
    await page.waitForTimeout(250);
    assert(shown, "switcher not shown");
    assert((await active()) === pick, `${await active()} != ${pick}`);
    assert(!(await page.isVisible("#switcher")), "switcher still shown");
  });
  await check("Ctrl+1 and Ctrl+PgDn", async () => {
    await page.keyboard.press("Control+1");
    await page.waitForTimeout(200);
    const first = (await tabNames())[0];
    assert((await active()) === first, await active());
    await page.keyboard.press("Control+PageDown");
    await page.waitForTimeout(200);
    assert((await active()) === (await tabNames())[1], await active());
  });
  await check("Language picker: 'rs' picks Rust", async () => {
    await page.keyboard.press("Control+Shift+L");
    await page.keyboard.type("rs");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert((await page.textContent("#st-lang")) === "Rust", await page.textContent("#st-lang"));
  });
  await check("Find and Replace All", async () => {
    await page.evaluate(() => window.__files.set("C:\\proj\\pets.txt", "cat dog cat\n"));
    await page.click("[data-cmd=refreshTree]");
    await page.waitForTimeout(300);
    await node("pets.txt").click();
    await page.waitForTimeout(300);
    await page.click(".cm-content");
    await page.keyboard.press("Control+h");
    await page.waitForTimeout(200);
    await page.fill(".cm-search input[name=search]", "cat");
    await page.fill(".cm-search input[name=replace]", "cow");
    await page.click(".cm-search button[name=replaceAll]");
    await page.click(".cm-content");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(300);
    assert((await disk(ROOT + "\\pets.txt")) === "cow dog cow\n", JSON.stringify(await disk(ROOT + "\\pets.txt")));
  });
  await check("Folding: Alt+0 folds, Alt+Shift+0 unfolds", async () => {
    await node("app.py").click();
    await page.waitForTimeout(300);
    await page.click(".cm-content");
    await page.keyboard.press("Alt+0");
    await page.waitForTimeout(200);
    const folded = await page.$$eval(".cm-foldPlaceholder", (e) => e.length);
    await page.keyboard.press("Alt+Shift+0");
    await page.waitForTimeout(200);
    const after = await page.$$eval(".cm-foldPlaceholder", (e) => e.length);
    assert(folded >= 1 && after === 0, `${folded} ${after}`);
  });
  await check("Zoom: Ctrl+= and Ctrl+0 in the editor", async () => {
    await page.click(".cm-content");
    await page.keyboard.press("Control+Equal");
    const big = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-font-size").trim());
    await page.keyboard.press("Control+0");
    const back = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-font-size").trim());
    assert(big === "15px" && back === "14px", `${big} ${back}`);
  });
  await check("Closing a changed tab asks; Cancel keeps it", async () => {
    await page.click(".cm-content");
    await page.keyboard.type("x");
    const n = (await tabNames()).length;
    await page.evaluate(() => (window.__dialogAnswer = "Cancel"));
    await page.keyboard.press("Control+w");
    await page.waitForTimeout(300);
    assert((await tabNames()).length === n, "tab closed after Cancel");
  });
  await check("No script errors during the run", async () => {
    assert(errors.length === 0, errors.join(" | "));
  });

  await browser.close();
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
