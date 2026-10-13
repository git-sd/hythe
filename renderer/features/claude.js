/* feature: claude (renderer). Optional ONLINE model provider: Claude through the Anthropic API.
   Off by default and off at every start. The user's own API key is sent to the main process and never comes back.
   Provides F.claudeModels() for the model picker, a Settings section, /claude, and a persistent indicator. */
Faber.register('claude', (F) => {
  const { el } = F;
  const NS = 'feat:claude:';
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a);
  let S = { enabled: false, hasKey: false, keyTail: '', canEncrypt: true, models: [] };

  F.claudeModels = () => (S.enabled ? S.models.map((m) => ({ ...m, online: true, size: 0, caps: ['tools', 'thinking'] })) : []);

  F.modelLabel = (name) => { const m = S.models.find((x) => x.name === name); return m ? m.label + ' (online)' : name; };

  async function refresh() { try { S = await call('state'); } catch { return; } paint(); }
  F.on(NS + 'state', (s) => { S = s; paint(); });

  /* ---------- persistent indicator in the bottom bar ---------- */
  let ind = null;
  const modelLabel = (name) => { const m = S.models.find((x) => x.name === name); return m ? m.label : name; };
  function paint() {
    paintIndicator();
    for (const f of panels) f();
  }
  function paintIndicator() {
    const bar = document.getElementById('bar');
    if (!bar) return;
    if (!ind) { ind = el('span', 'clInd'); ind.hidden = true; const sp = bar.querySelector('.spacer'); bar.insertBefore(ind, sp ? sp.nextSibling : null); }
    ind.innerHTML = '';
    if (!S.enabled) { ind.hidden = true; return; }
    const cur = F.chat && F.chat.activeInfo && F.chat.activeInfo();
    const using = cur && String(cur.model).startsWith('claude:');
    ind.hidden = false;
    ind.className = 'clInd ' + (using ? 'use' : 'idle');
    const t = el('button', 'clTxt', using ? `ONLINE: ${modelLabel(cur.model)}` : 'Claude is on (not used here)');
    t.title = using ? 'Prompts, file contents the AI reads and replies are being sent to Anthropic over the internet. Click for settings.' : 'The online provider is turned on, but this agent uses a local model. Click for settings.';
    t.onclick = () => F.openSettings('claude');
    const off = el('button', '', 'Turn off');
    off.title = 'Stop all online use until you turn it on again';
    off.onclick = () => turnOff();
    ind.append(t, off);
  }
  F.onEvent('agents', paintIndicator);
  F.onReady(refresh);

  async function turnOff() {
    try { await call('setEnabled', false); F.toast('Claude is off. Nothing is sent online now.'); } catch (e) { F.error(clean(e)); }
    refresh();
  }
  function consent() {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      F.modal({
        title: 'Send your work to Claude (online)?',
        body(b) {
          b.appendChild(el('div', 'clWarn', 'Faber is offline by default. If you turn this on, anything you do with a Claude model leaves this PC.'));
          const ul = el('ul', 'clList');
          for (const t of ['Your prompts and the conversation history', 'Contents of files and command output the assistant reads' + (F.folder() ? ' from ' + F.folder() : ''), 'The assistant\'s replies and tool results']) ul.appendChild(el('li', '', t));
          b.appendChild(ul);
          b.appendChild(el('p', 'clHint', 'They go to Anthropic with your own API key, and usage is billed to your Anthropic account. Local models stay offline. Faber turns this off every time it starts, and a persistent ONLINE indicator shows while it is on.'));
        },
        buttons: [{ label: 'Cancel', onClick: () => fin(false) }, { label: 'Turn on', primary: true, onClick: () => fin(true) }],
      });
    });
  }

  /* ---------- settings section ---------- */
  const panels = [];
  function render(root) {
    const box = el('div', 'clBox');
    root.appendChild(box);
    const draw = () => {
      if (!box.isConnected) return;
      box.innerHTML = '';
      box.appendChild(el('div', 'clWarn', 'Online feature. Faber is offline by default. Claude models run on Anthropic\'s servers, so prompts and file contents the AI reads are sent over the internet. Optional, never the default.'));
      // 1. key
      box.appendChild(el('b', '', 'Your API key'));
      if (!S.canEncrypt) box.appendChild(el('div', 'clBad', 'Secure storage is not available on this system, so Faber will not save a key (it is never stored in plain text).'));
      if (S.hasKey) {
        box.appendChild(el('div', 'clOk', `Key saved, ending in ${S.keyTail}. Stored encrypted with your Windows account and never shown again.`));
        const r = el('div', 'clRow');
        const test = el('button', '', 'Test key');
        const msg = el('span', 'clHint');
        test.onclick = async () => { test.disabled = true; msg.textContent = 'Checking (goes online)...'; msg.className = 'clHint'; try { const t = await call('test'); msg.textContent = t.ok ? 'The key works.' : t.error; msg.className = t.ok ? 'clOk' : 'clBad'; } catch (e) { msg.textContent = clean(e); msg.className = 'clBad'; } test.disabled = false; };
        const rm = el('button', '', 'Remove key');
        rm.onclick = async () => { try { await call('clearKey'); } catch (e) { F.error(clean(e)); } refresh(); };
        r.append(test, rm, msg);
        box.appendChild(r);
      } else {
        const r = el('div', 'clRow');
        const inp = el('input'); inp.type = 'password'; inp.placeholder = 'sk-ant-...'; inp.autocomplete = 'off'; inp.spellcheck = false;
        const save = el('button', 'primary', 'Save key');
        const msg = el('div', 'clBad');
        const go = async () => { try { await call('setKey', inp.value); inp.value = ''; } catch (e) { msg.textContent = clean(e); return; } refresh(); };
        save.onclick = go;
        inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
        r.append(inp, save);
        box.append(r, msg, el('div', 'clHint', 'Create your own key at console.anthropic.com. Faber never sees any key but the one you type here.'));
      }
      // 2. switch
      box.appendChild(el('b', '', 'Use Claude'));
      const sw = el('div', 'clRow');
      if (S.enabled) {
        sw.append(el('span', 'clOk', 'ON. Pick a Claude model from the model chip or /model.'), Object.assign(el('button', '', 'Turn off'), { onclick: () => turnOff() }));
      } else {
        const on = el('button', 'primary', 'Turn on...');
        on.disabled = !S.hasKey;
        on.title = S.hasKey ? '' : 'Save your API key first';
        on.onclick = async () => { if (!(await consent())) return; try { await call('setEnabled', true); F.toast('Claude is on. Choose a Claude model to use it.'); } catch (e) { F.error(clean(e)); } refresh(); };
        sw.append(on, el('span', 'clHint', 'Off now. It also turns off every time Faber starts.'));
      }
      box.appendChild(sw);
      // 3. models
      box.appendChild(el('b', '', 'Models'));
      for (const m of S.models) {
        const r = el('div', 'clRow');
        r.append(el('span', '', `${m.label}  (${m.price} per million tokens in / out)`));
        const use = el('button', '', 'Use in this agent');
        use.disabled = !S.enabled;
        use.onclick = async () => { const cur = F.chat.activeInfo(); if (cur) { try { await F.chat.update(cur.id, { model: m.name }); F.toast(`${cur.name} now uses ${m.label}`); } catch (e) { F.error(clean(e)); } } };
        r.appendChild(use);
        box.appendChild(r);
      }
      box.appendChild(el('div', 'clHint', 'Prices are the public list prices and may change. Effort (low, medium, high) maps to Claude\'s own thinking effort.'));
    };
    panels.push(draw);
    draw();
  }
  F.addSettingsSection({ id: 'claude', title: 'Claude (online)', render });

  F.addCommand('claude', 'on|off|key', 'Claude (online) settings', async (a) => {
    a = (a || '').trim().toLowerCase();
    if (a === 'off') return turnOff();
    if (a === 'on') {
      if (!S.hasKey) { F.sys('Save your API key first (Settings > Claude (online)).'); return F.openSettings('claude'); }
      if (!(await consent())) return;
      try { await call('setEnabled', true); F.sys('Claude is on. Choose a Claude model with /model.'); } catch (e) { F.error(clean(e)); }
      return refresh();
    }
    F.openSettings('claude');
  });
  F.addMenuItem('Tools', { id: 'claude.settings', label: 'Claude (online)...', action: () => F.openSettings('claude') });
});
