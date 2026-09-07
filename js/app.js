/* app.js — screens, chat loop, and the run-Python-feed-it-back cycle. */

const $ = sel => document.querySelector(sel);

const state = {
  client: null,
  models: [],
  model: '',
  edition: '',
  javaVersion: '',
  history: [],        // OpenAI-format messages, excluding the system prompt
  streaming: false,
  abort: null,
  autorun: true,
  autoTurns: 0,       // consecutive model turns driven by run output
};

const MAX_AUTO_TURNS = 6;

/* ── screens ───────────────────────────────────────────────────────── */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  $('#menu').classList.add('hidden');
  window.scrollTo(0, 0);
}

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

/* ── step 1: connect ───────────────────────────────────────────────── */
const tunnelInput = $('#tunnel');
const resolvedEl = $('#resolved');

function refreshResolved() {
  const base = resolveBaseUrl(tunnelInput.value);
  if (!tunnelInput.value.trim()) {
    resolvedEl.textContent = '';
    resolvedEl.className = 'resolved';
    return;
  }
  if (!base) {
    resolvedEl.textContent = "That doesn't look like a URL yet.";
    resolvedEl.className = 'resolved';
    return;
  }
  resolvedEl.textContent = `-> ${base}/${$('#provider').value}/v1/models`;
  resolvedEl.className = 'resolved ok';
}

tunnelInput.addEventListener('input', refreshResolved);
$('#provider').addEventListener('change', refreshResolved);

$('#btn-connect').addEventListener('click', connect);
tunnelInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); connect(); }
});

async function connect() {
  const statusEl = $('#connect-status');
  const base = resolveBaseUrl(tunnelInput.value);
  if (!base) return setStatus(statusEl, 'Enter your Serveo URL first.', 'err');

  const client = new ProxyClient({
    baseUrl: base,
    token: $('#token').value,
    provider: $('#provider').value,
  });

  $('#btn-connect').disabled = true;
  setStatus(statusEl, 'Contacting the tunnel...', 'busy');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const models = await client.listModels(controller.signal);
    clearTimeout(timer);

    state.client = client;
    state.models = models;
    Store.write({
      tunnel: tunnelInput.value.trim(),
      token: $('#token').value,
      provider: $('#provider').value,
    });

    setStatus(statusEl, `Connected — ${models.length} models.`, 'ok');
    fillModels();
    $('#setup-endpoint').textContent = base;
    show('screen-setup');
  } catch (err) {
    setStatus(statusEl, describeNetworkError(err, base), 'err');
  } finally {
    $('#btn-connect').disabled = false;
  }
}

/* ── step 2: model + edition ───────────────────────────────────────── */
function fillModels() {
  const sel = $('#model');
  sel.innerHTML = '';
  const saved = Store.read().model;
  for (const m of state.models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    if (m.id === saved) o.selected = true;
    sel.appendChild(o);
  }
  $('#model-count').textContent = `${state.models.length} models available on this tunnel`;
}

document.querySelectorAll('.edition').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.edition').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.edition = btn.dataset.edition;
    $('#java-version-row').classList.toggle('hidden', state.edition !== 'java');
    setStatus($('#setup-status'), '');
  });
});

$('#btn-back-connect').addEventListener('click', () => show('screen-connect'));

$('#btn-start').addEventListener('click', () => {
  const statusEl = $('#setup-status');
  if (!state.edition) return setStatus(statusEl, 'Pick Bedrock or Java.', 'err');

  const version = $('#java-version').value.trim();
  if (state.edition === 'java' && !version) {
    return setStatus(statusEl, 'Java Edition needs a version — e.g. 1.21.4.', 'err');
  }

  state.model = $('#model').value;
  state.javaVersion = version;
  Store.write({ model: state.model, edition: state.edition, javaVersion: version });

  $('#chat-model').textContent = state.model;
  $('#chat-edition').textContent = state.edition === 'bedrock' ? 'Bedrock' : `Java ${version}`;

  if (!state.history.length) renderEmpty();
  show('screen-chat');
  $('#input').focus();
});

/* ── menu ──────────────────────────────────────────────────────────── */
$('#btn-menu').addEventListener('click', e => {
  e.stopPropagation();
  $('#menu').classList.toggle('hidden');
});
document.addEventListener('click', e => {
  if (!$('#menu').contains(e.target) && e.target !== $('#btn-menu')) {
    $('#menu').classList.add('hidden');
  }
});

$('#btn-new-chat').addEventListener('click', () => {
  if (state.streaming) return;
  state.history = [];
  state.autoTurns = 0;
  renderEmpty();
  $('#menu').classList.add('hidden');
});

$('#btn-change-setup').addEventListener('click', () => show('screen-setup'));

$('#btn-toggle-autorun').addEventListener('click', () => {
  state.autorun = !state.autorun;
  $('#autorun-state').textContent = state.autorun ? 'on' : 'off';
  Store.write({ autorun: state.autorun });
});

$('#btn-clear-workspace').addEventListener('click', () => {
  if (!confirm('Delete every file the AI has generated so far?')) return;
  PyRunner.clearWorkspace();
  refreshFiles();
  $('#menu').classList.add('hidden');
  notice('Workspace cleared.');
});

/* ── composer ──────────────────────────────────────────────────────── */
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});
input.addEventListener('keydown', e => {
  const physicalKeyboard = window.matchMedia('(pointer: fine)').matches;
  if (e.key === 'Enter' && !e.shiftKey && physicalKeyboard) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = '';
  input.style.height = 'auto';
  state.autoTurns = 0;
  sendUserMessage(text);
});

$('#btn-stop').addEventListener('click', () => state.abort?.abort());

/* ── chat ──────────────────────────────────────────────────────────── */
const messagesEl = $('#messages');

function renderEmpty() {
  messagesEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'empty';
  const p = document.createElement('p');
  p.textContent = 'Tell the AI what mod you want. It writes Python here in the '
    + 'browser to generate the pack files, then you export them.';
  div.appendChild(p);

  const sugg = document.createElement('div');
  sugg.className = 'suggestions';
  for (const s of (SUGGESTIONS[state.edition] || SUGGESTIONS.bedrock)) {
    const b = document.createElement('button');
    b.textContent = s;
    b.addEventListener('click', () => { state.autoTurns = 0; sendUserMessage(s); });
    sugg.appendChild(b);
  }
  div.appendChild(sugg);
  messagesEl.appendChild(div);
}

async function sendUserMessage(text) {
  messagesEl.querySelector('.empty')?.remove();
  addMessageEl('user', text);
  state.history.push({ role: 'user', content: text });
  await runTurn();
}

async function runTurn() {
  const bodyEl = addMessageEl('assistant', '');
  bodyEl.classList.add('cursor');

  state.streaming = true;
  state.abort = new AbortController();
  $('#btn-send').classList.add('hidden');
  $('#btn-stop').classList.remove('hidden');

  const system = buildSystemPrompt(state.edition, state.model, state.javaVersion);
  let text = '';
  let raf = 0;   // pending repaint — must be cancelled before we finalise the
                 // message, or it fires later and wipes anything appended to it

  try {
    text = await state.client.streamChat({
      model: state.model,
      messages: [{ role: 'system', content: system }, ...state.history],
      signal: state.abort.signal,
      onDelta: chunk => {
        text += chunk;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          bodyEl.innerHTML = renderMarkdown(text);
          scrollToBottom();
        });
      },
    });
  } catch (err) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    bodyEl.classList.remove('cursor');
    if (err.name === 'AbortError') {
      if (text) {
        bodyEl.innerHTML = renderMarkdown(text);
        state.history.push({ role: 'assistant', content: text });
      } else {
        bodyEl.closest('.msg').remove();
      }
      notice('Stopped.');
    } else {
      bodyEl.closest('.msg').remove();
      notice(describeNetworkError(err, state.client.baseUrl), true);
    }
    return;
  } finally {
    state.streaming = false;
    state.abort = null;
    $('#btn-send').classList.remove('hidden');
    $('#btn-stop').classList.add('hidden');
  }

  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  bodyEl.classList.remove('cursor');
  bodyEl.innerHTML = renderMarkdown(text);
  state.history.push({ role: 'assistant', content: text });
  scrollToBottom();

  wireRunButtons(bodyEl, text);
  if (state.autorun) await runBlocksAndReply(bodyEl, text);
}

/* Run every python block in the message, then hand the output back. */
async function runBlocksAndReply(bodyEl, text) {
  const blocks = extractPython(text);
  if (!blocks.length) return;

  if (state.autoTurns >= MAX_AUTO_TURNS) {
    notice(`Paused after ${MAX_AUTO_TURNS} automatic rounds. Send a message to continue.`);
    return;
  }

  const report = [];
  for (let i = 0; i < blocks.length; i++) {
    const result = await runOneBlock(bodyEl, blocks[i], i);
    report.push(
      `[python block ${i + 1}/${blocks.length}] ${result.ok ? 'ok' : 'FAILED'}\n`
      + clampOutput(result.output || '(no output)')
      + (result.created?.length ? `\nfiles written: ${result.created.join(', ')}` : '')
    );
    if (!result.ok) break;   // let it fix the error before running the rest
  }

  refreshFiles();

  state.history.push({
    role: 'user',
    content:
      'Python execution result:\n\n' + report.join('\n\n')
      + '\n\nIf something failed, fix it and give the corrected code. '
      + 'If it succeeded, continue or tell me the pack is ready to export.',
  });
  state.autoTurns++;
  await runTurn();
}

/**
 * Keep a runaway print loop from eating the model's context. The tail matters
 * more than the head for a traceback, so keep both ends and drop the middle.
 */
function clampOutput(text, limit = 4000) {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.6));
  const tail = text.slice(-Math.floor(limit * 0.4));
  const cut = text.length - head.length - tail.length;
  return `${head}\n\n… [${cut} characters trimmed] …\n\n${tail}`;
}

/** Execute one block and append its output under the code. */
async function runOneBlock(bodyEl, code, index) {
  const holder = bodyEl.querySelectorAll('.codeblock')[index];
  const out = document.createElement('div');
  out.className = 'run-output';
  const runningTitle = document.createElement('span');
  runningTitle.className = 'run-title';
  runningTitle.textContent = 'Running...';
  out.appendChild(runningTitle);
  (holder || bodyEl).appendChild(out);
  scrollToBottom();

  let result;
  try {
    result = await PyRunner.run(code);
  } catch (err) {
    result = { ok: false, output: String(err?.message || err), created: [] };
  }

  out.className = `run-output${result.ok ? '' : ' error'}`;
  out.textContent = result.output || (result.ok ? '(no output)' : 'Unknown error');

  const title = document.createElement('span');
  title.className = 'run-title';
  title.textContent = result.ok
    ? `Output${result.created.length ? ` — ${result.created.length} file(s) written` : ''}`
    : 'Error';
  out.prepend(title);

  $('#runner-status').classList.add('hidden');
  scrollToBottom();
  return result;
}

/** Manual Run buttons, for when auto-run is off. */
function wireRunButtons(bodyEl, text) {
  const blocks = extractPython(text);
  bodyEl.querySelectorAll('.codeblock').forEach((holder, i) => {
    const btn = holder.querySelector('.codeblock-run');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await runOneBlock(bodyEl, blocks[i], i);
      refreshFiles();
      btn.disabled = false;
    });
  });
}

/* ── message rendering ─────────────────────────────────────────────── */
function addMessageEl(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const label = document.createElement('div');
  label.className = 'msg-role';
  label.textContent = role === 'user' ? 'You' : state.model;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = renderMarkdown(text);
  wrap.append(label, body);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return body;
}

function notice(text, isError = false) {
  const el = document.createElement('div');
  el.className = `notice${isError ? ' err' : ''}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

const escapeHtml = s => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Every fenced python block in a message, in order. */
function extractPython(text) {
  const out = [];
  const re = /```[ \t]*(?:python|py)[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].replace(/\s+$/, ''));
  return out;
}

/**
 * Small markdown renderer. Fenced code is pulled out first so nothing inside
 * it gets treated as markup; python blocks get a header with a Run button.
 */
function renderMarkdown(text) {
  if (!text) return '';
  const codes = [];
  let i = 0;

  const withoutCode = text.replace(
    /```[ \t]*([\w+-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g,
    (_, lang, body) => {
      codes.push({ lang: (lang || '').toLowerCase(), body });
      return `@@CODE${i++}@@`;
    }
  );

  let html = escapeHtml(withoutCode)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.*)$/gm, '<li>$1</li>');

  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');

  html = html
    .split(/\n{2,}/)
    .map(chunk => {
      const t = chunk.trim();
      if (!t) return '';
      if (/^<(h[1-3]|ul|pre|div)/.test(t) || /^@@CODE\d+@@$/.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html.replace(/@@CODE(\d+)@@/g, (_, n) => {
    const { lang, body } = codes[+n];
    const isPy = lang === 'python' || lang === 'py';
    const pre = `<pre><code>${escapeHtml(body)}</code></pre>`;
    if (!isPy) return pre;
    return `<div class="codeblock">`
      + `<div class="codeblock-head"><span>python</span>`
      + `<button class="codeblock-run" type="button">Run</button></div>`
      + `${pre}</div>`;
  });
}

/* ── files drawer + export ─────────────────────────────────────────── */
function refreshFiles() {
  const files = PyRunner.isReady() ? PyRunner.listFiles() : [];
  $('#file-count').textContent = String(files.length);

  const enabled = files.length > 0;
  $('#btn-export').disabled = !enabled;
  $('#btn-export-2').disabled = !enabled;
  $('#btn-export-zip').disabled = !enabled;

  const list = $('#file-list');
  list.innerHTML = '';
  if (!files.length) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'fempty';
    span.textContent = 'Nothing generated yet.';
    li.appendChild(span);
    list.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.path;
    const size = document.createElement('span');
    size.className = 'fsize';
    size.textContent = fmtSize(f.size);
    li.append(name, size);
    list.appendChild(li);
  }
}

function openDrawer() { refreshFiles(); $('#drawer').classList.remove('hidden'); }
function closeDrawer() { $('#drawer').classList.add('hidden'); }

$('#btn-files').addEventListener('click', openDrawer);
$('#btn-close-drawer').addEventListener('click', closeDrawer);
$('.drawer-scrim').addEventListener('click', closeDrawer);

async function doExport(raw = false) {
  try {
    const projectName = guessProjectName();
    const { blob, filename, warnings } = raw
      ? await Packager.buildRawZip(projectName)
      : await Packager.build(state.edition, projectName);

    Packager.download(blob, filename);
    closeDrawer();
    notice(`Exported ${filename} (${fmtSize(blob.size)}).`);
    for (const w of warnings || []) notice(w, true);
  } catch (err) {
    notice(err.message || String(err), true);
  }
}

$('#btn-export').addEventListener('click', () => doExport(false));
$('#btn-export-2').addEventListener('click', () => doExport(false));
$('#btn-export-zip').addEventListener('click', () => doExport(true));

/** Name the download after the pack, when the pack says what it is called. */
function guessProjectName() {
  const first = state.history.find(m => m.role === 'user')?.content || '';
  return first.split('\n')[0].slice(0, 40);
}

/* ── python runner status strip ────────────────────────────────────── */
PyRunner.setStatusHandler(text => {
  const el = $('#runner-status');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
});

/* ── restore saved settings ────────────────────────────────────────── */
(function restore() {
  const saved = Store.read();
  if (saved.tunnel) tunnelInput.value = saved.tunnel;
  if (saved.token) $('#token').value = saved.token;
  if (saved.provider) $('#provider').value = saved.provider;
  if (saved.autorun === false) {
    state.autorun = false;
    $('#autorun-state').textContent = 'off';
  }
  if (saved.edition) {
    const btn = document.querySelector(`.edition[data-edition="${saved.edition}"]`);
    if (btn) {
      btn.classList.add('selected');
      state.edition = saved.edition;
      $('#java-version-row').classList.toggle('hidden', saved.edition !== 'java');
    }
  }
  if (saved.javaVersion) $('#java-version').value = saved.javaVersion;
  refreshResolved();
})();

window.addEventListener('beforeunload', e => {
  if (state.streaming || (PyRunner.isReady() && PyRunner.listFiles().length)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
