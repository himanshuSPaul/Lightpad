# End-to-end tests

62 tests that drive the real release build of Lightpad through WebDriver: they click, type,
use the menus and the explorer, run the terminal, and check the files on disk.

They run on Linux (the WebDriver for WebKitGTK), under a virtual display:

```sh
sudo apt-get install -y webkit2gtk-driver xvfb xdotool xclip imagemagick
cargo install tauri-driver --locked
pip install selenium
npx tauri build --no-bundle          # from the repo root
Xvfb :99 -screen 0 1280x900x24 &
DISPLAY=:99 python3 tests/e2e/suite.py            # all tests
DISPLAY=:99 python3 tests/e2e/suite.py t_rename   # tests whose name contains t_rename
```

Results go to `results.json` and screenshots of failures to `fail-shots/`, both in
`$LIGHTPAD_QA_DIR` (default `/tmp/lightpad-e2e`). The tests use their own home folder there, so
your own Lightpad settings aren't touched.
