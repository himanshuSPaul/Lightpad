import os, subprocess, time, shutil, tempfile
from selenium import webdriver
from selenium.webdriver.common.options import ArgOptions

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.environ.get("LIGHTPAD_APP", os.path.join(HERE, "../../src-tauri/target/release/lightpad"))

class App:
    """Starts Lightpad under tauri-driver with a fresh HOME (fresh localStorage)."""
    def __init__(self, home=None, cwd=None):
        for name in ("tauri-driver", "WebKitWebDriver", "lightpad"):
            subprocess.run(["pkill", "-x", name], capture_output=True)
        time.sleep(0.5)
        self.home = home or tempfile.mkdtemp(prefix="lphome-")
        os.makedirs(self.home, exist_ok=True)
        env = dict(os.environ, HOME=self.home, WEBKIT_DISABLE_COMPOSITING_MODE="1", SHELL="/bin/bash")
        self.drv_proc = subprocess.Popen(["tauri-driver", "--port", "4444"], env=env,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=cwd or self.home)
        time.sleep(1.5)
        opts = ArgOptions()
        opts.set_capability("tauri:options", {"application": APP})
        opts.set_capability("browserName", "wry")
        self.d = webdriver.Remote("http://127.0.0.1:4444", options=opts)
        time.sleep(2)

    def js(self, code, *args):
        return self.d.execute_script(code, *args)

    def quit(self):
        try: self.d.quit()
        except Exception: pass
        self.drv_proc.terminate(); self.drv_proc.wait()
        subprocess.run(["pkill", "-x", "WebKitWebDriver"], capture_output=True)
        subprocess.run(["pkill", "-x", "lightpad"], capture_output=True)

def seed(app, session=None, **settings):
    """Replaces Lightpad's stored session/settings and reloads the page."""
    app.js("""
      const [session, settings] = arguments;
      localStorage.clear();
      if (session) localStorage.setItem('lightpad.session', JSON.stringify(session));
      for (const [k, v] of Object.entries(settings)) localStorage.setItem('lightpad.' + k, JSON.stringify(v));
      // Keep the page's beforeunload save from overwriting the seeded state.
      Storage.prototype.setItem = function () {};
      location.reload();
    """, session, settings)
    time.sleep(2.5)
