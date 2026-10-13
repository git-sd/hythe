/* Find in files (sidebar "Search" tab). Loaded after menubar.js, before features. */
(() => {
  let input, incl, results, status, caseBtn, regexBtn;
  let seq = 0;
  const opts = { caseSensitive: false, regex: false };

  function highlightLine(text, col, len) {
    const frag = document.createDocumentFragment();
    const start = Math.max(0, col - 24);
    const pre = (start > 0 ? '…' : '') + text.slice(start, col).trimStart();
    frag.append(pre);
    const mark = document.createElement('mark');
    mark.textContent = text.slice(col, col + len);
    frag.append(mark, text.slice(col + len, col + len + 120));
    return frag;
  }

  async function run() {
    const q = input.value;
    const my = ++seq;
    results.innerHTML = '';
    if (!q) { status.textContent = ''; return; }
    if (!Faber.settings().workspace) { status.textContent = 'Open a folder to search.'; return; }
    status.textContent = 'Searching…';
    let r;
    try { r = await api.searchFiles({ query: q, include: incl.value, ...opts }); } catch (e) {
      if (my === seq) status.textContent = clean(e);
      return;
    }
    if (my !== seq) return;                                   // a newer search started
    status.textContent = r.total
      ? `${r.total}${r.truncated ? '+' : ''} result${r.total === 1 ? '' : 's'} in ${r.files.length} file${r.files.length === 1 ? '' : 's'}${r.truncated ? ' (showing the first 500)' : ''}`
      : 'No results.';
    for (const f of r.files) {
      const box = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'sfile';
      head.innerHTML = '<span class="sname"></span><span class="scount"></span>';
      head.querySelector('.sname').textContent = f.rel;
      head.querySelector('.scount').textContent = f.matches.length;
      head.title = f.path;
      const list = document.createElement('div');
      head.onclick = () => { list.hidden = !list.hidden; };
      for (const m of f.matches) {
        const row = document.createElement('div');
        row.className = 'shit';
        row.append(highlightLine(m.text, m.col, m.len));
        row.title = `${f.rel}:${m.line}`;
        row.onclick = () => openFileAt(f.path, m.line, m.col, m.len);
        list.appendChild(row);
      }
      box.append(head, list);
      results.appendChild(box);
    }
  }

  function toggle(btn, key) {
    opts[key] = !opts[key];
    btn.classList.toggle('on', opts[key]);
    run();
  }

  function render(pane) {
    pane.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'sform';
    input = document.createElement('input');
    input.placeholder = 'Search in folder';
    input.spellcheck = false;
    const row = document.createElement('div');
    row.className = 'srow';
    caseBtn = document.createElement('button'); caseBtn.textContent = 'Aa'; caseBtn.title = 'Match case';
    regexBtn = document.createElement('button'); regexBtn.textContent = '.*'; regexBtn.title = 'Regular expression';
    caseBtn.className = regexBtn.className = 'ghost tog';
    caseBtn.onclick = () => toggle(caseBtn, 'caseSensitive');
    regexBtn.onclick = () => toggle(regexBtn, 'regex');
    incl = document.createElement('input');
    incl.placeholder = 'File types, e.g. js, py';
    incl.spellcheck = false;
    row.append(caseBtn, regexBtn, incl);
    top.append(input, row);
    status = document.createElement('div');
    status.className = 'sstatus muted small';
    results = document.createElement('div');
    results.className = 'sresults';
    pane.append(top, status, results);
    let timer;
    const later = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
    input.addEventListener('input', later);
    incl.addEventListener('input', later);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  }

  Faber.addSideTab({
    id: 'search', title: 'Search (Ctrl+Shift+F)', render,
    onShow: () => { if (input) { input.focus(); input.select(); } },
  });
  Faber.addMenuItem('Edit', { id: 'edit.findInFiles', separatorBefore: true, label: 'Find in Files', shortcut: 'Ctrl+Shift+F', keys: 'Ctrl+Shift+F', action: () => { Faber.showSideTab('search'); setTimeout(() => { input.focus(); input.select(); }, 0); } });
  Faber.onEvent('folder', () => { if (results) { results.innerHTML = ''; status.textContent = ''; } });
})();
