/* api.js — talks to ccproxy through an SSH tunnel (Serveo or localhost.run). */

/**
 * Turn whatever the user pasted into a base URL.
 *
 *   bright-otter            -> https://bright-otter.<the picked service>
 *   3f9a2c.lhr.life         -> https://3f9a2c.lhr.life
 *   https://x.serveo.net/   -> https://x.serveo.net
 *   https://x.lhr.life/claude/v1/...  -> https://x.lhr.life   (route stripped)
 *
 * A host that already carries a dot is used as-is, so a full URL from either
 * service works no matter which one is selected; `host` only fills in the
 * domain for the bare-name shortcut.
 *
 * Always forces https: a page served over https cannot call http (mixed
 * content), which is the whole reason we tunnel instead of using localhost.
 */
function resolveBaseUrl(raw, host = TUNNEL_SERVICES.serveo.host) {
  let s = (raw || '').trim();
  if (!s) return null;

  s = s.replace(/^[a-z]+:\/\//i, '');   // drop any scheme, we re-add https
  s = s.replace(/\/+$/, '');            // trailing slashes

  // Strip a pasted API path so people can paste the curl URL from the README.
  s = s.replace(/\/(claude|codex|copilot)\/v1(\/.*)?$/i, '');
  s = s.replace(/\/(health|dashboard)$/i, '');

  // Bare subdomain (no dot, no slash) -> the selected service's domain.
  if (!s.includes('.') && !s.includes('/')) s = `${s}.${host}`;

  let url;
  try { url = new URL('https://' + s); }
  catch { return null; }
  if (!url.hostname.includes('.')) return null;

  return url.origin + url.pathname.replace(/\/+$/, '');
}

class ProxyClient {
  constructor({ baseUrl, token, provider = 'claude' }) {
    this.baseUrl = baseUrl;
    this.token = (token || '').trim();
    this.provider = provider;
  }

  get root() { return `${this.baseUrl}/${this.provider}/v1`; }

  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /** GET /{provider}/v1/models -> [{id, label}] */
  async listModels(signal) {
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
      headers: this.headers(),
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

      // SSE frames are separated by a blank line.
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        for (const line of frame.split('\n')) {
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

/** Turn a fetch/network failure into something a phone user can act on. */
function describeNetworkError(err, baseUrl, service = TUNNEL_SERVICES.serveo) {
  if (err?.name === 'AbortError') return 'Cancelled.';
  if (err instanceof TypeError) {
    return [
      `Could not reach ${baseUrl}.`,
      '',
      'Common causes:',
      `• The tunnel reconnected and got a new subdomain — check ${service.log}.`,
      '• ccproxy is not running, or not on port 8000.',
      '• CORS: the browser blocked the response because ccproxy did not allow this origin.',
      '  Opening this page from the same phone over http:// avoids the mixed-content',
      '  problem but not CORS; if it persists, serve the page from the tunnel too.',
    ].join('\n');
  }
  return err?.message || String(err);
}
