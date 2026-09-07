/* runner.js — executes the AI's ```python blocks in Pyodide, with Pillow.
 *
 * Pyodide is loaded lazily on the first run so the page stays light on a
 * phone connection. The working directory persists for the whole session,
 * which is what lets a pack be built up over several messages.
 */

const PyRunner = (() => {
  let pyodide = null;
  let loading = null;
  let onStatus = () => {};

  function setStatusHandler(fn) { onStatus = fn || (() => {}); }

  async function ensureLoaded() {
    if (pyodide) return pyodide;
    if (loading) return loading;

    loading = (async () => {
      onStatus('Loading Python runtime (first run only, ~10 MB)…');
      await loadScriptOnce(PYODIDE_URL);

      onStatus('Starting Python…');
      const py = await loadPyodide({
        indexURL: PYODIDE_URL.replace(/pyodide\.js$/, ''),
      });

      onStatus('Loading Pillow…');
      try {
        await py.loadPackage('Pillow');
      } catch (e) {
        // Not fatal: plain file generation still works without images.
        console.warn('Pillow failed to load', e);
        onStatus('Pillow could not be loaded — image code will fail, file code still works.');
      }

      py.FS.mkdirTree(WORKSPACE);
      py.runPython(`
import os, sys
os.chdir(${JSON.stringify(WORKSPACE)})
sys.path.insert(0, ${JSON.stringify(WORKSPACE)})
`);
      onStatus('');
      pyodide = py;
      return py;
    })();

    try { return await loading; }
    catch (e) { loading = null; throw e; }
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(
        'Could not load the Python runtime from the CDN. Check that the device is online.'
      ));
      document.head.appendChild(s);
    });
  }

  /**
   * Run one block of code.
   * Resolves { ok, output, created } — created lists files the code added
   * or changed, so the UI can show progress without diffing on the JS side.
   */
  async function run(code) {
    const py = await ensureLoaded();
    const before = listFiles(py);

    py.globals.set('__mcm_code', code);
    const raw = py.runPython(`
import io, os, sys, traceback, contextlib, json

_buf = io.StringIO()
_ok = True
try:
    with contextlib.redirect_stdout(_buf), contextlib.redirect_stderr(_buf):
        exec(compile(__mcm_code, "<addon>", "exec"), {"__name__": "__main__"})
except BaseException:
    _ok = False
    _buf.write(traceback.format_exc())

json.dumps({"ok": _ok, "output": _buf.getvalue()})
`);
    py.globals.delete('__mcm_code');

    const result = JSON.parse(raw);
    const after = listFiles(py);
    const beforeMap = new Map(before.map(f => [f.path, f.size]));
    const created = after
      .filter(f => beforeMap.get(f.path) !== f.size)
      .map(f => f.path);

    return { ok: result.ok, output: result.output.trimEnd(), created };
  }

  /** Every file under the workspace, as [{path, size}] with paths relative to it. */
  function listFiles(py = pyodide) {
    if (!py) return [];
    const out = [];
    const walk = (dir, prefix) => {
      let entries;
      try { entries = py.FS.readdir(dir); } catch { return; }
      for (const name of entries) {
        if (name === '.' || name === '..') continue;
        if (name === '__pycache__') continue;
        const full = `${dir}/${name}`;
        let stat;
        try { stat = py.FS.stat(full); } catch { continue; }
        if (py.FS.isDir(stat.mode)) walk(full, `${prefix}${name}/`);
        else out.push({ path: `${prefix}${name}`, size: stat.size });
      }
    };
    walk(WORKSPACE, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  function readFile(path) {
    return pyodide.FS.readFile(`${WORKSPACE}/${path}`);
  }

  /** Wipe the workspace so a new project starts clean. */
  function clearWorkspace() {
    if (!pyodide) return;
    pyodide.runPython(`
import os, shutil
_ws = ${JSON.stringify(WORKSPACE)}
for name in os.listdir(_ws):
    p = os.path.join(_ws, name)
    if os.path.isdir(p):
        shutil.rmtree(p, ignore_errors=True)
    else:
        os.remove(p)
os.chdir(_ws)
`);
  }

  const isReady = () => !!pyodide;
  const instance = () => pyodide;

  return { ensureLoaded, run, listFiles, readFile, clearWorkspace, setStatusHandler, isReady, instance };
})();
