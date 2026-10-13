// Generates a Jupyter notebook (nbformat 4.5) that turns a Colab / Kaggle / Jupyter GPU machine into an
// Ollama server behind a tunnel, protected by a token generated at run time. No secret is ever baked in.
'use strict';
const crypto = require('crypto');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

const lines = (s) => { const a = s.replace(/^\n/, '').replace(/\n$/, '').split('\n'); return a.map((l, i) => (i < a.length - 1 ? l + '\n' : l)); };
const md = (s) => ({ cell_type: 'markdown', id: crypto.randomBytes(4).toString('hex'), metadata: {}, source: lines(s) });
const code = (s) => ({ cell_type: 'code', id: crypto.randomBytes(4).toString('hex'), metadata: {}, execution_count: null, outputs: [], source: lines(s) });

const INTRO = `
# Faber remote model server

This notebook turns the machine it runs on (a Colab / Kaggle / Jupyter GPU session) into an **Ollama** server and opens a **public tunnel** to it, so Faber on your PC can use that GPU.

**Read this first**
- Everything Faber sends (your prompts, the contents of files the assistant reads, its replies) is processed on this machine, which belongs to Google / Kaggle / whoever runs it. Do not use it for code or data you are not allowed to share.
- The tunnel URL is **public**. Anyone who learns it could use your GPU. This notebook starts a small gate that requires an access token (generated fresh each session and shown only in the last output). Do not turn the token off unless you know why.
- Before sharing or saving a copy of this notebook (Drive, GitHub), use *Edit > Clear all outputs*: the token and URL are printed in the outputs.
- Free sessions are limited. Colab disconnects idle sessions (roughly 90 minutes), ends sessions after about 12 hours at most, and may not give you a GPU at all. Kaggle has weekly GPU quotas. **The tunnel URL changes every session**, so you paste the new URL into Faber each time.
- Nothing here logs in to Google for you or automates the Colab page. You run the notebook yourself. The keep-alive cell only reports status; it does not defeat the provider's limits.

**Steps**
1. Pick a GPU runtime (Colab: *Runtime > Change runtime type > T4 GPU*; Kaggle: *Session options > Accelerator*, and turn Internet on).
2. Run all cells (*Runtime > Run all*). The first run takes a few minutes (install + model download).
3. When the last-but-one cell prints \`FABER_URL=...\` (and \`FABER_TOKEN=...\`), copy them.
4. In Faber open the **Remote** tab, section *Notebook helper*, and paste them into *Paste the URL here*. Press *Add and test*, then *Use this server*.
5. Keep the final cell running while you work. Stop it (or the whole session) when you are done.
`;

const SETTINGS = (o) => `
# --- Settings: edit here if you like -----------------------------------------
MODEL = ${JSON.stringify(o.model)}       # model to download and serve (any name from ollama.com/library)
TUNNEL = ${JSON.stringify(o.tunnel)}      # "cloudflared" (no account needed) or "ngrok" (needs your own ngrok account)
REQUIRE_TOKEN = ${o.requireToken ? 'True' : 'False'}      # strongly recommended: the tunnel URL is public
API_TOKEN = ""                  # leave empty to generate a random token each session
OLLAMA_PORT = 11434             # Ollama listens on 127.0.0.1 only
PROXY_PORT = 11435              # local gate (checks the token); the tunnel points here
`;

const GPU = `
import shutil, subprocess
if shutil.which("nvidia-smi"):
    print(subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip())
else:
    print("No NVIDIA GPU found: models will run on the CPU (slow). In Colab use Runtime > Change runtime type > T4 GPU.")
`;

const INSTALL = `
import os, shutil, subprocess

def sh(cmd, check=True):
    print("$", cmd)
    r = subprocess.run(cmd, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(r.stdout[-3000:])
    if check and r.returncode != 0:
        raise RuntimeError("command failed: " + cmd)
    return r

if shutil.which("ollama") is None:
    sh("(apt-get update -qq && apt-get install -y -qq zstd pciutils lshw) > /dev/null 2>&1 || true", check=False)
    sh("curl -fsSL https://ollama.com/install.sh | sh")
print(sh("ollama --version", check=False).stdout)
`;

const SERVE = `
import json, time, urllib.request

def wait_http(url, seconds=60):
    for _ in range(int(seconds * 2)):
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return True
        except Exception:
            time.sleep(0.5)
    return False

if not wait_http(f"http://127.0.0.1:{OLLAMA_PORT}/api/version", 2):
    env = dict(os.environ, OLLAMA_HOST=f"127.0.0.1:{OLLAMA_PORT}", OLLAMA_KEEP_ALIVE="24h")
    server = subprocess.Popen(["ollama", "serve"], env=env, stdout=open("/tmp/ollama.log", "ab"), stderr=subprocess.STDOUT)
assert wait_http(f"http://127.0.0.1:{OLLAMA_PORT}/api/version"), "Ollama did not start; see /tmp/ollama.log"
print("Ollama is running on 127.0.0.1:%d" % OLLAMA_PORT)
`;

const PULL = `
import shlex
sh(f"ollama pull {shlex.quote(MODEL)}")
# Load the model into memory now and keep it there, so the first request from Faber does not time out in the tunnel.
req = urllib.request.Request(f"http://127.0.0.1:{OLLAMA_PORT}/api/generate",
                             data=json.dumps({"model": MODEL, "prompt": "", "keep_alive": -1}).encode(),
                             headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=900).read()
print("Model ready:", MODEL)
`;

const GATE = `
import hmac, secrets, threading, http.client, http.server, json

TOKEN = (API_TOKEN or secrets.token_urlsafe(24)) if REQUIRE_TOKEN else ""
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}

class Gate(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            data = b""
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return data
                data += self.rfile.read(size)
                self.rfile.readline()
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else None

    def _forward(self):
        body = self._read_body()
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + TOKEN).encode()):
            return self._send_json(401, {"error": "missing or wrong access token"})
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "authorization"}
        conn = http.client.HTTPConnection("127.0.0.1", OLLAMA_PORT, timeout=3600)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except Exception as e:
            return self._send_json(502, {"error": "Ollama is not reachable on the server: %s" % e})
        try:
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            if self.command == "HEAD":
                self.end_headers()
                return
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = resp.read1(65536)   # returns as soon as data is available, so streamed answers stay live
                if not chunk:
                    break
                self.wfile.write(b"%x\\r\\n" % len(chunk) + chunk + b"\\r\\n")
                self.wfile.flush()
            self.wfile.write(b"0\\r\\n\\r\\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()

    do_GET = do_POST = do_DELETE = do_HEAD = _forward

class QuietServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

gate = QuietServer(("127.0.0.1", PROXY_PORT), Gate)
threading.Thread(target=gate.serve_forever, daemon=True).start()
print("Token gate is %s on 127.0.0.1:%d" % ("ON" if TOKEN else "OFF (anyone with the URL can use your GPU)", PROXY_PORT))
`;

const TUNNEL = `
import re, threading

public_url = None
tunnel_proc = None
if TUNNEL == "cloudflared":
    cf = shutil.which("cloudflared") or "/tmp/cloudflared"
    if not os.path.exists(cf):
        sh(f"curl -fsSL -o {cf} https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x {cf}")
    tunnel_proc = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PROXY_PORT}"],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    found = threading.Event()
    def pump():
        global public_url
        for line in tunnel_proc.stdout:
            m = re.search(r"https://[a-z0-9-]+\\.trycloudflare\\.com", line)
            if m and not public_url:
                public_url = m.group(0)
                found.set()
    threading.Thread(target=pump, daemon=True).start()
    found.wait(90)
elif TUNNEL == "ngrok":
    import getpass
    ngrok_token = os.environ.get("NGROK_TOKEN", "")
    if not ngrok_token:
        try:
            from google.colab import userdata
            ngrok_token = userdata.get("NGROK_TOKEN")
        except Exception:
            ngrok_token = getpass.getpass("ngrok authtoken (hidden, not saved in this notebook): ")
    sh("pip install -q pyngrok")
    from pyngrok import ngrok
    ngrok.set_auth_token(ngrok_token)
    public_url = ngrok.connect(PROXY_PORT, "http").public_url.replace("http://", "https://")
else:
    raise ValueError("TUNNEL must be 'cloudflared' or 'ngrok'")
assert public_url, "The tunnel did not start. Re-run this cell."
`;

const SHOW = `
print("=" * 64)
print("Copy these lines into Faber (Remote tab > Notebook helper > Paste the URL here):")
print()
print("FABER_URL=" + public_url)
if TOKEN:
    print("FABER_TOKEN=" + TOKEN)
print()
print("Model:", MODEL, "| This URL is public and changes every session. Clear outputs before sharing the notebook.")
print("=" * 64)
`;

const KEEP = `
# Keep this cell running while you use Faber. Interrupt it to stop watching (the session keeps running until it expires).
# It only reports status. It cannot prevent Colab / Kaggle from ending the session.
try:
    last = None
    while True:
        ok = wait_http(f"http://127.0.0.1:{OLLAMA_PORT}/api/version", 3)
        tun = "ngrok" if TUNNEL == "ngrok" else ("up" if tunnel_proc is not None and tunnel_proc.poll() is None else "DOWN")
        state = (ok, tun)
        if state != last or int(time.time()) % 600 < 30:
            print(time.strftime("%H:%M:%S"), "| ollama:", "ok" if ok else "DOWN", "| tunnel:", tun,
                  "" if tun != "DOWN" else "(run the tunnel cell again; the URL will change)")
            last = state
        time.sleep(30)
except KeyboardInterrupt:
    print("Stopped watching.")
`;

const STOP = `
# Optional: stop everything started by this notebook.
for p in (globals().get("tunnel_proc"), globals().get("server")):
    try:
        p and p.terminate()
    except Exception:
        pass
try:
    gate.shutdown()
except Exception:
    pass
print("Stopped.")
`;

const KAGGLE_NOTES = `
**Kaggle specifics**
- In the notebook sidebar open *Session options* and turn **Internet** on (it is off by default; Ollama and the tunnel need it). Internet needs a phone-verified Kaggle account.
- Choose a GPU under *Accelerator* (T4 x2 or P100). Weekly GPU quota applies.
- A Kaggle session ends after at most about 12 hours, and sooner when idle. Check Kaggle's rules before running servers or tunnels from a notebook; they may restrict it.
- Use *Save Version > Quick Save* only after *Clear all outputs*, otherwise the token and URL are stored in the saved version.
`;

function buildNotebook(opts = {}) {
  const platform = opts.platform === 'kaggle' ? 'kaggle' : 'colab';
  const o = {
    model: String(opts.model || 'qwen2.5-coder:7b').trim(),
    tunnel: opts.tunnel === 'ngrok' ? 'ngrok' : 'cloudflared',
    requireToken: opts.requireToken !== false,
  };
  if (!MODEL_RE.test(o.model)) throw new Error('That model name has characters Ollama does not use. Example: qwen2.5-coder:7b');
  return {
    cells: [md(platform === 'kaggle' ? INTRO + KAGGLE_NOTES : INTRO), code(SETTINGS(o)), code(GPU), code(INSTALL), code(SERVE), code(PULL), code(GATE), code(TUNNEL), code(SHOW), code(KEEP), md('### Optional: stop everything'), code(STOP)],
    metadata: {
      accelerator: 'GPU',
      ...(platform === 'kaggle' ? { kaggle: { accelerator: 'nvidiaTeslaT4', isInternetEnabled: true, language: 'python', sourceType: 'notebook', isGpuEnabled: true } } : { colab: { provenance: [], gpuType: 'T4' } }),
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

module.exports = { buildNotebook, MODEL_RE };
