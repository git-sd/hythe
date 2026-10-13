/* feature: agents (renderer). Tabs above the chat, the Agents sidebar tab, /agent commands, the Agents menu and settings.
   The chat views and event rendering live in app.js and are reached through Faber.chat. */
Faber.register('agents', (F) => {
  const chat = F.chat;
  const DEFAULTS = { maxConcurrent: 2, persist: true, subSteps: 12, subTimeoutSec: 600 };
  const STATUS_TEXT = { idle: 'idle', working: 'working', approval: 'waiting for approval', queued: 'queued', error: 'error' };
  const cfg = () => ({ ...DEFAULTS, ...F.featureSettings('agents') });
  const fail = (e) => F.error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  const run = (p) => Promise.resolve(p).catch(fail);

  /* ---------- tab strip above the chat ---------- */
  const bar = F.el('div', 'agentTabs');
  bar.id = 'agentTabs';
  const chatEl = document.getElementById('chat');
  chatEl.parentNode.insertBefore(bar, chatEl);
  bar.hidden = true;

  function startRename(tab, s) {
    const nm = tab.querySelector('.nm');
    const input = F.el('input', 'renameBox');
    input.value = s.name;
    nm.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== s.name) run(chat.rename(s.id, v)); else paintTabs();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation();
  }

  function paintTabs() {
    const list = chat.sessions();
    bar.hidden = !list.length;
    bar.innerHTML = '';
    for (const s of list) {
      const tab = F.el('div', 'atab' + (s.id === chat.active() ? ' on' : ''));
      tab.title = `${s.name}: ${STATUS_TEXT[s.status] || s.status}\n${s.model}`;
      tab.dataset.id = s.id;
      tab.append(F.el('i', 'adot ' + s.status), F.el('span', 'nm', s.name));
      const x = F.el('button', 'ax', '\u00d7');
      x.title = 'Close agent';
      x.onclick = (e) => { e.stopPropagation(); run(chat.close(s.id)); };
      tab.appendChild(x);
      tab.onclick = () => chat.switchTo(s.id);
      tab.ondblclick = () => startRename(tab, s);
      tab.onauxclick = (e) => { if (e.button === 1) run(chat.close(s.id)); };
      bar.appendChild(tab);
    }
    const plus = F.el('button', 'aplus', '+');
    plus.title = 'New agent';
    plus.onclick = () => run(chat.create());
    bar.appendChild(plus);
    const on = bar.querySelector('.atab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ---------- sidebar tab ---------- */
  let listEl = null;
  function paintList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    for (const s of chat.sessions()) {
      const row = F.el('div', 'arow' + (s.id === chat.active() ? ' on' : ''));
      row.dataset.id = s.id;
      const top = F.el('div', 'atop');
      top.append(F.el('i', 'adot ' + s.status), F.el('span', 'nm', s.name), F.el('span', 'amodel', s.model));
      const sub = F.el('div', 'asub');
      sub.append(F.el('span', 'ast ' + s.status, STATUS_TEXT[s.status] || s.status), F.el('span', 'apre', s.preview || ''));
      const btns = F.el('div', 'abtns');
      if (s.status !== 'idle' && s.status !== 'error') {
        const stop = F.el('button', 'ghost', 'Stop');
        stop.onclick = (e) => { e.stopPropagation(); run(chat.stop(s.id)); };
        btns.appendChild(stop);
      }
      const close = F.el('button', 'ghost', 'Close');
      close.onclick = (e) => { e.stopPropagation(); run(chat.close(s.id)); };
      btns.appendChild(close);
      row.append(top, sub, btns);
      row.onclick = () => chat.switchTo(s.id);
      listEl.appendChild(row);
    }
  }

  function settingsForm(el, compact) {
    const c = cfg();
    const save = async (patch) => { F.saveFeatureSettings('agents', patch); await run(F.call('feat:agents:poke')); };
    const num = (label, key, min, max, hint) => {
      const row = F.el('label', 'aset');
      row.append(F.el('span', '', label));
      const inp = F.el('input');
      inp.type = 'number'; inp.min = min; inp.max = max; inp.value = c[key];
      inp.onchange = () => { const n = Math.max(min, Math.min(max, parseInt(inp.value, 10) || DEFAULTS[key])); inp.value = n; save({ [key]: n }); };
      row.appendChild(inp);
      el.appendChild(row);
      if (hint) el.appendChild(F.el('div', 'ahint', hint));
    };
    num('Agents running at once', 'maxConcurrent', 1, 8, 'One local Ollama has limited memory (see OLLAMA_NUM_PARALLEL). Extra runs wait as "queued".');
    if (!compact) {
      const row = F.el('label', 'aset');
      const chk = F.el('input');
      chk.type = 'checkbox'; chk.checked = c.persist;
      chk.onchange = () => save({ persist: chk.checked });
      row.append(chk, F.el('span', '', 'Keep conversations on disk between restarts'));
      el.appendChild(row);
      num('Sub-agent step limit', 'subSteps', 1, 40);
      num('Sub-agent timeout (seconds)', 'subTimeoutSec', 10, 7200);
    }
    const del = F.el('button', '', 'Delete history');
    del.title = 'Erase every conversation (agents stay, empty)';
    del.onclick = confirmDelete;
    el.appendChild(del);
  }

  function confirmDelete() {
    F.modal({
      title: 'Delete history',
      body: (el) => { el.textContent = 'Erase the conversation and saved transcript of every agent? This cannot be undone.'; },
      buttons: [{ label: 'Cancel' }, { label: 'Delete', primary: true, onClick: () => run(chat.deleteHistory()) }],
    });
  }

  F.addSideTab({
    id: 'agents', title: 'Agents',
    render(el) {
      const head = F.el('div', 'agHead');
      const nw = F.el('button', 'primary', 'New agent');
      nw.onclick = () => run(chat.create());
      const stopAll = F.el('button', '', 'Stop all');
      stopAll.onclick = () => run(chat.stopAll());
      head.append(nw, stopAll);
      listEl = F.el('div', 'agList');
      const foot = F.el('div', 'agFoot');
      settingsForm(foot, true);
      el.append(head, listEl, foot);
      paintList();
    },
  });

  F.addSettingsSection({ id: 'agents', title: 'Agents', render: (el) => settingsForm(el, false) });

  /* ---------- notifications for background agents ---------- */
  const last = {};
  function notify() {
    for (const s of chat.sessions()) {
      const was = last[s.id];
      last[s.id] = s.status;
      if (!was || was === s.status || s.id === chat.active()) continue;
      if (s.status === 'approval') F.toast(`${s.name} needs your approval`);
      else if (was === 'working' && s.status === 'idle') F.toast(`${s.name} finished`);
      else if (s.status === 'error') F.toast(`${s.name} hit an error`);
    }
  }
  const repaint = () => {
    paintTabs(); paintList(); notify();
    if (F.setBadge) F.setBadge('agents', chat.sessions().filter((s) => s.status !== 'idle' && s.status !== 'error').length);
  };
  F.onEvent('agents', repaint);
  F.onReady(repaint);

  /* ---------- slash commands ---------- */
  F.addCommand('agents', '', 'List agents', () => {
    const act = chat.active();
    F.sys(chat.sessions().map((s, i) => `${s.id === act ? '*' : ' '} ${i + 1}. ${s.name}  [${s.model}]  ${STATUS_TEXT[s.status] || s.status}`).join('\n'));
  });
  const USAGE = 'Usage: /agent new [name] | rename <name> | close | model [name] | switch <n|name> | stop | history delete';
  F.addCommand('agent', 'new|rename|close|model|switch', 'Manage agents (chat sessions)', async (a) => {
    const sub = (a.split(/\s+/)[0] || '').toLowerCase();
    const rest = a.slice(sub.length).trim();
    const cur = chat.activeInfo();
    switch (sub) {
      case 'new': { const i = await chat.create(rest); F.sys(`Created ${i.name}.`); break; }
      case 'rename': if (!rest) return F.sys(USAGE); await chat.rename(cur.id, rest); break;
      case 'close': await chat.close(cur.id); break;
      case 'stop': await chat.stop(cur.id); break;
      case 'model':
        if (rest) { await chat.update(cur.id, { model: rest }); F.sys(`Model \u2192 ${rest}`); } else chat.pickModel(cur.id);
        break;
      case 'switch': {
        const list = chat.sessions();
        const n = parseInt(rest, 10);
        const t = n >= 1 && n <= list.length ? list[n - 1] : list.find((s) => s.name.toLowerCase() === rest.toLowerCase());
        if (!t) return F.sys('No such agent. Type /agents to list them.');
        chat.switchTo(t.id);
        break;
      }
      case 'history': if (rest === 'delete') confirmDelete(); else F.sys(USAGE); break;
      default: F.sys(USAGE);
    }
  });

  /* ---------- Agents menu ---------- */
  const M = 'Agents';
  F.addMenuItem(M, { id: 'agents.new', label: 'New Agent', shortcut: 'Ctrl+Shift+N', keys: 'Ctrl+Shift+N', action: () => run(chat.create()) });
  F.addMenuItem(M, { id: 'agents.rename', label: 'Rename Agent\u2026', action: () => { const tab = bar.querySelector('.atab.on'); const s = chat.activeInfo(); if (tab && s) startRename(tab, s); } });
  F.addMenuItem(M, { id: 'agents.close', label: 'Close Agent', action: () => { const s = chat.activeInfo(); if (s) run(chat.close(s.id)); } });
  F.addMenuItem(M, {
    id: 'agents.switch', label: 'Switch To', separatorBefore: true,
    submenu: () => chat.sessions().map((s, i) => ({ label: `${i + 1}. ${s.name}  (${STATUS_TEXT[s.status] || s.status})`, checked: () => s.id === chat.active(), action: () => chat.switchTo(s.id) })),
  });
  F.addMenuItem(M, { id: 'agents.stopAll', label: 'Stop All', separatorBefore: true, action: () => run(chat.stopAll()) });
  F.addMenuItem(M, { id: 'agents.settings', label: 'Delegate Settings\u2026', action: () => F.openSettings('agents') });
});
