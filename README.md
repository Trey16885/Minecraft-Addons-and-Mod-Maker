# Minecraft-Addons-and-Mod-Maker
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

## 8. Test it

```bash
URL=https://xxxx.serveo.net    # your actual URL

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
| Public URL stopped working | Tunnel reconnected with a new subdomain — check `~/serveo.log` |

# How we work

## Accessing Claude
 
After running all of those command you will paste the serveo tunnel link in the input field on the page for the Serveo Link, we will add the /claude/v1/chat/completions for you. Select with version you are using Bedrock or Java. If you are using Java, you are required to tell the version of Java.

Claude will make a Minecraft addon or mod based on what you want.