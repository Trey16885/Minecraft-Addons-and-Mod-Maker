# Minecraft-Addons-and-Mod-Maker
[Make Them Here!](https://trey16885.github.io/Minecraft-Addons-and-Mod-Maker/)
*Note: This is for Termux which is only on Android, You will have to make the mod on an Android phone and send it to your PC or use addons for your Android device.*

Create Minecraft addons, or mods using AI (Requires Claude Pro, or Max since this uses a Claude Code Proxy)

## How to get Claude Code Proxy
# ccproxy in Termux + Serveo tunnel

Install ccproxy, serve it on port 8000, expose it publicly through Serveo.

---

## 1. Packages

```bash
pkg update -y && pkg upgrade -y
pkg install -y python python-pip rust binutils clang make openssl libffi openssh autossh curl
```

`rust` is needed because `pydantic-core` has no Android wheel and compiles from source. `openssh` provides the `ssh` client; `autossh` wraps it and restarts the tunnel when it drops.

## 2. Rust build target

```bash
export CARGO_BUILD_TARGET=aarch64-linux-android
```

For a 32-bit device use `armv7-linux-androideabi`. Check with `uname -m`.

## 3. Virtualenv + install

```bash
python -m venv ~/ccproxy
source ~/ccproxy/bin/activate
pip install --upgrade pip
pip install ccproxy-api
ccproxy --version
```

Skip the `[all]` extras — they pull DuckDB and Prometheus, which fight you on Android.

The pip step is the slow one. Expect 10+ minutes while Rust compiles.

## 4. Config

`/tmp` is read-only on Android, so plugins that write there must be disabled.

```bash
mkdir -p ~/.config/ccproxy
cat > ~/.config/ccproxy/config.toml << 'EOF'
enable_plugins = true
disabled_plugins = [
  "duckdb_storage", "analytics", "metrics", "docker",
  "request_tracer", "command_replay", "claude_sdk",
]
EOF
```

## 5. Log in

```bash
ccproxy auth login claude
```

A URL prints. Long-press to copy, paste into your browser, approve. Swap `claude` for `codex` or `copilot` as needed.

If a terminal browser (w3m/lynx) hijacks the link, press `q` then `y` to escape, run `unset BROWSER`, and copy the URL manually.

## 6. Serve on port 8000

Foreground:

```bash
source ~/ccproxy/bin/activate
termux-wake-lock
ccproxy serve --port 8000
```

Background:

```bash
source ~/ccproxy/bin/activate
termux-wake-lock
nohup ccproxy serve --port 8000 > ~/ccproxy.log 2>&1 &
echo $! > ~/ccproxy.pid
```

Startup takes 60–90 seconds on Android. Wait for `server_ready` in the log, then confirm:

```bash
curl http://127.0.0.1:8000/health
```

A `"status":"pass"` response means it's live.

## 7. Serveo tunnel (autossh)

In a second Termux session (swipe from the left edge → New session):

```bash
autossh -M 0 \
  -o "ServerAliveInterval 30" \
  -o "ServerAliveCountMax 3" \
  -o "ExitOnForwardFailure yes" \
  -o "StrictHostKeyChecking accept-new" \
  -R 80:localhost:8000 serveo.net
```

`autossh` watches the connection and relaunches `ssh` whenever it dies — mobile networks drop constantly, so this matters more on a phone than anywhere else.

What the flags do:

- `-M 0` — disables autossh's own monitoring port; the SSH keepalives below do the job instead
- `ServerAliveInterval 30` / `CountMax 3` — ping every 30s, give up after 3 misses, which is what actually triggers a reconnect
- `ExitOnForwardFailure yes` — quit if the port forward fails, so autossh retries rather than sitting on a useless connection
- `StrictHostKeyChecking accept-new` — no interactive prompt on first connect

Serveo prints a random `https://xxxx.serveo.net` URL. Leave the session open.

Backgrounded version:

```bash
export AUTOSSH_GATETIME=0
nohup autossh -M 0 \
  -o "ServerAliveInterval 30" \
  -o "ServerAliveCountMax 3" \
  -o "ExitOnForwardFailure yes" \
  -o "StrictHostKeyChecking accept-new" \
  -R 80:localhost:8000 serveo.net > ~/serveo.log 2>&1 &

sleep 5
grep -o 'https://[^ ]*serveo.net' ~/serveo.log
```

`AUTOSSH_GATETIME=0` tells autossh to keep retrying even if the very first connection fails — without it, one bad startup and it gives up entirely.

**The URL changes on every reconnect.** Serveo assigns a random subdomain each time, so an unattended reconnect silently hands you a new address. Re-run the `grep` above to find the current one, or watch it live with `tail -f ~/serveo.log`.

## 7b. localhost.run tunnel (alternative)

Serveo goes down fairly often. `localhost.run` is a drop-in replacement that
needs no account — the `nokey@` user is exactly that, an anonymous session.

```bash
AUTOSSH_GATETIME=0 autossh -M 0 -T \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -R 80:127.0.0.1:8000 nokey@localhost.run
```

Same flags as the Serveo command, and they do the same jobs — see section 7.
Two differences worth noting: `-T` skips allocating a terminal, since this
connection only carries the forward, and the forward targets `127.0.0.1:8000`
rather than `localhost:8000`, which sidesteps a stall when the resolver hands
back an IPv6 `localhost` that ccproxy is not listening on.

It prints a URL ending in **`.lhr.life`**:

```
** your connection id is xxxxxxxx-xxxx-... **
https://3f9a2c1b.lhr.life tunneled with tls termination
```

Backgrounded:

```bash
export AUTOSSH_GATETIME=0
nohup autossh -M 0 -T \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -R 80:127.0.0.1:8000 nokey@localhost.run > ~/lhr.log 2>&1 &

sleep 8
grep -o 'https://[^ ,]*\.lhr\.life' ~/lhr.log | head -1
```

(The banner line repeats the URL, hence `head -1`.)

Like Serveo, **the subdomain is random and changes on every reconnect**, so
re-run that `grep` (or `tail -f ~/lhr.log`) after a drop to get the current
address. Everything downstream is identical — the same `/claude/v1/...`
routes, and the app takes either kind of URL.

Stop it the same way: `pkill autossh`.

## 8. Test it

```bash
URL=https://xxxx.serveo.net    # or https://xxxx.lhr.life — your actual URL

curl $URL/health
curl $URL/claude/v1/models

curl $URL/claude/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
```

---

## Endpoints

Routes are provider-prefixed:

| Path | Format |
|---|---|
| `/claude/v1/chat/completions` | OpenAI |
| `/claude/v1/messages` | Anthropic |
| `/claude/v1/responses` | OpenAI Responses |
| `/claude/v1/models` | model list |
| `/health` | health check |
| `/dashboard` | web UI |

Swap `claude` for `codex` or `copilot`.

## Stopping

```bash
kill $(cat ~/ccproxy.pid)     # server
pkill autossh                 # tunnel (kill autossh, not ssh - it'll just respawn)
termux-wake-unlock
```

## Updating

```bash
kill $(cat ~/ccproxy.pid)
source ~/ccproxy/bin/activate
pip install --upgrade ccproxy-api
```

---

## Security

**Direct avoids this entirely.** Nothing is exposed off the device, so if you are working on the phone alone, prefer it over a tunnel.

**A Serveo tunnel is public.** Anyone with the URL can send requests that authenticate as you and spend your subscription quota. ccproxy has no auth on its endpoints by default.

Before exposing it:

- Enable ccproxy's auth token if your version supports it (`ccproxy --help`), and require it on every request.
- Treat the URL as a secret. Don't paste it anywhere public.
- Kill the tunnel when you're done rather than leaving it up.

Also worth knowing: proxying subscription access sits in a gray area with most providers' terms, and sustained programmatic traffic is the pattern most likely to draw attention. Fine for your own tools; don't build anything load-bearing on it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ERR_CONNECTION_REFUSED` | Server still booting — wait for `server_ready` |
| `command not found: ccproxy` | Forgot `source ~/ccproxy/bin/activate` |
| `Read-only file system: '/tmp'` | Plugin not in `disabled_plugins` |
| 401 on requests | OAuth login never completed |
| 404 on a model id | Package predates that model |
| Tunnel dies on screen-off | Missing `termux-wake-lock` |
| autossh exits immediately | Set `AUTOSSH_GATETIME=0` |
| Public URL stopped working | Tunnel reconnected with a new subdomain — check `~/serveo.log` or `~/lhr.log` |

# How we work

## Accessing Claude

After running all of those commands you will paste your tunnel link in the input field on the page — Serveo or localhost.run, either works — and we will add the `/claude/v1/chat/completions` for you. Select which version you are using, Bedrock or Java. If you are using Java, you are required to tell the version of Java.

Claude will make a Minecraft addon or mod based on what you want.

## The app

The page is plain static HTML/CSS/JS — no build step, no backend. Open
`index.html` and it does the rest.

**On a phone (Termux), in a third session:**

```bash
cd ~/Minecraft-Addons-and-Mod-Maker
python -m http.server 8080
```

Then open `http://127.0.0.1:8080` in your Android browser. Served this way the
page is on plain http itself, so it can talk to ccproxy directly — **no tunnel
needed at all.** Pick **Direct** on the connect screen and leave the prefilled
`127.0.0.1:8000` as-is.

**Or host it.** Because everything is client-side, GitHub Pages works: repo
Settings → Pages → deploy from the `main` branch. Serving over HTTPS is the
reason the tunnels exist — an HTTPS page is not allowed to call a plain HTTP
address, but it can call your HTTPS tunnel. Both Serveo and localhost.run
terminate TLS for you, so either satisfies that. **Direct will not work from a
Pages-hosted copy**, for exactly that reason; see below.

### If the page looks wrong after an update

GitHub Pages caches `index.html` and the `js/` and `css/` files separately
(`max-age=600`), so a browser can end up running a new page against old
scripts. That fails in confusing ways rather than obviously — buttons that do
nothing, labels that never change.

Two things guard against it:

- Every asset is loaded with a `?v=` version on it, so a new `index.html`
  points at URLs the browser has never seen and must re-fetch.
- The page checks the build the scripts report against the one it expects, and
  shows a **Reload** bar if they disagree.

**If you edit anything in `js/` or `css/`, bump both:** the `?v=` on the script
and stylesheet tags at the bottom of `index.html`, and `BUILD` at the top of
`js/config.js`. They must match. If you forget, the Reload bar will tell you.

To force a refresh by hand, load the page with any query string on the end,
e.g. `…/index.html?x=1`.

### Direct, and when it works

**Direct** skips the tunnel and has the page call ccproxy straight on
`127.0.0.1:8000`. It is the simplest setup — one less moving part, no random
subdomain to re-copy after every reconnect, and nothing exposed to the
internet. The catch is that ccproxy speaks plain http, and whether a browser
will allow that depends on where the page itself came from:

| Page served from | Direct to `127.0.0.1` | Direct to a LAN IP |
|---|---|---|
| `http://127.0.0.1:8080` (Termux) | works | works |
| a `file://` path | works | works |
| GitHub Pages / any https host | usually works | unreliable |

The rule browsers apply is mixed content: an https page may not fetch plain
http. Loopback is carved out of that as "potentially trustworthy", so
`http://127.0.0.1` from an https page does go through — measured, not assumed:
in Chromium it returns normally with no block. A LAN address like
`192.168.1.5` gets no such exemption. In testing Chromium still *attempted* it
and only logged a warning rather than blocking, but that was from a page
itself served on `127.0.0.1`. From a genuinely public origin such as GitHub
Pages, Chrome's Private Network Access rules apply — a public page reaching
into a private network needs the target to opt in, which ccproxy does not do.
Treat Direct-to-LAN from a hosted copy as unsupported.

The app checks this before you connect and warns you rather than letting it
fail as an unexplained network error. When it does, the button at the bottom of
the connect card — *"Getting errors because of https? Run the site on your own
http localhost"* — opens the steps to serve the page yourself, with the
commands ready to copy and a link straight to the local copy. It hides itself
when the page is already being served over http, since there is then nothing
to fix.

Two other things Direct accepts:

- **A bare address.** `127.0.0.1` is enough — port `8000` is filled in. Type a
  port explicitly to override it.
- **Another device on your Wi-Fi.** Put in `192.168.1.5:8000` to drive ccproxy
  running on a different machine. That needs ccproxy bound to `0.0.0.0`, not
  just loopback, and the page served over http.

Local addresses are recognised whichever button is selected, so pasting
`127.0.0.1:8000` while Serveo is highlighted still does the right thing.

### What happens when you use it

1. **Connect.** Pick how to reach ccproxy, then give it the address. A full
   URL is always used as-is whatever is selected — the picker only expands a
   bare name: `bright-otter` becomes `https://bright-otter.serveousercontent.com`
   under Serveo, `3f9a2c1b` becomes `https://3f9a2c1b.lhr.life` under
   localhost.run, and **Direct** prefills `127.0.0.1:8000` and skips the
   tunnel entirely. A pasted `/claude/v1/…` path or `/health` is trimmed off,
   so the curl URL from section 8 works too. The page then calls
   `/claude/v1/models`.
2. **Pick a model.** The dropdown is filled from that live model list, so it
   always matches what your ccproxy build actually supports.
3. **Pick your edition.** Bedrock, or Java plus its version. This chooses the
   system instructions the model is sent, and whether you get a `.mcaddon` or
   a `.jar`.
4. **Chat.** Describe the mod. The model replies with ` ```python ` blocks.
5. **The Python runs in your browser.** Every block is executed in Pyodide with
   Pillow available, in a workspace that persists across the whole session, so
   the model can build a pack up over several messages. stdout, stderr and
   tracebacks are handed straight back to the model, so it sees its own
   mistakes and fixes them without you copying anything.
6. **Export.** The Files drawer lists everything generated; Export zips the
   workspace into `yourpack.mcaddon` (Bedrock) or `yourmod.jar` (Java) and
   downloads it.

### Installing what you built

- **Bedrock:** open the downloaded `.mcaddon` with Minecraft. On Android, tap
  it in your file manager and choose Minecraft. The packs then appear under
  Settings → Storage → Behaviour/Resource packs, and you activate them per
  world.
- **Java:** drop the `.jar` in `.minecraft/mods` with Fabric or Forge
  installed. Note the limitation below.

### The Java caveat, stated plainly

A real Java code mod is compiled from `.java` source by Gradle. Pyodide cannot
run `javac`, so nothing in this browser can compile Java. What that means:

- Mods that are **data- and resource-driven** (recipes, loot tables, tags,
  models, textures, datapack-style content with a `fabric.mod.json`) package
  into a working `.jar` here and load fine.
- Mods that need **actual Java code** will come out as source. The app warns
  you when it sees `.java` files without `.class` files, and the **Download raw
  .zip** button gives you the project to build with Gradle on a PC.

Bedrock has no such limitation — addons are JSON and scripts all the way down,
so `.mcaddon` output is complete and ready to play.

### Settings and privacy

Your tunnel URL, auth token, model and edition are kept in this browser's
`localStorage` and are sent nowhere but your own tunnel. Generated files live
only in the page's memory until you export them, and clearing the workspace or
closing the tab discards them.

### Menu options

| Option | What it does |
|---|---|
| New chat | Clears the conversation. Generated files are kept. |
| Change model / edition | Back to the setup screen. |
| Auto-run Python | On by default. Off gives every code block a manual **Run** button. |
| Clear generated files | Empties the workspace so the next pack starts clean. |

### App troubleshooting

| Symptom | Cause |
|---|---|
| "Could not reach …" | Tunnel reconnected with a new subdomain — check `~/serveo.log` or `~/lhr.log` |
| Direct fails from a hosted copy | An https page reaching a plain-http private address — tap the "Getting errors because of https?" button for the steps to serve it locally |
| Direct fails to a LAN IP | ccproxy is bound to loopback only; restart it on `0.0.0.0`, and check both devices are on the same Wi-Fi |
| Fails only in the browser, `curl` works | CORS — ccproxy did not allow the page's origin |
| 401 with a token set | The token here must match ccproxy's; blank if you set none |
| "Loading Python runtime" hangs | Pyodide is ~10 MB from a CDN on first run; needs a working connection |
| Export button greyed out | No files generated yet — ask the AI to build the pack |
| Nothing runs after a reply | Auto-run is off; use the Run button on the code block |
| Buttons do nothing / labels never change after an update | Cached old scripts — reload, or load the page with `?x=1` on the end |
| Page freezes during a run | The AI's code hit an infinite loop — Python runs on the page's main thread. Reload; the workspace is lost, so export often |
| Stops after 6 rounds | A safety stop on the auto-run loop. Send any message to continue |
