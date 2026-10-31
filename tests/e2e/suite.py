"""End-to-end tests for Lightpad, driving the real release build through tauri-driver."""
import os, sys, time, json, shutil, subprocess, traceback, glob
from harness import App, seed
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains

QA = os.environ.get("LIGHTPAD_QA_DIR", "/tmp/lightpad-e2e")
WS = f"{QA}/ws"
HOME = f"{QA}/home-suite"
SHOTS = f"{QA}/fail-shots"
results = []
app = None


# ---------- helpers ----------

def fresh_ws():
    shutil.rmtree(WS, ignore_errors=True)
    os.makedirs(WS)
    return WS

def write(rel, data, mode="w"):
    p = os.path.join(WS, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode if isinstance(data, str) else "wb") as f:
        f.write(data)
    return p

def read(rel, binary=False):
    with open(os.path.join(WS, rel), "rb" if binary else "r", newline="" if not binary else None) as f:
        return f.read()

def js(code, *args):
    return app.js(code, *args)

def keys(*combo):
    """keys(Keys.CONTROL, "s") presses a chord."""
    ch = ActionChains(app.d)
    mods = [k for k in combo[:-1]]
    for m in mods: ch.key_down(m)
    ch.send_keys(combo[-1])
    for m in reversed(mods): ch.key_up(m)
    ch.perform()
    time.sleep(0.4)

def editor():
    return app.d.find_element(By.CSS_SELECTOR, ".cm-content")

def type_text(text):
    editor().send_keys(text)
    time.sleep(0.3)

def node(path):
    return app.d.find_element(By.CSS_SELECTOR, f'#tree .node[data-path="{path}"]')

def open_file(rel):
    node(os.path.join(WS, rel)).click()
    time.sleep(0.8)

def expand(rel):
    node(os.path.join(WS, rel)).click()
    time.sleep(0.6)

def open_ws(**settings):
    seed(app, {"folder": WS, "tabs": []}, **settings)

def status():
    return js("return Object.fromEntries(['st-path','st-zoom','st-pos','st-lang','st-eol','st-enc'].map(i=>[i.slice(3), document.getElementById(i).textContent]))")

def tabs():
    return js("return [...document.querySelectorAll('#tabs .tab')].map(t=>({name:t.querySelector('span').textContent, cls:t.className}))")

def active_tab():
    return next((t for t in tabs() if "active" in t["cls"]), None)

def visible_text():
    return js("return document.querySelector('.cm-content').innerText")

def ctx(path, label):
    # A real X right-click: WebDriver's context_click also fires a left click in this webview.
    xy = js("""const n=document.querySelector(`#tree .node[data-path="${CSS.escape(arguments[0])}"]`);
               n.scrollIntoView({block:'nearest'});
               const r=n.getBoundingClientRect(); return [Math.round(r.x+20), Math.round(r.y+r.height/2)];""", path)
    sh(f"xdotool mousemove {xy[0]} {xy[1]} click 3")
    time.sleep(0.5)
    labels = js("return [...document.querySelectorAll('#ctx-menu li:not(.ctx-sep)')].map(li => li.firstChild.textContent)")
    if label not in labels:
        raise AssertionError(f"menu item {label!r} not found in {labels}")
    js("[...document.querySelectorAll('#ctx-menu li:not(.ctx-sep)')].find(li => li.firstChild.textContent === arguments[0]).click()", label)
    time.sleep(0.6)

def menu(title, *path):
    """Opens a menu-bar menu and clicks through `path` (submenus are opened by focusing them)."""
    js("""const b=[...document.querySelectorAll('#menubar .menu-title')].find(b=>b.textContent===arguments[0]);
          b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));""", title)
    time.sleep(0.3)
    for i, label in enumerate(path):
        found = js("""const li=[...document.querySelectorAll('#menubar .menu-pop .menu-item')].reverse()
                        .find(li=>li.querySelector('.menu-label').textContent===arguments[0]);
                      if(!li) return false; if(arguments[1]) li.click(); else li.focus(); return true;""",
                   label, i == len(path) - 1)
        assert found, f"menu item {label!r} not found under {title}"
        time.sleep(0.4)

def answer_prompt(text):
    box = app.d.find_element(By.CSS_SELECTOR, "#ask-box input")
    box.send_keys(Keys.CONTROL, "a")
    box.send_keys(text, Keys.ENTER)
    time.sleep(1)

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout

def dialogs():
    """Native dialog windows (anything visible other than the main window)."""
    out = []
    for wid in sh("xdotool search --onlyvisible --name . 2>/dev/null").split():
        name = sh(f"xdotool getwindowname {wid}").strip()
        if not name.endswith(" - Lightpad"):
            g = dict(l.strip().split(": ", 1) for l in sh(f"xdotool getwindowgeometry --shell {wid}").splitlines() if "=" in l and False) if False else None
            geo = {k: int(v) for k, v in (l.split("=") for l in sh(f"xdotool getwindowgeometry --shell {wid}").split())}
            out.append({"id": wid, "name": name, **geo})
    return out

def wait_dialog(timeout=4):
    end = time.time() + timeout
    while time.time() < end:
        d = dialogs()
        if d: return d[0]
        time.sleep(0.3)
    return None

def press_dialog_button(index, count):
    """Clicks button `index` of `count` buttons laid out along the dialog's bottom edge."""
    d = wait_dialog()
    assert d, "expected a dialog"
    x = d["X"] + int(d["WIDTH"] * (index + 0.5) / count)
    y = d["Y"] + d["HEIGHT"] - 16
    sh(f"xdotool mousemove {x} {y} click 1")
    time.sleep(1)

def dismiss_dialog():
    d = wait_dialog()
    if d:
        sh(f"xdotool mousemove {d['X'] + d['WIDTH'] - 30} {d['Y'] + d['HEIGHT'] - 16} click 1")
        time.sleep(0.8)
    return d

def dialog_text():
    """Text of the dialog, read via a screenshot OCR-free path: the window name is the title."""
    d = wait_dialog()
    return d and d["name"]

def clipboard():
    return sh("xclip -o -selection clipboard 2>/dev/null")

def term_text():
    return js("const h=[...document.querySelectorAll('.term-host')].find(h=>!h.hidden); return h ? h.querySelector('.xterm-rows').innerText : ''")


# ---------- runner ----------

def test(area, name):
    def wrap(fn):
        fn._meta = (area, name)
        TESTS.append(fn)
        return fn
    return wrap

TESTS = []

def run(only=None):
    global app
    os.makedirs(QA, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)
    shutil.rmtree(HOME, ignore_errors=True)
    app = App(home=HOME)
    for fn in TESTS:
        area, name = fn._meta
        if only and only not in fn.__name__: continue
        fresh_ws()
        t0 = time.time()
        try:
            for d in dialogs(): dismiss_dialog()
            note = fn()
            results.append((area, name, "PASS", note or "", time.time() - t0))
        except Exception as e:
            msg = str(e).split("\n")[0] if isinstance(e, AssertionError) else traceback.format_exc(limit=1).strip().splitlines()[-1]
            results.append((area, name, "FAIL", msg, time.time() - t0))
            sh(f"import -window root {SHOTS}/{fn.__name__}.png")
            for d in dialogs(): dismiss_dialog()
            # A failure can leave the app in a bad state: restart it.
            app.quit(); app = App(home=HOME)
        print(f"{results[-1][2]}  {area}: {name}  {results[-1][3]}", flush=True)
    app.quit()
    with open(os.environ.get("RESULTS", f"{QA}/results.json"), "w") as f:
        json.dump(results, f, indent=1)


# ---------- tests: files and encodings ----------

@test("Files", "Open a UTF-8 file, edit it and save with Ctrl+S")
def t_open_edit_save():
    write("a.txt", "hello\nworld")
    open_ws(); open_file("a.txt")
    assert "hello" in visible_text()
    editor().send_keys(Keys.CONTROL, Keys.END); type_text("!")
    assert "dirty" in active_tab()["cls"], "tab not marked dirty after typing"
    title = js("return document.title")  # title is set on the native window; checked below
    keys(Keys.CONTROL, "s")
    assert read("a.txt") == "hello\nworld!", repr(read("a.txt"))
    assert "dirty" not in active_tab()["cls"], "tab still dirty after save"
    assert not glob.glob(WS + "/.*lightpad-save"), "temp file left behind"

@test("Files", "Window title shows * while there are unsaved changes")
def t_title_star():
    write("a.txt", "x")
    open_ws(); open_file("a.txt")
    type_text("y")
    t = sh("xdotool getwindowname $(xdotool search --onlyvisible --name ' - Lightpad' | head -1)").strip()
    assert t.startswith("*") and t.endswith("a.txt - Lightpad"), t
    keys(Keys.CONTROL, "s")
    t = sh("xdotool getwindowname $(xdotool search --onlyvisible --name ' - Lightpad' | head -1)").strip()
    assert not t.startswith("*"), t

@test("Files", "Undo back to the saved text clears the unsaved marker")
def t_undo_clean():
    write("a.txt", "abc")
    open_ws(); open_file("a.txt")
    type_text("zz")
    keys(Keys.CONTROL, "z")
    assert "dirty" not in active_tab()["cls"], tabs()

@test("Files", "Windows line endings (CRLF) are kept when saving")
def t_crlf():
    write("w.txt", b"one\r\ntwo\r\n")
    open_ws(); open_file("w.txt")
    assert status()["eol"] == "CRLF", status()
    editor().send_keys(Keys.CONTROL, Keys.END); type_text("three"); editor().send_keys(Keys.ENTER)
    keys(Keys.CONTROL, "s")
    assert read("w.txt", True) == b"one\r\ntwo\r\nthree\r\n", read("w.txt", True)

@test("Files", "UTF-16 LE file keeps its encoding and BOM")
def t_utf16():
    write("u16.txt", "\ufeffhéllo €".encode("utf-16-le"))
    open_ws(); open_file("u16.txt")
    assert status()["enc"] == "UTF-16 LE", status()
    assert "héllo €" in visible_text()
    editor().send_keys(Keys.CONTROL, Keys.END); type_text("!")
    keys(Keys.CONTROL, "s")
    assert read("u16.txt", True) == "\ufeffhéllo €!".encode("utf-16-le")

@test("Files", "UTF-8 with BOM keeps the BOM")
def t_bom():
    write("b.txt", b"\xef\xbb\xbfhi")
    open_ws(); open_file("b.txt")
    assert status()["enc"] == "UTF-8 BOM"
    type_text("x"); keys(Keys.CONTROL, "s")
    assert read("b.txt", True).startswith(b"\xef\xbb\xbf")

@test("Files", "Legacy Windows-1252 (ANSI) file is shown correctly and saved byte for byte")
def t_ansi():
    write("ansi.txt", "café – naïve".encode("cp1252"))
    open_ws(); open_file("ansi.txt")
    assert status()["enc"] == "Windows-1252", status()
    assert "café – naïve" in visible_text(), visible_text()
    editor().send_keys(Keys.CONTROL, Keys.END); type_text("!"); keys(Keys.CONTROL, "s")
    assert read("ansi.txt", True) == "café – naïve!".encode("cp1252")

@test("Files", "Typing a character ANSI can't store gives an error and leaves the file alone")
def t_ansi_unstorable():
    write("ansi.txt", "café".encode("cp1252"))
    open_ws(); open_file("ansi.txt")
    type_text("日本"); keys(Keys.CONTROL, "s")
    assert wait_dialog(), "no error dialog"
    dismiss_dialog()
    assert read("ansi.txt", True) == "café".encode("cp1252")
    assert "dirty" in active_tab()["cls"]

@test("Files", "Binary files are refused with a message")
def t_binary():
    write("app.exe", b"MZ\x90\x00\x03\x00\x00\x00")
    open_ws(); open_file("app.exe")
    assert wait_dialog(), "no error dialog"
    dismiss_dialog()
    assert not any(t["name"] == "app.exe" for t in tabs()), tabs()

@test("Files", "Files over 50 MB are refused with a message")
def t_huge():
    with open(WS + "/big.log", "wb") as f:
        f.truncate(51 * 1024 * 1024)
        f.seek(0); f.write(b"x")
    open_ws(); open_file("big.log")
    assert wait_dialog(), "no error dialog"
    dismiss_dialog()
    assert not any(t["name"] == "big.log" for t in tabs())

@test("Files", "Empty file opens and saves")
def t_empty():
    write("e.txt", "")
    open_ws(); open_file("e.txt")
    type_text("now"); keys(Keys.CONTROL, "s")
    assert read("e.txt") == "now"

@test("Files", "File and folder names with spaces and Unicode")
def t_unicode_names():
    write("日本 folder/naïve file (1).txt", "x")
    open_ws(); expand("日本 folder"); open_file("日本 folder/naïve file (1).txt")
    type_text("y"); keys(Keys.CONTROL, "s")
    assert read("日本 folder/naïve file (1).txt") == "yx"

@test("Files", "Opening the same file twice reuses its tab")
def t_same_file():
    write("a.txt", "x")
    open_ws(); open_file("a.txt"); open_file("a.txt")
    assert [t["name"] for t in tabs()].count("a.txt") == 1, tabs()

@test("Files", "5 MB file opens quickly and stays responsive")
def t_large_perf():
    write("big.txt", ("line of text number %d with some words\n" * 1) * 0 + "".join(f"line of text number {i} with some words\n" for i in range(130000)))
    open_ws()
    t0 = time.time(); open_file("big.txt")
    js("return 1")
    opened = time.time() - t0
    t0 = time.time()
    for _ in range(20): editor().send_keys("a")
    typing = (time.time() - t0) / 20
    assert opened < 4, f"took {opened:.1f}s to open"
    assert typing < 0.25, f"{typing*1000:.0f} ms per key"
    return f"open {opened:.1f}s, {typing*1000:.0f} ms per keystroke"

@test("Files", "A 1 MB single line (minified file) opens")
def t_long_line():
    write("min.js", "var a=1;" * 130000)
    open_ws(); open_file("min.js")
    assert active_tab()["name"] == "min.js"
    assert status()["lang"] == "JavaScript"

@test("Files", "Saving a read-only file shows an error and changes nothing")
def t_readonly():
    p = write("ro.txt", "keep")
    os.chmod(p, 0o444)
    open_ws(); open_file("ro.txt")
    type_text("x"); keys(Keys.CONTROL, "s")
    d = wait_dialog(2)
    if d: dismiss_dialog()
    content = read("ro.txt")
    os.chmod(p, 0o644)
    # Running as root ignores file permissions, so only check when not root.
    if os.geteuid() == 0:
        return "skipped: tests run as root, which can write read-only files"
    assert d, "no error dialog"
    assert content == "keep"

@test("Files", "Saving overwrites a file that another program changed since it was opened (no warning)")
def t_external_change():
    write("a.txt", "v1")
    open_ws(); open_file("a.txt")
    write("a.txt", "changed by another program")
    # Switch away and back, as a user would.
    sh("xdotool key super"); js("window.dispatchEvent(new Event('focus'))"); time.sleep(1)
    reloaded = "changed by another program" in visible_text()
    type_text("x"); keys(Keys.CONTROL, "s")
    d = wait_dialog(2)
    if d: dismiss_dialog()
    assert reloaded or d, f"no reload and no warning: disk now {read('a.txt')!r}"


# ---------- tests: tabs ----------

@test("Tabs", "Ctrl+N, Ctrl+Tab and Ctrl+W on a clean tab")
def t_tabs_basic():
    open_ws()
    keys(Keys.CONTROL, "n"); keys(Keys.CONTROL, "n")
    names = [t["name"] for t in tabs()]
    assert len(names) >= 2, names
    first = active_tab()["name"]
    keys(Keys.CONTROL, Keys.TAB)
    assert active_tab()["name"] != first
    n = len(tabs()); keys(Keys.CONTROL, "w")
    assert len(tabs()) == n - 1

@test("Tabs", "Closing a tab with changes asks; Cancel keeps it, Don't Save closes it")
def t_close_dirty():
    write("a.txt", "x")
    open_ws(); open_file("a.txt"); keys(Keys.CONTROL, "n"); type_text("draft")
    n = len(tabs())
    keys(Keys.CONTROL, "w")
    press_dialog_button(2, 3)  # Cancel
    assert len(tabs()) == n, "Cancel closed the tab"
    keys(Keys.CONTROL, "w")
    press_dialog_button(1, 3)  # Don't Save
    assert len(tabs()) == n - 1, "Don't Save didn't close the tab"

@test("Tabs", "Closing a changed file and choosing Save writes it")
def t_close_save():
    write("a.txt", "x")
    open_ws(); open_file("a.txt"); type_text("y")
    keys(Keys.CONTROL, "w")
    press_dialog_button(0, 3)  # Save
    assert read("a.txt") == "yx"

@test("Tabs", "Pin Tab keeps the tab first and Close All leaves it open")
def t_pin():
    for n in "abc": write(f"{n}.txt", n)
    open_ws()
    for n in "abc": open_file(f"{n}.txt")
    ctx(WS + "/c.txt", "Pin Tab")
    assert tabs()[0]["name"] == "c.txt" and "pinned" in tabs()[0]["cls"], tabs()
    menu("File", "Close All"); time.sleep(0.5)
    assert [t["name"] for t in tabs()] == ["c.txt"], tabs()

@test("Tabs", "Document List shows open files, unsaved ones in red, and sorts by name")
def t_doclist():
    for n in ["b.py", "a.txt"]: write(n, "x")
    open_ws(docList=True)
    open_file("b.py"); open_file("a.txt"); type_text("z")
    rows = js("return [...document.querySelectorAll('#doclist .doc-row')].map(r=>[r.innerText.replace(/\\s+/g,''), r.querySelector('path').getAttribute('fill')])")
    assert any(r[0] == "a.txt" and r[1] == "#dc2626" for r in rows), rows
    app.d.find_element(By.CSS_SELECTOR, '#doclist-cols button[data-sort="name"]').click(); time.sleep(0.3)
    names = js("return [...document.querySelectorAll('#doclist .doc-name')].map(r=>r.textContent)")
    assert names == sorted(names, key=str.lower), names


# ---------- tests: explorer ----------

@test("Explorer", "New File from a folder's right-click menu creates and opens it")
def t_new_file():
    os.makedirs(WS + "/src")
    open_ws(); ctx(WS + "/src", "New File...")
    answer_prompt("main.py")
    assert os.path.isfile(WS + "/src/main.py")
    assert active_tab()["name"] == "main.py"
    assert status()["lang"] == "Python"

@test("Explorer", "New Folder")
def t_new_folder():
    os.makedirs(WS + "/src")
    open_ws(); ctx(WS + "/src", "New Folder...")
    answer_prompt("lib")
    assert os.path.isdir(WS + "/src/lib")

@test("Explorer", "Rename with F2; the open tab follows the new name")
def t_rename():
    write("old.txt", "x")
    open_ws(); open_file("old.txt")
    node(WS + "/old.txt").click(); time.sleep(0.5)
    app.d.find_element(By.ID, "tree").send_keys(Keys.F2); time.sleep(0.4)
    sel = js("const i=document.querySelector('#ask-box input'); return i.value.slice(i.selectionStart,i.selectionEnd)")
    assert sel == "old", f"selected {sel!r}, expected the name without extension"
    answer_prompt("new.md")
    assert os.path.exists(WS + "/new.md") and not os.path.exists(WS + "/old.txt")
    assert active_tab()["name"] == "new.md", tabs()
    assert status()["lang"] == "Markdown"
    type_text("y"); keys(Keys.CONTROL, "s")
    assert read("new.md") == "yx" and not os.path.exists(WS + "/old.txt")

@test("Explorer", "Rename to a name that already exists is refused")
def t_rename_clash():
    write("a.txt", "A"); write("b.txt", "B")
    open_ws(); ctx(WS + "/a.txt", "Rename...")
    answer_prompt("b.txt")
    assert wait_dialog(), "no error dialog"
    dismiss_dialog()
    assert read("a.txt") == "A" and read("b.txt") == "B"

@test("Explorer", "Rename that only changes letter case does not overwrite another file")
def t_rename_case():
    write("a.txt", "lower"); write("A.txt", "UPPER")
    open_ws(); ctx(WS + "/a.txt", "Rename...")
    answer_prompt("A.txt")
    d = wait_dialog(2)
    if d: dismiss_dialog()
    assert os.path.exists(WS + "/A.txt") and read("A.txt") == "UPPER", \
        f"A.txt was overwritten: now {read('A.txt')!r}, a.txt exists={os.path.exists(WS + '/a.txt')}"

@test("Explorer", "Copy and Paste makes 'name - Copy'")
def t_copy_paste():
    write("notes.txt", "n")
    open_ws(); ctx(WS + "/notes.txt", "Copy"); ctx(WS + "/notes.txt", "Paste")
    assert read("notes - Copy.txt") == "n"
    ctx(WS + "/notes.txt", "Paste")
    assert os.path.exists(WS + "/notes - Copy (2).txt")

@test("Explorer", "Cut and Paste into a folder moves the file; its tab follows")
def t_cut_paste():
    write("m.txt", "m"); os.makedirs(WS + "/dest")
    open_ws(); open_file("m.txt")
    ctx(WS + "/m.txt", "Cut"); ctx(WS + "/dest", "Paste")
    assert os.path.exists(WS + "/dest/m.txt") and not os.path.exists(WS + "/m.txt")
    type_text("z"); keys(Keys.CONTROL, "s")
    assert read("dest/m.txt") == "zm" and not os.path.exists(WS + "/m.txt"), "saved to the old place"

@test("Explorer", "Keyboard Ctrl+C / Ctrl+V in the tree")
def t_tree_keys():
    write("k.txt", "k")
    open_ws(); node(WS + "/k.txt").click(); time.sleep(0.3)
    tree = app.d.find_element(By.ID, "tree")
    tree.send_keys(Keys.CONTROL, "c"); tree.send_keys(Keys.CONTROL, "v"); time.sleep(1)
    assert os.path.exists(WS + "/k - Copy.txt")

@test("Explorer", "Pasting a folder into itself is refused")
def t_paste_into_self():
    os.makedirs(WS + "/f/sub")
    open_ws(); expand("f")
    ctx(WS + "/f", "Copy"); ctx(WS + "/f/sub", "Paste")
    assert wait_dialog(), "no error dialog"
    dismiss_dialog()
    assert os.listdir(WS + "/f/sub") == []

@test("Explorer", "Copying a folder that contains a link back to itself")
def t_symlink_loop():
    os.makedirs(WS + "/proj")
    write("proj/a.txt", "a")
    os.symlink(WS + "/proj", WS + "/proj/self")
    open_ws(); ctx(WS + "/proj", "Copy"); ctx(WS + "/proj", "Paste")
    time.sleep(3)
    d = wait_dialog(1)
    if d: dismiss_dialog()
    alive = js("return 1") == 1
    depth = sh(f"find '{WS}/proj - Copy' -maxdepth 50 2>/dev/null | awk -F/ '{{print NF}}' | sort -n | tail -1").strip()
    assert alive, "app stopped responding"
    assert not depth or int(depth) < 12, f"copy recursed into the link: {depth} levels deep"

@test("Explorer", "Delete asks first and moves the file to the trash")
def t_delete():
    write("trash-me.txt", "t")
    open_ws(); open_file("trash-me.txt")
    ctx(WS + "/trash-me.txt", "Delete")
    press_dialog_button(1, 2)  # Cancel
    assert os.path.exists(WS + "/trash-me.txt"), "Cancel deleted the file"
    ctx(WS + "/trash-me.txt", "Delete")
    press_dialog_button(0, 2)  # Delete
    assert not os.path.exists(WS + "/trash-me.txt")
    assert glob.glob(HOME + "/.local/share/Trash/files/trash-me*"), "not in the trash"
    assert not any(t["name"] == "trash-me.txt" for t in tabs()), "tab left open"

@test("Explorer", "Copy Path and Copy Relative Path")
def t_copy_paths():
    write("sub/x.py", "x")
    open_ws(); expand("sub")
    ctx(WS + "/sub/x.py", "Copy Path")
    assert clipboard() == WS + "/sub/x.py", clipboard()
    ctx(WS + "/sub/x.py", "Copy Relative Path")
    assert clipboard() == "sub/x.py", clipboard()

@test("Explorer", "Copy Relative Path for a folder whose name starts like the open folder")
def t_rel_prefix():
    # Open folder /…/ws/app, file in sibling /…/ws/app2 can't be in the tree; check via the open folder's own root.
    os.makedirs(WS + "/app"); write("app/a.txt", "a")
    seed(app, {"folder": WS + "/app", "tabs": []})
    ctx(WS + "/app/a.txt", "Copy Relative Path")
    assert clipboard() == "a.txt", clipboard()

@test("Explorer", "Files created outside the app appear when the window gets focus")
def t_external_new():
    open_ws()
    write("outside.txt", "o")
    js("window.dispatchEvent(new Event('focus'))"); time.sleep(1)
    node(WS + "/outside.txt")

@test("Explorer", "Collapse all and refresh buttons; Ctrl+B hides the explorer")
def t_explorer_ui():
    os.makedirs(WS + "/d1/d2")
    open_ws(); expand("d1")
    node(WS + "/d1/d2")
    js("document.querySelector('[data-cmd=collapseTree]').click()"); time.sleep(0.5)
    assert not app.d.find_elements(By.CSS_SELECTOR, f'#tree .node[data-path="{WS}/d1/d2"]')
    keys(Keys.CONTROL, "b")
    assert js("return document.getElementById('explorer-pane').hidden")
    keys(Keys.CONTROL, "b")
    assert not js("return document.getElementById('explorer-pane').hidden")


# ---------- tests: languages ----------

@test("Languages", "Language is picked from the file name")
def t_detect():
    cases = {"a.py": "Python", "b.bat": "Batch File", "c.json": "JSON", "d.rs": "Rust", "e.sql": "SQL",
             "f.yaml": "YAML", "g.ps1": "PowerShell", "h.cs": "C#", "Dockerfile": "Dockerfile",
             "notes.unknownext": "Plain Text", "i.html": "HTML", "j.ts": "TypeScript"}
    for n in cases: write(n, "x")
    open_ws()
    wrong = {}
    for n, want in cases.items():
        open_file(n)
        if status()["lang"] != want: wrong[n] = status()["lang"]
    assert not wrong, wrong

@test("Languages", "Syntax colours are applied (Python keywords coloured)")
def t_highlight():
    write("a.py", "def f():\n    return 1\n")
    open_ws(); open_file("a.py"); time.sleep(0.5)
    colours = js("return [...document.querySelectorAll('.cm-line span')].map(s=>getComputedStyle(s).color)")
    assert len(set(colours)) >= 2, colours

@test("Languages", "Language picker: type 'rs', Enter picks Rust")
def t_picker():
    write("a.txt", "fn main() {}")
    open_ws(); open_file("a.txt")
    keys(Keys.CONTROL, Keys.SHIFT, "l")
    app.d.find_element(By.ID, "lang-filter").send_keys("rs", Keys.ENTER); time.sleep(0.5)
    assert status()["lang"] == "Rust", status()

@test("Languages", "A language picked by hand is remembered after restart")
def t_lang_persist():
    global app
    write("a.txt", "x")
    open_ws(); open_file("a.txt")
    keys(Keys.CONTROL, Keys.SHIFT, "l")
    app.d.find_element(By.ID, "lang-filter").send_keys("python", Keys.ENTER); time.sleep(1)
    app.quit(); app = App(home=HOME)
    assert active_tab()["name"] == "a.txt" and status()["lang"] == "Python", (tabs(), status())


# ---------- tests: editing ----------

@test("Editing", "Find (Ctrl+F) and Replace All (Ctrl+H)")
def t_replace():
    write("a.txt", "cat dog cat")
    open_ws(); open_file("a.txt")
    keys(Keys.CONTROL, "h")
    app.d.find_element(By.CSS_SELECTOR, ".cm-search input[name=search]").send_keys("cat")
    app.d.find_element(By.CSS_SELECTOR, ".cm-search input[name=replace]").send_keys("cow")
    app.d.find_element(By.CSS_SELECTOR, ".cm-search button[name=replaceAll]").click(); time.sleep(0.3)
    keys(Keys.CONTROL, "s")
    assert read("a.txt") == "cow dog cow", read("a.txt")

@test("Editing", "Go to line (Ctrl+G)")
def t_goto():
    write("a.txt", "\n".join(str(i) for i in range(1, 101)))
    open_ws(); open_file("a.txt")
    keys(Keys.CONTROL, "g")
    inp = app.d.find_element(By.CSS_SELECTOR, ".cm-panel input")
    inp.send_keys("50", Keys.ENTER); time.sleep(0.4)
    assert status()["pos"].startswith("Ln 50"), status()

@test("Editing", "Toggle comment (Ctrl+/) in Python")
def t_comment():
    write("a.py", "x = 1")
    open_ws(); open_file("a.py")
    editor().send_keys(Keys.CONTROL, "/"); time.sleep(0.3)
    keys(Keys.CONTROL, "s")
    assert read("a.py") == "# x = 1", read("a.py")

@test("Editing", "Word wrap (Alt+Z) toggles")
def t_wrap():
    write("a.txt", "x")
    open_ws(); open_file("a.txt")
    before = js("return document.querySelector('.cm-content').classList.contains('cm-lineWrapping')")
    keys(Keys.ALT, "z")
    after = js("return document.querySelector('.cm-content').classList.contains('cm-lineWrapping')")
    assert before != after

@test("Editing", "Fold all (Alt+0), unfold all (Alt+Shift+0), fold level 1 (Alt+1)")
def t_fold():
    write("a.py", "class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        return 2\n\nx = 1\n")
    open_ws(); open_file("a.py"); time.sleep(0.5)
    count = lambda: js("return document.querySelectorAll('.cm-foldPlaceholder').length")
    keys(Keys.ALT, "0"); a = count()
    keys(Keys.ALT, Keys.SHIFT, "0"); b = count()
    keys(Keys.ALT, "2"); c = count()
    assert a >= 1 and b == 0 and c == 2, (a, b, c)
    keys(Keys.ALT, Keys.SHIFT, "0")
    js("const b=document.querySelector('.cm-fold-box'); for (const t of ['mousedown','mouseup','click']) b.dispatchEvent(new MouseEvent(t,{bubbles:true}))"); time.sleep(0.3)
    assert count() == 1, "clicking the fold box didn't fold"

@test("Editing", "Fold a JSON/JS block by its brackets")
def t_fold_brackets():
    write("a.json", '{\n  "a": [\n    1,\n    2\n  ],\n  "b": 3\n}\n')
    open_ws(); open_file("a.json"); time.sleep(0.5)
    keys(Keys.ALT, "2")
    assert js("return document.querySelectorAll('.cm-foldPlaceholder').length") == 1


# ---------- tests: view, zoom, menus ----------

@test("View", "Editor and terminal zoom separately; Ctrl+0 resets; zoom is limited to 8-40 px")
def t_zoom():
    write("a.txt", "x")
    open_ws(); open_file("a.txt")
    fs = lambda: js("return getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim()")
    editor().click()
    keys(Keys.CONTROL, "="); keys(Keys.CONTROL, "=")
    assert fs() == "16px", fs()
    assert "Editor" in status()["zoom"] and "Terminal" not in status()["zoom"], status()
    for _ in range(40): ActionChains(app.d).key_down(Keys.CONTROL).send_keys("=").key_up(Keys.CONTROL).perform()
    time.sleep(0.4)
    assert fs() == "40px", fs()
    keys(Keys.CONTROL, "0")
    assert fs() == "14px" and status()["zoom"] == "", (fs(), status())

@test("View", "Theme switch (View > Dark Theme)")
def t_theme():
    open_ws()
    before = js("return document.documentElement.dataset.theme")
    menu("View", "Dark Theme")
    assert js("return document.documentElement.dataset.theme") != before

@test("Menus", "Alt+F/E/V/L/T/W open each menu; arrows and Escape work")
def t_menus():
    open_ws()
    want = {"f": "New", "e": "Undo", "v": "Explorer", "l": "Plain Text", "t": "New Terminal", "w": "Switch Files (recently used)"}
    got = {}
    for k, first in want.items():
        keys(Keys.ALT, k)
        got[k] = js("return document.querySelector('#menubar .menu-pop .menu-label')?.textContent ?? null")
        keys(Keys.ESCAPE)
    assert got == want, got
    assert not js("return [...document.querySelectorAll('.menu-pop')].some(p=>!p.hidden && p.offsetParent)")

@test("Menus", "Every menu item has a working action (no errors when opened)")
def t_menu_errors():
    open_ws()
    errs = js("window.__errs=[]; window.addEventListener('error',e=>__errs.push(String(e.message))); window.addEventListener('unhandledrejection',e=>__errs.push(String(e.reason))); return 1")
    for m in ["File", "Edit", "View", "Language", "Terminal", "Window"]:
        menu(m); keys(Keys.ESCAPE)
    assert js("return __errs") == [], js("return __errs")


# ---------- tests: terminal ----------

@test("Terminal", "Ctrl+` opens a shell in the current file's folder")
def t_term_open():
    write("proj/a.txt", "x")
    open_ws(); expand("proj"); open_file("proj/a.txt")
    keys(Keys.CONTROL, "`"); time.sleep(2.5)
    t = term_text()
    assert "proj" in t, t[-300:]
    ActionChains(app.d).send_keys("pwd", Keys.ENTER).perform(); time.sleep(1)
    assert WS + "/proj" in term_text(), term_text()[-300:]

@test("Terminal", "Commands run and Unicode output is shown")
def t_term_unicode():
    open_ws()
    keys(Keys.CONTROL, "`"); time.sleep(2.5)
    ActionChains(app.d).send_keys("echo héllo-日本-€ && echo $((6*7))", Keys.ENTER).perform(); time.sleep(1.2)
    t = term_text()
    assert "héllo-日本-€" in t and "42" in t, t[-300:]

@test("Terminal", "Several terminals; New Terminal adds a tab; exit closes")
def t_term_multi():
    open_ws()
    keys(Keys.CONTROL, "`"); time.sleep(2)
    keys(Keys.CONTROL, Keys.SHIFT, "`"); time.sleep(2)
    n = js("return document.querySelectorAll('.term-tab').length")
    assert n == 2, n
    ActionChains(app.d).send_keys("exit", Keys.ENTER).perform(); time.sleep(1.5)
    assert "process exited" in term_text()
    ActionChains(app.d).send_keys("x").perform(); time.sleep(0.8)
    assert js("return document.querySelectorAll('.term-tab').length") == 1

@test("Terminal", "Shell keys Ctrl+W / Ctrl+B / Ctrl+N reach the shell instead of closing tabs")
def t_term_keys():
    write("a.txt", "x"); write("b.txt", "y")
    open_ws(); open_file("a.txt"); open_file("b.txt")
    keys(Keys.CONTROL, "`"); time.sleep(2.5)
    n = len(tabs())
    ActionChains(app.d).send_keys("echo one two").perform()
    keys(Keys.CONTROL, "w")     # bash: delete the word "two"
    keys(Keys.CONTROL, "b")     # bash: cursor back one char
    ActionChains(app.d).send_keys("", Keys.ENTER).perform(); time.sleep(0.8)
    problems = []
    if len(tabs()) != n: problems.append("Ctrl+W closed an editor tab")
    if js("return document.getElementById('explorer-pane').hidden"): problems.append("Ctrl+B hid the explorer")
    assert not problems, "; ".join(problems)

@test("Terminal", "Terminal zoom (Ctrl+= while the terminal has focus)")
def t_term_zoom():
    open_ws()
    keys(Keys.CONTROL, "`"); time.sleep(2)
    keys(Keys.CONTROL, "=")
    z = status()["zoom"]
    assert "Terminal" in z and "Editor" not in z, z
    keys(Keys.CONTROL, "0")


# ---------- tests: session ----------

@test("Session", "Restart restores the folder, tabs, unsaved edits, pinned tab and active tab")
def t_session():
    global app
    write("a.txt", "A"); write("b.txt", "B")
    open_ws(); open_file("a.txt"); open_file("b.txt")
    keys(Keys.CONTROL, "n"); type_text("unsaved draft")
    ctx(WS + "/b.txt", "Pin Tab")
    open_file("a.txt"); type_text("edit-")
    time.sleep(1)
    app.quit(); app = App(home=HOME)
    names = [t["name"] for t in tabs()]
    assert names[0] == "b.txt" and "pinned" in tabs()[0]["cls"], names
    assert {"a.txt", "b.txt"} <= set(names) and any(n.startswith("new ") for n in names), names
    assert active_tab()["name"] == "a.txt", active_tab()
    assert "edit-A" in visible_text(), visible_text()
    assert read("a.txt") == "A", "unsaved edit was written to disk"
    js("[...document.querySelectorAll('#tabs .tab')].find(t=>t.querySelector('span').textContent.startsWith('new ')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))"); time.sleep(0.4)
    assert "unsaved draft" in visible_text()

@test("Session", "A file deleted while the app was closed is dropped from the tabs")
def t_session_deleted():
    global app
    write("gone.txt", "g"); write("keep.txt", "k")
    open_ws(); open_file("gone.txt"); open_file("keep.txt"); time.sleep(1)
    app.quit(); os.remove(WS + "/gone.txt"); app = App(home=HOME)
    names = [t["name"] for t in tabs()]
    assert "gone.txt" not in names and "keep.txt" in names, names

@test("Session", "A big unsaved file doesn't stop the session from being saved")
def t_session_quota():
    global app
    write("a.txt", "A")
    open_ws(); open_file("a.txt"); keys(Keys.CONTROL, "n")
    js("document.querySelector('.cm-content').focus()")
    # 6 MB of unsaved text, pasted in one go via the clipboard
    subprocess.run("head -c 6000000 /dev/zero | tr '\\0' 'x' | xclip -selection clipboard", shell=True)
    editor().send_keys(Keys.CONTROL, "v"); time.sleep(2)
    open_file("a.txt"); time.sleep(1.5)
    app.quit(); app = App(home=HOME)
    names = [t["name"] for t in tabs()]
    assert "a.txt" in names, f"session lost: tabs after restart {names}"


# ---------- tests: added in round 2 ----------

@test("Files", "Save a new tab with Save As (Ctrl+S on an untitled tab)")
def t_save_as_new():
    open_ws(); keys(Keys.CONTROL, "n"); type_text("fresh text")
    keys(Keys.CONTROL, "s")
    assert wait_dialog(), "no save dialog"
    time.sleep(1)
    sh(f"xdotool key ctrl+a && xdotool type --delay 20 '{WS}/saved-new.py' && xdotool key Return"); time.sleep(1.5)
    assert os.path.exists(WS + "/saved-new.py"), os.listdir(WS)
    assert read("saved-new.py") == "fresh text"
    assert active_tab()["name"] == "saved-new.py" and status()["lang"] == "Python", (tabs(), status())

@test("Files", "Open Recent lists recently opened files and reopens them")
def t_recent():
    write("r.txt", "r")
    open_ws(); open_file("r.txt"); keys(Keys.CONTROL, "w")
    menu("File", "Open Recent", f"{WS}/r.txt"); time.sleep(0.5)
    assert active_tab()["name"] == "r.txt"

@test("Files", "A file changed by another program while it has unsaved edits: Lightpad asks before replacing")
def t_external_change_dirty():
    write("a.txt", "v1")
    open_ws(); open_file("a.txt"); type_text("mine-")
    time.sleep(1.1); write("a.txt", "theirs")
    js("window.dispatchEvent(new Event('focus'))"); time.sleep(1)
    asked = wait_dialog(2)
    if asked: press_dialog_button(1, 2)  # Cancel = keep mine
    assert asked, "no question about the outside change"
    assert "mine-v1" in visible_text(), visible_text()
    keys(Keys.CONTROL, "s")
    d = wait_dialog(1.5)
    if d: dismiss_dialog()
    assert read("a.txt") == "mine-v1", read("a.txt")


# ---------- tests: switching between open files ----------

def switcher_rows():
    return js("const s=document.getElementById('switcher'); return s.hidden ? null : [...s.querySelectorAll('.sw-row')].map(r=>(r.classList.contains('sel')?'>':'')+r.querySelector('span').textContent)")

def open_abc():
    for n in "abc": write(f"{n}.txt", n)
    open_ws()
    for n in "abc": open_file(f"{n}.txt")

@test("Switching", "Ctrl+Tab goes back to the previous file; again returns (most recently used order)")
def t_switch_mru():
    open_abc()
    keys(Keys.CONTROL, Keys.TAB)
    assert active_tab()["name"] == "b.txt", active_tab()
    keys(Keys.CONTROL, Keys.TAB)
    assert active_tab()["name"] == "c.txt", active_tab()

@test("Switching", "Holding Ctrl and pressing Tab twice shows the list and picks the third file")
def t_switch_hold():
    open_abc()
    ActionChains(app.d).key_down(Keys.CONTROL).send_keys(Keys.TAB).send_keys(Keys.TAB).perform(); time.sleep(0.4)
    rows = switcher_rows()
    ActionChains(app.d).key_up(Keys.CONTROL).perform(); time.sleep(0.5)
    assert rows == ["c.txt", "b.txt", ">a.txt"], rows
    assert switcher_rows() is None, "list still showing after Ctrl was released"
    assert active_tab()["name"] == "a.txt", active_tab()

@test("Switching", "Ctrl+Shift+Tab moves up the list; Escape cancels")
def t_switch_back_escape():
    open_abc()
    ActionChains(app.d).key_down(Keys.CONTROL).key_down(Keys.SHIFT).send_keys(Keys.TAB).key_up(Keys.SHIFT).perform(); time.sleep(0.4)
    rows = switcher_rows()
    ActionChains(app.d).send_keys(Keys.ESCAPE).key_up(Keys.CONTROL).perform(); time.sleep(0.5)
    assert rows == ["c.txt", "b.txt", ">a.txt"], rows
    assert active_tab()["name"] == "c.txt", "Escape still switched"

@test("Switching", "Ctrl+PageDown / Ctrl+PageUp follow the tab bar; Ctrl+1 and Ctrl+9 jump to first and last")
def t_switch_tabbar():
    open_abc()
    keys(Keys.CONTROL, Keys.PAGE_DOWN); assert active_tab()["name"] == "a.txt", active_tab()  # wraps around
    keys(Keys.CONTROL, Keys.PAGE_UP); assert active_tab()["name"] == "c.txt", active_tab()
    keys(Keys.CONTROL, "1"); assert active_tab()["name"] == "a.txt", active_tab()
    keys(Keys.CONTROL, "2"); assert active_tab()["name"] == "b.txt", active_tab()
    keys(Keys.CONTROL, "9"); assert active_tab()["name"] == "c.txt", active_tab()

@test("Switching", "Ctrl+Tab works while typing in the terminal")
def t_switch_from_terminal():
    open_abc()
    keys(Keys.CONTROL, "`"); time.sleep(2)
    keys(Keys.CONTROL, Keys.TAB)
    assert active_tab()["name"] == "b.txt", active_tab()

@test("Switching", "Window menu lists the open files and switches to the one clicked")
def t_window_menu():
    open_abc()
    menu("Window", "a.txt")
    assert active_tab()["name"] == "a.txt", active_tab()


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else None)
