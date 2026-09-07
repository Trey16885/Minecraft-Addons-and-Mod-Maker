/* packager.js — zips the workspace into a .mcaddon (Bedrock) or .jar (Java).
 *
 * Both formats are zip archives, so the work happens in Python's zipfile
 * inside Pyodide — no extra JS dependency, and the bytes never leave the
 * device.
 */

const Packager = (() => {

  /** Build the archive. Returns { blob, filename, warnings }. */
  async function build(edition, projectName) {
    const py = PyRunner.instance();
    if (!py) throw new Error('Nothing has been generated yet.');

    const files = PyRunner.listFiles();
    if (!files.length) throw new Error('No files to export yet — ask the AI to build the pack first.');

    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_EXPORT_BYTES) {
      throw new Error(`The project is ${fmtSize(total)}, which is too large to package in the browser.`);
    }

    const ext = edition === 'bedrock' ? 'mcaddon' : 'jar';
    const name = `${slug(projectName) || 'my-addon'}.${ext}`;

    py.globals.set('__mcm_out', `/tmp_export.${ext}`);
    py.runPython(`
import os, zipfile
_ws = ${JSON.stringify(WORKSPACE)}
_out = __mcm_out
if os.path.exists(_out):
    os.remove(_out)
with zipfile.ZipFile(_out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, names in os.walk(_ws):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for n in names:
            full = os.path.join(root, n)
            z.write(full, os.path.relpath(full, _ws))
`);
    const bytes = py.FS.readFile(`/tmp_export.${ext}`);
    py.FS.unlink(`/tmp_export.${ext}`);
    py.globals.delete('__mcm_out');

    // Copy out of the WASM heap so the Blob owns its own memory.
    const blob = new Blob([bytes.slice()], { type: 'application/zip' });
    return { blob, filename: name, warnings: inspect(edition, files) };
  }

  /** Raw project zip — useful for Java, where the .jar still needs Gradle. */
  async function buildRawZip(projectName) {
    const { blob } = await build('java', projectName);       // same bytes…
    return { blob, filename: `${slug(projectName) || 'my-mod'}-project.zip` };
  }

  /**
   * Sanity checks on the file layout. These are warnings, never blockers —
   * the AI's structure is its own call, we just flag the usual mistakes.
   */
  function inspect(edition, files) {
    const paths = files.map(f => f.path);
    const has = re => paths.some(p => re.test(p));
    const warnings = [];

    if (edition === 'bedrock') {
      if (!has(/(^|\/)manifest\.json$/i)) {
        warnings.push('No manifest.json found. Bedrock will not load a pack without one.');
      }
      // A .mcaddon holds pack folders, not the contents of a single pack.
      if (has(/^manifest\.json$/i)) {
        warnings.push(
          'manifest.json sits at the top level. A .mcaddon should contain pack ' +
          'folders (e.g. BP/manifest.json and RP/manifest.json), not one pack loose at the root.'
        );
      }
      if (has(/^BP\//i) && !has(/^RP\//i) && has(/textures\//i)) {
        warnings.push('Textures were found but there is no resource pack folder — Bedrock will not see them.');
      }
    } else {
      if (!has(/(^|\/)fabric\.mod\.json$/i) &&
          !has(/(^|\/)META-INF\/mods\.toml$/i) &&
          !has(/(^|\/)mcmod\.info$/i) &&
          !has(/(^|\/)quilt\.mod\.json$/i)) {
        warnings.push('No mod metadata (fabric.mod.json or META-INF/mods.toml) found — no loader will pick this up.');
      }
      if (has(/\.java$/i) && !has(/\.class$/i)) {
        warnings.push(
          'This project contains .java source but no compiled .class files. ' +
          'Java mods must be compiled — the .jar below is only loadable if the mod is ' +
          'data/resource-driven. For code mods, download the raw .zip and build it with Gradle on a PC.'
        );
      }
    }
    return warnings;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const slug = s => (s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return { build, buildRawZip, download, inspect };
})();

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
