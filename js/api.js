/* api.js — talks to ccproxy, over an SSH tunnel or straight at 127.0.0.1. */

/** 127.0.0.1, localhost, ::1 — the machine the browser is running on. */
const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i;

/** RFC 1918 space — another device on the same Wi-Fi. */
const PRIVATE_RE =
  /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

const isLocalHost = h => LOOPBACK_RE.test(h) || PRIVATE_RE.test(h);

/**
 * Turn whatever the user pasted into a base URL.
 *
 *   bright-otter            -> https://bright-otter.<the picked service>
 *   3f9a2c.lhr.life         -> https://3f9a2c.lhr.life
 *   https://x.lhr.life/claude/v1/...  -> https://x.lhr.life   (route stripped)
 *   127.0.0.1               -> http://127.0.0.1:8000          (direct)
 *   192.168.1.5:8000        -> http://192.168.1.5:8000        (direct, LAN)
 *
 * A host that already carries a dot is used as-is, so a full URL from any
 * service works no matter which one is selected; the service only fills in
 * the domain for the bare-name shortcut.
 *
 * Scheme: https for anything routable, because a page served over https
 * cannot call plain http — that is the whole reason the tunnels exist. Local
 * addresses are the exception and stay on http, since ccproxy serves plain
 * http and browsers treat loopback as trustworthy. An explicitly typed scheme
 * always wins.
 */
function resolveBaseUrl(raw, service = TUNNEL_SERVICES.serveo) {
  let s = (raw || '').trim();
  if (!s) return null;

  const typed = /^https:\/\//i.test(s) ? 'https:'
              : /^http:\/\//i.test(s) ? 'http:'
              : null;

  s = s.replace(/^[a-z]+:\/\//i, '');   // drop the scheme, we decide it below
  s = s.replace(/\/+$/, '');            // trailing slashes

  // Strip a pasted API path so people can paste the curl URL from the README.
  s = s.replace(/\/(claude|codex|copilot)\/v1(\/.*)?$/i, '');
  s = s.replace(/\/(health|dashboard)$/i, '');

  // Bare subdomain (no dot, colon or slash) -> the selected service's domain.
  // Skipped when pointing straight at a host, where there is no domain to add.
  if (!service.direct && !/[.:/]/.test(s)) s = `${s}.${service.host}`;

  let probe;
  try { probe = new URL('http://' + s); }
  catch { return null; }

  const local = isLocalHost(probe.hostname);
  if (!local && !probe.hostname.includes('.')) return null;

  const scheme = typed || (local ? 'http:' : 'https:');
  // ccproxy's default port, so "127.0.0.1" alone is enough to type.
  const port = probe.port || (local ? String(DEFAULT_PORT) : '');

  let url;
  try { url = new URL(`${scheme}//${probe.hostname}${port ? ':' + port : ''}${probe.pathname}`); }
  catch { return null; }

  return url.origin + url.pathname.replace(/\/+$/, '');
}

class ProxyClient {
  constructor({ baseUrl, token, provider = 'claude' }) {
    this.baseUrl = baseUrl;
    this.token = (token || '').trim();
    this.provider = provider;
  }

  get root() { return `${this.baseUrl}/${this.provider}/v1`; }

  /**
   * Headers, kept as bare as the request allows.
   *
   * Every header beyond the CORS-safelisted ones turns a cross-origin request
   * into one needing a preflight OPTIONS, and the preflight is where a
   * misconfigured server fails. So Content-Type goes only on requests that
   * actually carry a body, and Authorization only when there is a token.
   */
  headers(extra = {}) {
    const h = { ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /** GET /{provider}/v1/models -> [{id, label}] */
  async listModels(signal) {
    // No Content-Type: there is no body, and adding one would force a
    // preflight for nothing.
    const res = await fetch(`${this.root}/models`, {
      method: 'GET',
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw await httpError(res);

    const body = await res.json();
    const rows = body?.data || body?.models || (Array.isArray(body) ? body : []);
    const models = rows
      .map(r => (typeof r === 'string' ? { id: r } : r))
      .filter(r => r && r.id)
      .map(r => ({ id: r.id, label: r.display_name || r.name || r.id }));

    if (!models.length) throw new Error('The tunnel answered, but listed no models.');

    // Newest-looking first, then alphabetical — ccproxy order is not stable.
    models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    return models;
  }

  /**
   * POST /{provider}/v1/chat/completions with stream:true.
   * Calls onDelta(textChunk) as tokens arrive; resolves with the full text.
   */
  async streamChat({ model, messages, signal, onDelta }) {
    const res = await fetch(`${this.root}/chat/completions`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 8192,
      }),
    });
    if (!res.ok) throw await httpError(res);
    if (!res.body) throw new Error('Streaming is not supported by this browser.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line, whose terminator may be LF
      // or CRLF. Matching only "\n\n" finds nothing at all in a CRLF stream,
      // so the reply would silently never render.
      let m;
      while ((m = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);

        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          let json;
          try { json = JSON.parse(data); } catch { continue; }

          const delta =
            json.choices?.[0]?.delta?.content ??      // OpenAI streaming
            json.choices?.[0]?.text ??                // completions fallback
            json.delta?.text ??                       // Anthropic-ish
            '';
          if (delta) { full += delta; onDelta?.(delta); }

          if (json.error) throw new Error(json.error.message || 'Upstream error.');
        }
      }
    }
    return full;
  }
}

/** This page's origin, as ccproxy would need to allow it. */
function pageOrigin() {
  if (typeof location === 'undefined') return 'https://example.github.io';
  // file:// pages send "null" as the Origin, which cannot be allowlisted;
  // point at the local-server route instead, which can be.
  return location.origin === 'null' || location.protocol === 'file:'
    ? 'http://127.0.0.1:8080'
    : location.origin;
}

/** Build a readable Error from a failed response. */
async function httpError(res) {
  let detail = '';
  try {
    const text = (await res.text()).slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.detail || j.message || text;
    } catch { detail = text; }
  } catch { /* body already consumed or empty */ }

  const hints = {
    401: 'ccproxy rejected the request — run `ccproxy auth login claude` in Termux, or check your auth token here under Advanced.',
    403: 'Forbidden. If you set an auth token in ccproxy, enter it under Advanced.',
    404: 'That route was not found. Check the provider (claude / codex / copilot) under Advanced.',
    502: 'The tunnel reached nothing on port 8000 — is `ccproxy serve --port 8000` still running?',
    503: 'ccproxy is still booting. Wait for `server_ready` in ~/ccproxy.log and retry.',
  };
  const err = new Error(
    `${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}` +
    (hints[res.status] ? `\n\n${hints[res.status]}` : '')
  );
  err.status = res.status;
  return err;
}

/**
 * Whether an https page calling this http address is going to have trouble.
 * This is not a clean yes/no, and it is worth being precise about why.
 *
 * Loopback is "potentially trustworthy", so http://127.0.0.1 is exempt from
 * mixed-content blocking and generally goes through. A private LAN address
 * gets no such exemption: browsers warn on it, and whether it is actually
 * refused depends on the browser and on how the page itself is served —
 * Chrome's Private Network Access rules bite when a *public* origin reaches
 * into a private one, which is exactly the GitHub-Pages-hosted case.
 *
 * So: warn on both, more strongly on the second, and never promise either
 * way. Returns null when there is nothing to say.
 */
function httpFromHttpsIssue(baseUrl) {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return null;
  if (!/^http:\/\//i.test(baseUrl || '')) return null;

  let host;
  try { host = new URL(baseUrl).hostname; } catch { return null; }

  if (LOOPBACK_RE.test(host)) {
    return {
      level: 'risky',
      text: 'This page is on https. Loopback is usually still allowed, but '
          + 'Private Network Access checks can refuse it. If it fails, open '
          + 'this page over http from this device.',
    };
  }
  return {
    level: 'risky-lan',
    text: 'This page is on https and this is a plain http address on your '
        + 'network. Browsers restrict that, and a page served from a public '
        + 'host is likely to be refused. Open this page over http from this '
        + 'device, or use a tunnel.',
  };
}

const mixedContentBlocked = url => !!httpFromHttpsIssue(url);

/** Turn a fetch/network failure into something a phone user can act on. */
function describeNetworkError(err, baseUrl, service = TUNNEL_SERVICES.serveo) {
  if (err?.name === 'AbortError') return 'Cancelled.';
  if (err instanceof TypeError) {
    const lines = [`Could not reach ${baseUrl}.`, '', 'Common causes:'];

    const issue = httpFromHttpsIssue(baseUrl);
    if (issue) {
      lines.push('• ' + issue.text.replace(/\s+/g, ' '));
    }
    if (service.direct) {
      lines.push(
        `• ccproxy is not running, or not on port ${DEFAULT_PORT} — check with`,
        `  curl http://127.0.0.1:${DEFAULT_PORT}/health`,
        '• On a LAN address: the phone and the other device must be on the same',
        '  network, and ccproxy must be bound to 0.0.0.0, not just 127.0.0.1.'
      );
    } else {
      lines.push(
        `• The tunnel reconnected and got a new subdomain — check ${service.log}.`,
        `• ccproxy is not running, or not on port ${DEFAULT_PORT}.`
      );
    }
    lines.push(
      '• CORS — the most likely cause, and it needs a change on ccproxy\'s side.',
      '  Its default allowed origins match nothing a browser actually sends, so',
      '  a fresh install rejects this page whatever address it is on.',
      '  Add this to ~/.config/ccproxy/config.toml and restart ccproxy:',
      '',
      '      [cors]',
      `      origins = ["${pageOrigin()}"]`,
      '',
      '  A request that works with curl but not here is this, every time:',
      '  curl does not send an Origin header, so CORS never applies to it.'
    );
    return lines.join('\n');
  }
  return err?.message || String(err);
}
