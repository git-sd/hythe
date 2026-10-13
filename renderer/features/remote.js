/* feature: remote. Opt-in remote compute. Everything here is OFF until the user acts; while a remote server is
   active, prompts, file contents the AI reads and replies leave this PC. All network work is in the main process
   (src/features/remote.js). This file only builds UI and never holds a token after the user pressed Save. */
Faber.register('remote', (F) => {
  const NS = 'feat:remote:';
  const el = F.el;
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a).catch((e) => { throw new Error(clean(e)); });
  const $ = (id) => document.getElementById(id);
  let S = null;                       // last state from main (never contains tokens)
  let panel = null;
  const listeners = [];

  const fmtMB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const scopeText = { loopback: 'this PC', private: 'private network', public: 'public internet', ssh: 'SSH tunnel' };

  function copy(text, label) {
    try { navigator.clipboard.writeText(text).then(() => F.toast((label || 'Text') + ' copied'), () => F.toast('Copy failed: select the text and press Ctrl+C')); } catch { F.toast('Copy failed: select the text and press Ctrl+C'); }
  }
  function btn(text, fn, cls, title) {
    const b = el('button', cls || '', text);
    if (title) b.title = title;
    b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true;
      try { await fn(b); } catch (e) { F.error('Remote: ' + clean(e)); } finally { b.disabled = false; }
    };
    return b;
  }
  function field(label, input, hint) {
    const w = el('label', 'rmField');
    w.appendChild(el('span', 'rmLabel', label));
    w.appendChild(input);
    if (hint) w.appendChild(el('span', 'rmHint', hint));
    return w;
  }
  function inp(value, ph, type) { const i = el('input'); i.type = type || 'text'; i.value = value == null ? '' : value; if (ph) i.placeholder = ph; i.spellcheck = false; i.autocomplete = 'off'; return i; }
  function codeBlock(text, label) {
    const w = el('div', 'rmCode');
    const pre = el('pre', '', text);
    w.append(pre, btn('Copy', () => copy(text, label || 'Command'), 'ghost'));
    return w;
  }
  function section(title, open, build) {
    const d = el('details', 'rmSec');
    d.open = !!open;
    d.appendChild(el('summary', '', title));
    const body = el('div', 'rmBody');
    d.appendChild(body);
    build(body);
    return d;
  }
  function testLine(r) {
    if (!r.ok) return { bad: true, text: r.error || 'Failed.' };
    const n = (r.models || []).length;
    const names = (r.models || []).slice(0, 6).map((m) => m.name).join(', ');
    return { bad: false, text: `Connected. Ollama ${r.version}, ${r.latencyMs} ms, ${n} model${n === 1 ? '' : 's'}${names ? ': ' + names + (n > 6 ? ', ...' : '') : ''}.` };
  }
  function showResult(box, r) { const t = testLine(r); box.textContent = t.text; box.className = 'rmResult ' + (t.bad ? 'bad' : 'ok'); }

  /* ---------- state + indicator ---------- */
  async function refresh() { try { S = await call('state'); } catch (e) { return; } paintIndicator(); paintPanel(); }
  F.on(NS + 'state', (s) => { S = s; paintIndicator(); paintPanel(); });
  F.on(NS + 'event', (ev) => { if (ev && ev.message) F.error('Remote: ' + ev.message); });
  F.on('feat:host-changed', () => { refresh(); });

  let ind = null;
  function paintIndicator() {
    const bar = $('bar');
    if (!bar) return;
    if (!ind) { ind = el('span', 'rmInd'); ind.hidden = true; const sp = bar.querySelector('.spacer'); bar.insertBefore(ind, sp ? sp.nextSibling : null); }
    ind.innerHTML = '';
    if (S && S.active) {
      ind.hidden = false; ind.className = 'rmInd on';
      const t = el('button', 'rmIndTxt', `REMOTE: ${S.active.name}`);
      t.title = `Prompts, file contents and replies are being sent to ${S.active.host}${S.active.via ? ' via SSH ' + S.active.via : ''}. Click to open the Remote tab.`;
      t.onclick = () => F.showSideTab('remote');
      ind.append(t, btn('Back to local', () => goLocal(), 'rmBack', 'Switch back to the Ollama on this PC'));
    } else if (S && S.offer) {
      ind.hidden = false; ind.className = 'rmInd offer';
      ind.append(btn(`Reconnect to ${S.offer.name}?`, () => useServer(S.offer.id), 'rmIndTxt', 'Asks for confirmation first'));
    } else ind.hidden = true;
  }

  async function goLocal() { await call('local'); F.toast('Back on the local model. Nothing is sent off this PC now.'); await refresh(); }

  /* ---------- consent + switching ---------- */
  async function useServer(id) {
    const prep = await call('usePrepare', id);
    const s = prep.server;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      const m = F.modal({
        title: 'Send your work to a remote server?',
        body(b) {
          b.appendChild(el('div', 'rmWarnBox', 'Faber is offline by default. If you continue, everything you do in chat leaves this PC.'));
          const ul = el('ul', 'rmList');
          for (const t of [
            'Your prompts and conversation history',
            'The contents of files and command output the assistant reads' + (prep.folder ? ' from ' + prep.folder : ''),
            'The assistant\'s replies and tool results',
          ]) ul.appendChild(el('li', '', t));
          b.appendChild(ul);
          b.appendChild(el('p', '', `Server: ${s.name}`));
          b.appendChild(el('p', 'rmHint', `Address: ${s.host}  |  ${s.https ? 'encrypted (https)' : 'NOT encrypted (http)'}  |  ${scopeText[s.scope] || s.scope}${s.hasToken ? '  |  uses a saved token' : ''}`));
          if (!s.https && s.scope !== 'loopback' && s.scope !== 'ssh') b.appendChild(el('p', 'rmBad', 'This connection is not encrypted. Anyone on the path can read it. Use it only on a network you trust.'));
          if (s.scope === 'public') b.appendChild(el('p', 'rmBad', 'The server is on the public internet. Its owner can read what you send.'));
          b.appendChild(el('p', 'rmHint', 'You can switch back at any time with the "Back to local" button next to the model chip, or /local. Faber always starts local.'));
        },
        buttons: [
          { label: 'Cancel', onClick: fin },
          { label: 'Send my work to this server', primary: true, close: true,
            onClick: async () => {
              try {
                const r = await call('use', id, prep.nonce);
                F.toast(`Using remote server: ${s.name} (${(r.models || []).length} models)`);
                F.sys(`Remote model server active: ${s.name} (${s.host}). Prompts, file contents and replies are sent there until you choose Back to local.`);
              } catch (e) { F.error('Remote: ' + clean(e)); }
              await refresh(); fin();
            } },
        ],
      });
      const origClose = m.close;
      m.close = () => { origClose(); fin(); };
    });
  }

  /* ---------- server profile forms ---------- */
  const KINDS = {
    lan: { title: 'LAN / home server', url: 'http://192.168.1.50:11434', hint: 'Another PC or server on your network running Ollama (default port 11434).', token: false },
    hosted: { title: 'Hosted GPU or VPS (URL + optional token)', url: 'https://your-server.example.com', hint: 'RunPod, Vast.ai, Lambda, your own VPS... Use https:// when the address is public, and a token.', token: true },
    notebook: { title: 'Colab / Kaggle tunnel', url: 'https://something.trycloudflare.com', hint: 'The URL printed by the notebook. It changes every session.', token: true },
  };
  function serverForm(kind, existing, prefill) {
    const k = KINDS[kind] || KINDS.hosted;
    const name = inp(existing ? existing.name : (prefill && prefill.name) || '', 'e.g. Home GPU PC');
    let u = existing ? existing.url : (prefill && prefill.url) || '';
    const host = inp(u, k.url);
    const tok = inp('', existing && existing.hasToken ? '(saved token kept; type to replace)' : 'optional', 'password');
    tok.autocomplete = 'new-password';
    const res = el('div', 'rmResult');
    const m = F.modal({
      title: (existing ? 'Edit server: ' : 'Add server: ') + k.title,
      body(b) {
        b.appendChild(el('p', 'rmHint', k.hint));
        b.appendChild(field('Name', name));
        b.appendChild(field('Address', host, 'Host:port or a full URL. "/api" is stripped automatically.'));
        if (k.token) b.appendChild(field('Access token (optional)', tok, S && S.canEncrypt ? 'Stored encrypted with Windows secure storage. Never shown again.' : 'Secure storage is not available here, so a token cannot be saved. You can still add a server without a token.'));
        if (existing && existing.hasToken) { const c = el('label', 'rmCheck'); const cb = el('input'); cb.type = 'checkbox'; cb.id = 'rmClearTok'; c.append(cb, document.createTextNode(' Remove the saved token')); b.appendChild(c); }
        b.appendChild(res);
        const row = el('div', 'rmRow');
        row.appendChild(btn('Test', async () => {
          res.textContent = 'Testing...'; res.className = 'rmResult';
          showResult(res, await call('serverTest', existing && !tok.value ? { id: existing.id } : { url: host.value, token: tok.value }));
        }));
        b.appendChild(row);
      },
      buttons: [
        { label: 'Cancel' },
        { label: 'Save', primary: true, close: false, onClick: async () => {
          try {
            const cb = document.getElementById('rmClearTok');
            await call('serverSave', { id: existing && existing.id, name: name.value, url: host.value, token: tok.value || undefined, clearToken: !!(cb && cb.checked) });
            tok.value = '';
            m.close(); await refresh();
          } catch (e) { res.textContent = clean(e); res.className = 'rmResult bad'; }
        } },
      ],
    });
    return m;
  }

  /* ---------- LAN help + scan ---------- */
  function lanSection(b) {
    b.appendChild(el('p', 'rmBad', S.info.lanWarning));
    b.appendChild(el('p', 'rmHint', '1. On the server PC: make Ollama listen on the network.'));
    b.appendChild(codeBlock(S.info.lanCommands.ollamaHost, 'Command'));
    b.appendChild(el('p', 'rmHint', '2. Allow the port in the Windows firewall for the PRIVATE network profile only.'));
    b.appendChild(codeBlock(S.info.lanCommands.firewall, 'Command'));
    b.appendChild(el('p', 'rmHint', 'Linux server:'));
    b.appendChild(codeBlock(S.info.lanCommands.linux, 'Command'));
    b.appendChild(el('p', 'rmHint', '3. Add the server below. For access control, put a token proxy in front of it and use the "Hosted" type with a token.'));
    const row = el('div', 'rmRow');
    const out = el('div', 'rmScan');
    let scanBtn;
    const stop = btn('Stop', () => call('lanScanStop'), 'ghost'); stop.hidden = true;
    scanBtn = btn('Scan my network for Ollama', async () => {
      out.textContent = 'Scanning your local /24 network on port 11434 (only now, because you asked)...';
      stop.hidden = false;
      let r;
      try { r = await call('lanScan'); } finally { stop.hidden = true; }
      out.innerHTML = '';
      if (r.note) { out.textContent = r.note; return; }
      out.appendChild(el('div', 'rmHint', `Scanned ${r.prefixes.join(', ')}${r.stopped ? ' (stopped early)' : ''}. Found ${r.found.length}.`));
      for (const f of r.found) {
        const line = el('div', 'rmItem');
        line.appendChild(el('span', 'rmItemName', `${f.host}:${f.port}  (Ollama ${f.version})`));
        line.appendChild(btn('Add', () => serverForm('lan', null, { name: 'LAN ' + f.host, url: f.url }), 'ghost'));
        out.appendChild(line);
      }
    }, '', 'Probes each address on your /24 subnet for port 11434 with a short timeout');
    row.append(scanBtn, stop, btn('Add LAN server', () => serverForm('lan')));
    b.append(row, out);
  }

  /* ---------- notebooks ---------- */
  function notebookSection(b) {
    const nb = S.nb || {};
    const platform = el('select'); for (const [v, t] of [['colab', 'Google Colab'], ['kaggle', 'Kaggle']]) platform.appendChild(Object.assign(el('option', '', t), { value: v }));
    platform.value = nb.platform || 'colab';
    const model = inp(nb.model || 'qwen2.5-coder:7b', 'qwen2.5-coder:7b');
    const tunnel = el('select'); for (const [v, t] of [['cloudflared', 'cloudflared quick tunnel (no account)'], ['ngrok', 'ngrok (your own token, typed into the notebook)']]) tunnel.appendChild(Object.assign(el('option', '', t), { value: v }));
    tunnel.value = nb.tunnel || 'cloudflared';
    const tk = el('input'); tk.type = 'checkbox'; tk.checked = nb.requireToken !== false;
    const tkw = el('label', 'rmCheck'); tkw.append(tk, document.createTextNode(' Require an access token (strongly recommended; the tunnel URL is public)'));
    b.appendChild(el('p', 'rmHint', 'Faber does not log in to Google or Kaggle and does not drive their pages. It writes a notebook file; you upload and run it yourself. Check the platform\'s terms about tunnels/servers. Sessions are limited and the URL changes every time.'));
    b.append(field('Platform', platform), field('Model to serve', model), field('Tunnel', tunnel), tkw);
    const opts = () => ({ platform: platform.value, model: model.value.trim(), tunnel: tunnel.value, requireToken: tk.checked });
    b.appendChild(btn('Save notebook (.ipynb)...', async () => {
      await call('setPref', { nb: opts() });
      const p = await call('notebookSave', opts());
      if (p) { F.toast('Saved ' + p); F.sys('Notebook saved: ' + p + '. Upload it to ' + (platform.value === 'kaggle' ? 'Kaggle (New Notebook > File > Import; turn Internet and a GPU on)' : 'Colab (File > Upload notebook; Runtime > T4 GPU)') + ', run all cells, then paste the printed FABER_URL below.'); }
    }, 'primary'));
    b.appendChild(el('div', 'rmSpace'));
    const paste = el('textarea'); paste.rows = 3; paste.placeholder = 'Paste the URL here (or the whole FABER_URL=... / FABER_TOKEN=... output)'; paste.spellcheck = false;
    const res = el('div', 'rmResult');
    b.append(paste, res);
    b.appendChild(btn('Add and test', async () => {
      res.textContent = 'Testing...'; res.className = 'rmResult';
      const r = await call('pasteAdd', { text: paste.value });
      paste.value = '';
      showResult(res, r.test);
      await refresh();
    }));
  }

  /* ---------- SSH ---------- */
  function sshForm(existing) {
    const e = existing || {};
    const name = inp(e.name, 'e.g. GPU box'), user = inp(e.user, 'user'), host = inp(e.host, 'host or IP'), port = inp(e.port || 22, '22', 'number');
    const key = inp(e.keyFile, 'C:\\Users\\you\\.ssh\\id_ed25519');
    const dir = inp(e.remoteDir, '~/faber-work/myproject (optional)');
    const an = el('input'); an.type = 'checkbox'; an.checked = !!e.acceptNew;
    const anw = el('label', 'rmCheck'); anw.append(an, document.createTextNode(' Trust the host key on first connection (accept-new). Off = strict checking; connect once in "Open SSH terminal" to confirm it.'));
    const mf = inp(e.maxFileMB || 25, '', 'number'), mt = inp(e.maxTotalMB || 200, '', 'number');
    const res = el('div', 'rmResult');
    const m = F.modal({
      title: existing ? 'Edit SSH profile' : 'Add SSH profile',
      wide: false,
      body(b) {
        b.appendChild(el('p', 'rmHint', 'Key authentication only. Faber never stores or asks for an SSH password.'));
        b.append(field('Name', name), field('User', user), field('Host', host), field('Port', port));
        const kr = el('div', 'rmRow'); kr.appendChild(key); kr.appendChild(btn('Browse...', async () => { const p = await call('pickKey'); if (p) key.value = p; }, 'ghost'));
        const kw = field('Private key file (blank = default keys / ssh-agent)', kr);
        b.append(kw, field('Remote folder for "Run on remote"', dir, 'Must start with / or ~/'), anw, field('Skip files larger than (MB)', mf), field('Max total upload (MB)', mt), res);
      },
      buttons: [
        { label: 'Cancel' },
        { label: 'Save', primary: true, close: false, onClick: async () => {
          try {
            await call('sshSave', { id: e.id, name: name.value, user: user.value, host: host.value, port: port.value, keyFile: key.value, remoteDir: dir.value, acceptNew: an.checked, maxFileMB: mf.value, maxTotalMB: mt.value });
            m.close(); await refresh();
          } catch (er) { res.textContent = clean(er); res.className = 'rmResult bad'; }
        } },
      ],
    });
  }

  function forwardModal(p) {
    const lp = inp(11436, '', 'number'), rp = inp(11434, '', 'number');
    F.modal({
      title: `SSH port forward to ${p.user}@${p.host}`,
      body(b) {
        b.appendChild(el('p', 'rmHint', 'Runs: ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>. Ollama on the server stays private (listening only on its own localhost); nothing is exposed. The forward appears in the list below as a server; choose Use to switch to it.'));
        b.append(field('Local port', lp), field('Remote Ollama port', rp));
      },
      buttons: [{ label: 'Cancel' }, { label: 'Start forward', primary: true, onClick: async () => {
        try { await call('forwardStart', p.id, { localPort: lp.value, remotePort: rp.value }); F.toast('Forward started. Test it, then press Use.'); } catch (e) { F.error('Remote: ' + clean(e)); }
        await refresh();
      } }],
    });
  }

  // Run on remote: confirm the upload plan, stream output with Stop, then offer to fetch changed files.
  async function runModal(p) {
    const plan = await call('runPlan', p.id);
    const cmd = inp('', 'e.g. python train.py');
    const log = el('pre', 'rmLog'); log.hidden = true;
    const status = el('div', 'rmResult');
    let off = null, stopClicks = 0;
    const stopBtn = el('button', '', 'Stop'); stopBtn.hidden = true;
    const startBtn = el('button', 'primary', plan.empty ? 'Run (nothing to upload)' : 'Upload and run');
    const fetchBtn = el('button', '', 'Fetch changed files...'); fetchBtn.hidden = true;
    const skipUp = el('input'); skipUp.type = 'checkbox';
    const m = F.modal({
      title: `Run on ${p.user}@${p.host}`, wide: true,
      body(b) {
        b.appendChild(el('div', 'rmWarnBox', `The files below are copied to ${plan.target}:${plan.dir} and the command runs there. Secrets (.env, keys), .git and node_modules are never uploaded.`));
        const sum = `${plan.count} files, ${fmtMB(plan.bytes)} (limits ${plan.fileLimitMB} MB per file, ${plan.limitMB} MB total).`;
        b.appendChild(el('p', plan.tooLarge || plan.tooMany ? 'rmBad' : '', (plan.tooLarge ? 'Too large to upload: ' : plan.tooMany ? 'Too many files: ' : '') + sum));
        if (plan.sample.length) b.appendChild(el('p', 'rmHint', 'Includes: ' + plan.sample.join(', ') + (plan.count > plan.sample.length ? ', ...' : '')));
        if (plan.biggest.length) b.appendChild(el('p', 'rmHint', 'Largest: ' + plan.biggest.slice(0, 4).map((f) => `${f.rel} (${fmtMB(f.size)})`).join(', ')));
        const ex = Object.entries(plan.excludedDirs || {}).map(([k, v]) => `${k} (${v})`).join(', ');
        if (ex) b.appendChild(el('p', 'rmHint', 'Skipped folders: ' + ex));
        if (plan.skippedSecretCount) b.appendChild(el('p', 'rmHint', `Held back as secrets (${plan.skippedSecretCount}): ` + plan.skippedSecrets.map((s) => s.rel || s).join(', ')));
        if (plan.skippedLargeCount) b.appendChild(el('p', 'rmHint', `Skipped, over the file limit (${plan.skippedLargeCount}): ` + plan.skippedLarge.map((s) => s.rel || s).join(', ')));
        b.appendChild(field('Command to run on the server', cmd));
        const sk = el('label', 'rmCheck'); sk.append(skipUp, document.createTextNode(' Run again without uploading (files already there)')); b.appendChild(sk);
        const row = el('div', 'rmRow'); row.append(startBtn, stopBtn, fetchBtn); b.append(row, status, log);
      },
    });
    const append = (t) => { log.textContent += t; if (log.textContent.length > 200000) log.textContent = log.textContent.slice(-150000); log.scrollTop = log.scrollHeight; };
    off = F.on(NS + 'run', (ev) => {
      if (ev.type === 'out') append(ev.text);
      if (ev.type === 'end') {
        stopBtn.hidden = true; startBtn.disabled = false; fetchBtn.hidden = false;
        status.textContent = ev.ok ? `Finished (${ev.seconds || 0} s).` : ev.stopped ? 'Stopped.' : `Failed${ev.code != null ? ' (exit code ' + ev.code + ')' : ''}: ${ev.error || 'see output'}`;
        status.className = 'rmResult ' + (ev.ok ? 'ok' : 'bad');
      }
    });
    startBtn.onclick = async () => {
      try {
        if (!skipUp.checked && !plan.planId) throw new Error(plan.empty ? 'The folder has no uploadable files; tick "Run again without uploading".' : 'Not allowed to upload this folder (too large).');
        log.hidden = false; log.textContent = ''; status.textContent = 'Running...'; status.className = 'rmResult';
        startBtn.disabled = true; stopBtn.hidden = false; stopClicks = 0; stopBtn.textContent = 'Stop';
        await call('runStart', p.id, { planId: plan.planId, command: cmd.value, skipUpload: skipUp.checked });
      } catch (e) { startBtn.disabled = false; stopBtn.hidden = true; status.textContent = clean(e); status.className = 'rmResult bad'; }
    };
    stopBtn.onclick = async () => { stopClicks++; await call('runStop', stopClicks > 1); stopBtn.textContent = 'Force stop'; };
    fetchBtn.onclick = () => fetchModal(p);
    void m; void off;
  }

  async function fetchModal(p) {
    const plan = await call('fetchPlan', p.id);
    const checks = [];
    const res = el('div', 'rmResult');
    F.modal({
      title: 'Fetch changed files', wide: true,
      body(b) {
        b.appendChild(el('p', 'rmHint', `Files that changed on the server since the upload (${plan.dir}). Existing local files that differ are backed up first in .faber-backup. Tick what to bring back.`));
        if (!plan.files.length) b.appendChild(el('p', '', 'Nothing changed.'));
        const list = el('div', 'rmFetch');
        for (const f of plan.files) {
          const row = el('label', 'rmCheck');
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = f.safe && !f.tooBig && !f.blocked && !f.exists;
          cb.disabled = !f.safe || f.tooBig || f.blocked;
          checks.push([f.rel, cb]);
          row.append(cb, document.createTextNode(` ${f.rel}  (${fmtMB(f.size)})${f.exists ? '  - overwrites local file' : '  - new'}${!f.safe ? '  - unsafe name, skipped' : f.tooBig ? '  - too big' : f.blocked ? '  - blocked' : ''}`));
          list.appendChild(row);
        }
        b.append(list, res);
        if (plan.truncated) b.appendChild(el('p', 'rmHint', 'List truncated to 2000 files.'));
      },
      buttons: [{ label: 'Cancel' }, { label: 'Fetch selected', primary: true, close: false, onClick: async (api) => {
        try {
          const sel = checks.filter(([, cb]) => cb.checked).map(([r]) => r);
          const r = await call('fetchApply', p.id, plan.planId, sel);
          F.refreshTree();
          F.sys(`Fetched ${r.written.length} file(s) from the server${r.backedUp.length ? '; ' + r.backedUp.length + ' backed up in ' + r.backupDir : ''}.`);
          api.close();
        } catch (e) { res.textContent = clean(e); res.className = 'rmResult bad'; }
      } }],
    });
  }

  /* ---------- panel ---------- */
  function row(title, sub, buttons) {
    const r = el('div', 'rmItem');
    const t = el('div', 'rmItemMain');
    t.appendChild(el('div', 'rmItemName', title));
    if (sub) t.appendChild(el('div', 'rmHint', sub));
    r.appendChild(t);
    const bs = el('div', 'rmBtns'); for (const b of buttons) bs.appendChild(b);
    r.appendChild(bs);
    return r;
  }

  function paintPanel() {
    if (!panel || !S) return;
    const keepOpen = [...panel.querySelectorAll('details')].map((d) => d.open);
    const top = panel.scrollTop;
    panel.innerHTML = '';
    const head = el('div', 'rmHead');
    if (S.active) {
      head.className = 'rmHead on';
      head.appendChild(el('div', 'rmHeadTitle', 'REMOTE ACTIVE: ' + S.active.name));
      head.appendChild(el('div', 'rmHint', `Prompts, file contents and replies are sent to ${S.active.host}${S.active.via ? ' via ' + S.active.via : ''}.`));
      head.appendChild(btn('Back to local', goLocal, 'primary'));
    } else {
      head.appendChild(el('div', 'rmHeadTitle', 'Local only (offline)'));
      head.appendChild(el('div', 'rmHint', 'Nothing leaves this PC. Remote servers are optional and need your confirmation each time.'));
    }
    panel.appendChild(head);

    const sbody = el('div', 'rmBlock');
    sbody.appendChild(el('div', 'rmBlockTitle', 'Servers (online)'));
    if (!S.servers.length) sbody.appendChild(el('div', 'rmHint', 'No servers yet. Add one below or use the setup guides.'));
    for (const s of S.servers) {
      const out = el('div', 'rmResult');
      const isActive = S.active && S.active.id === s.id;
      const kind = s.scope === 'public' ? 'public' : s.scope === 'ssh' ? 'ssh' : 'lan';
      const bs = [
        btn('Test', async () => { out.textContent = 'Testing...'; out.className = 'rmResult'; showResult(out, await call('serverTest', { id: s.id })); }, 'ghost'),
        isActive ? btn('Back to local', goLocal) : btn('Use...', () => useServer(s.id), 'primary'),
      ];
      if (s.id !== 'fwd') {
        bs.push(btn('Edit', () => serverForm(kind === 'public' ? 'hosted' : 'lan', s), 'ghost'));
        bs.push(btn('Delete', async () => { await call('serverDelete', s.id); await refresh(); }, 'ghost'));
      }
      const r = row(s.name + (isActive ? '  (in use)' : ''), `${s.host}  |  ${s.https ? 'https' : 'http'}  |  ${scopeText[s.scope] || s.scope}${s.hasToken ? '  |  token saved' : ''}`, bs);
      sbody.append(r, out);
    }
    const addRow = el('div', 'rmRow');
    addRow.append(btn('Add LAN server', () => serverForm('lan')), btn('Add hosted server', () => serverForm('hosted')));
    sbody.appendChild(addRow);
    panel.appendChild(sbody);

    const secs = [
      section('LAN / home server guide', false, lanSection),
      section('Google Colab / Kaggle notebook', false, notebookSection),
      section('SSH', false, (b) => {
        b.appendChild(el('p', 'rmHint', 'Key authentication only. "Open SSH terminal" lets you confirm the host key and run anything by hand. A port forward reaches a remote Ollama safely without exposing it.'));
        if (!S.ssh.length) b.appendChild(el('div', 'rmHint', 'No SSH profiles yet.'));
        for (const p of S.ssh) {
          const out = el('div', 'rmResult');
          b.appendChild(row(p.name, `${p.user}@${p.host}:${p.port || 22}`, [
            btn('Terminal', async () => { const r = await call('sshTerminal', p.id); F.runInTerminal(r.line); }, 'ghost'),
            btn('Test', async () => { out.textContent = 'Testing...'; out.className = 'rmResult'; const r = await call('sshTest', p.id); out.textContent = r.ok ? 'SSH works (key login OK).' : r.error; out.className = 'rmResult ' + (r.ok ? 'ok' : 'bad'); }, 'ghost'),
            btn('Forward', () => forwardModal(p), 'ghost'),
            btn('Run...', () => runModal(p), 'ghost'),
            btn('Fetch', () => fetchModal(p), 'ghost'),
            btn('Edit', () => sshForm(p), 'ghost'),
            btn('Delete', async () => { await call('sshDelete', p.id); await refresh(); }, 'ghost'),
          ]));
          b.appendChild(out);
        }
        if (S.forward) b.appendChild(row(`Forward running: 127.0.0.1:${S.forward.localPort} to ${S.forward.label}:${S.forward.remotePort}`, '', [btn('Stop forward', async () => { await call('forwardStop'); await refresh(); })]));
        b.appendChild(btn('Add SSH profile', () => sshForm()));
      }),
      section('Tips for bigger models remotely', false, (b) => { const ul = el('ul', 'rmList'); for (const t of S.info.tips) ul.appendChild(el('li', '', t)); b.appendChild(ul); }),
      section('Options', false, (b) => {
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = S.offerEnabled;
        cb.onchange = () => call('setPref', { offerReconnect: cb.checked });
        const w = el('label', 'rmCheck'); w.append(cb, document.createTextNode(' Offer to reconnect to my last server when Faber starts (always asks first)'));
        b.appendChild(w);
        const sp = inp(S.sshPath, 'Path to ssh.exe (blank = automatic)');
        sp.onchange = async () => { try { await call('setPref', { sshPath: sp.value }); } catch (e) { F.error(clean(e)); } };
        b.appendChild(field('ssh program', sp));
        b.appendChild(el('p', 'rmHint', S.canEncrypt ? 'Tokens are stored encrypted (Windows secure storage).' : 'Secure storage is unavailable: tokens cannot be saved.'));
        b.appendChild(btn('Forget all saved tokens', async () => { await call('forgetTokens'); F.toast('Saved tokens removed'); await refresh(); }));
      }),
    ];
    secs.forEach((d, i) => { if (keepOpen[i]) d.open = true; panel.appendChild(d); });
    panel.scrollTop = top;
  }

  /* ---------- registration ---------- */
  F.addSideTab({
    id: 'remote', title: 'Remote',
    render(el0) { panel = el0; panel.classList.add('rmPanel'); panel.textContent = 'Loading...'; refresh(); },
    onShow() { refresh(); },
  });

  const openTab = () => F.showSideTab('remote');
  F.addMenuItem && F.addMenuItem('Tools', { id: 'remote.open', label: 'Remote servers...', action: openTab, separatorBefore: true });
  F.addMenuItem && F.addMenuItem('Tools', { id: 'remote.local', label: 'Back to local model', action: () => goLocal().catch((e) => F.error(clean(e))), enabled: () => !!(S && S.active) });
  F.addMenuItem && F.addMenuItem('Tools', { id: 'remote.nb', label: 'Colab / Kaggle notebook...', action: () => { openTab(); } });

  F.addCommand('local', '', 'Switch back to the Ollama on this PC', async () => { await goLocal(); });
  F.addCommand('remote', '[server name]', 'Open the Remote tab, or switch to a saved server (asks for confirmation)', async (arg) => {
    const q = String(arg || '').trim().toLowerCase();
    if (!q) { openTab(); return; }
    if (!S) await refresh();
    const hit = S.servers.find((s) => s.name.toLowerCase() === q) || S.servers.find((s) => s.name.toLowerCase().includes(q));
    if (!hit) { F.error('No saved server matches "' + q + '". Open the Remote tab to add one.'); openTab(); return; }
    await useServer(hit.id);
  });

  F.addSettingsSection({
    id: 'remote', title: 'Remote (online)',
    render(root) {
      root.appendChild(el('p', 'rmBad', 'Online features. Faber is offline by default. Using a remote server sends prompts, file contents the AI reads and replies to that server.'));
      root.appendChild(el('p', 'rmHint', 'Everything is opt-in and needs a confirmation each time. Faber always starts on the local model.'));
      root.appendChild(btn('Open the Remote tab', () => { openTab(); }, 'primary'));
      root.appendChild(el('div', 'rmSpace'));
      root.appendChild(btn('Back to local model', () => goLocal(), ''));
    },
  });

  F.onReady(async () => {
    await refresh();
    if (S && S.offer) F.toast(`Last remote server: ${S.offer.name}. Use "Reconnect" next to the model chip if you want it (asks first).`, 8000);
  });
});
