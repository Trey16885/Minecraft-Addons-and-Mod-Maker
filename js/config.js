/* config.js — constants, storage keys, and the system instructions. */

/* Must match the ?v= on the script tags in index.html. Bump both together
 * when a js/ or css/ file changes. */
const BUILD = '5';

const STORE_KEY = 'mcmaker.v1';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';

/* The port ccproxy serves on, per the README. */
const DEFAULT_PORT = 8000;

/* How to reach ccproxy. The two SSH tunnels the README covers, plus talking
 * to it directly. `host` only expands a bare subdomain — a full URL is
 * accepted whichever option is selected. Both tunnels hand out a fresh random
 * subdomain on every reconnect. */
const TUNNEL_SERVICES = {
  serveo: {
    label: 'Serveo',
    host: 'serveousercontent.com',
    example: 'bright-otter  or  https://bright-otter.serveo.net',
    log: '~/serveo.log',
  },
  lhr: {
    label: 'localhost.run',
    host: 'lhr.life',
    example: '3f9a2c1b  or  https://3f9a2c1b.lhr.life',
    log: '~/lhr.log',
  },
  direct: {
    label: 'Direct',
    host: `127.0.0.1:${DEFAULT_PORT}`,
    example: `127.0.0.1:${DEFAULT_PORT}  or  192.168.1.5:${DEFAULT_PORT}`,
    log: '~/ccproxy.log',
    direct: true,
  },
};

/* Where the AI's Python code writes its files. */
const WORKSPACE = '/workspace';

/* Files bigger than this are refused when packaging, to avoid OOM on phones. */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

/* ── System instructions ──────────────────────────────────────────────
 * Kept verbatim to the project spec. {model-id} and the Java version are
 * substituted at send time.
 * ------------------------------------------------------------------ */

function bedrockPrompt(modelId) {
  return [
    `You are ${modelId} running as a Minecraft addon maker`,
    `Tools: `,
    `Python `,
    `To run Python, use an MD code block like this`,
    '```python',
    `print("This is a placeholder don't actually use this code!")`,
    '```',
    `You can use Python to make files or images using PIL`,
    `The user is using Minecraft Bedrock Edition, so you must make an MCADDON type`,
    `You must only make Minecraft Mods`,
    `You may chat with the user about Minecraft`,
  ].join('\n');
}

function javaPrompt(modelId, javaVersion) {
  return [
    `You are ${modelId} running as a Minecraft Java mod maker`,
    `Tools: `,
    `Python `,
    `To run Python, use an MD code block like this`,
    '```python',
    `print("This is a placeholder don't actually use this code!")`,
    '```',
    `You can use Python to make files or images using PIL`,
    `The user is using Minecraft Java Edition, so you must make a JAR type`,
    `You must only make Minecraft Mods`,
    `You may chat with the user about Minecraft`,
    `The current iteration of Minecraft Java is ${javaVersion}`,
  ].join('\n');
}

/* Appended to whichever prompt is in play: tells the model how this
 * particular harness executes its Python, so it writes code that works. */
function runtimeNotes(edition) {
  const archive = edition === 'bedrock' ? '.mcaddon' : '.jar';
  return [
    ``,
    `--- How your Python runs here ---`,
    `Every \`\`\`python block you write is executed automatically in a sandboxed`,
    `CPython (Pyodide). stdout, stderr and tracebacks come back to you as the`,
    `next user message, so you can check your work and fix mistakes.`,
    `The working directory is ${WORKSPACE} and it persists between code blocks`,
    `and between messages, so you can build a pack up over several steps.`,
    `Write every pack file with real paths relative to the working directory,`,
    `e.g. open("BP/manifest.json","w") or os.makedirs(...,exist_ok=True).`,
    `Pillow (PIL) is available for textures; json, os, uuid, random, zipfile,`,
    `shutil and the rest of the stdlib are too. There is no network access and`,
    `you cannot pip install anything, so generate textures with PIL rather than`,
    `downloading them.`,
    `Do NOT zip the pack yourself — the app collects everything in the working`,
    `directory and exports it as ${archive} when the user taps Export. Just`,
    `write the loose files in their correct folder structure.`,
    `Use print() to report what you created.`,
  ].join('\n');
}

function buildSystemPrompt(edition, modelId, javaVersion) {
  const base = edition === 'bedrock'
    ? bedrockPrompt(modelId)
    : javaPrompt(modelId, javaVersion);
  return base + '\n' + runtimeNotes(edition);
}

const SUGGESTIONS = {
  bedrock: [
    'Add a ruby ore, ingot and sword',
    'Make a rideable glowing pig',
    'A pack that makes creepers drop diamonds',
  ],
  java: [
    'Add a copper hammer tool',
    'A block that grows crops around it',
    'Make zombies drop their armor',
  ],
};

/* ── tiny persistence helper ───────────────────────────────────────── */
const Store = {
  read() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  },
  write(patch) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...Store.read(), ...patch }));
    } catch { /* private mode — settings just won't persist */ }
  },
};
