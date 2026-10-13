/* Real terminals: a PTY per tab rendered with xterm.js, so interactive programs work
   (claude, python, vim, ssh, ...). Loaded after app.js (shares its globals). */
const terms = {};      // id -> {id, n, term, fit, pane, exited}
const termBuffer = {}; // output that arrived before its tab finished registering
let activeTerm = null;
let termCount = 0;

const TERM_THEME = {
  background: '#0e0e10', foreground: '#e6e6ea', cursor: '#8b5cf6', cursorAccent: '#0e0e10',
  selectionBackground: '#4c3a86',
  black: '#1c1c20', red: '#f87171', green: '#4ade80', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#b69cff', cyan: '#22d3ee', white: '#e6e6ea',
  brightBlack: '#6b6b78', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d0bfff', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

// Options changed by ui-settings (font size, cursor, scrollback, colours); applied to open and new terminals.
const termConfig = { fontSize: 13, cursorStyle: 'block', scrollback: 5000, theme: TERM_THEME };
function applyTermConfig(patch) {
  Object.assign(termConfig, patch);
  for (const t of Object.values(terms)) {
    const o = t.term.options;
    o.fontSize = termConfig.fontSize; o.cursorStyle = termConfig.cursorStyle; o.scrollback = termConfig.scrollback; o.theme = termConfig.theme;
    fitTerm(t);
  }
}

function fitTerm(t) {
  if (!t || $('term').hidden || t.pane.hidden) return;
  try { t.fit.fit(); } catch { /* not laid out yet */ }
}

async function newTerminal() {
  setTermVisible(true);
  const pane = document.createElement('div');
  pane.className = 'termPane';
  $('termHost').appendChild(pane);
  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: termConfig.fontSize, cursorBlink: true, cursorStyle: termConfig.cursorStyle,
    scrollback: termConfig.scrollback, theme: termConfig.theme, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  activateTermPane(null, pane);
  try { fit.fit(); } catch { /* ignore */ }

  let id;
  try { id = await api.termOpen(term.cols, term.rows); } catch (e) {
    pane.remove();
    term.dispose();
    return add('error', clean(e));
  }
  const t = { id, n: ++termCount, term, fit, pane, exited: false };
  terms[id] = t;
  if (termBuffer[id]) { termBuffer[id].forEach((d) => term.write(d)); delete termBuffer[id]; }

  term.onData((d) => { if (t.exited) closeTerminal(id); else api.termInput(id, d); });
  term.onResize(({ cols, rows }) => { if (!t.exited) api.termResize(id, cols, rows); });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.key === '`') return false;                  // app shortcut: toggle terminal
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && (term.hasSelection() || e.shiftKey)) {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      return false;                                                // copy instead of sending Ctrl+C
    }
    return true;                                                   // Ctrl+V pastes via the browser paste event
  });
  selectTerminal(id);
}

function selectTerminal(id) {
  const t = terms[id];
  if (!t) return;
  activeTerm = t;
  activateTermPane(t);
  paintTermTabs();
  fitTerm(t);
  t.term.focus();
}

function activateTermPane(t, pane) {
  document.querySelectorAll('#termHost .termPane').forEach((p) => { p.hidden = !(pane ? p === pane : p === t.pane); });
}

function paintTermTabs() {
  const el = $('termTabs');
  el.innerHTML = '';
  for (const t of Object.values(terms)) {
    const d = document.createElement('div');
    d.className = 'ttab' + (t === activeTerm ? ' on' : '');
    d.innerHTML = '<span class="nm"></span><span class="x"><svg viewBox="0 0 16 16"><path d="M4.1 3L8 6.9 11.9 3 13 4.1 9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z"/></svg></span>';
    d.querySelector('.nm').textContent = (t.exited ? 'Exited ' : 'Terminal ') + t.n;
    d.onclick = () => selectTerminal(t.id);
    d.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTerminal(t.id); };
    el.appendChild(d);
  }
}

function closeTerminal(id) {
  const t = terms[id];
  if (!t) return;
  if (!t.exited) api.termClose(id);
  t.term.dispose();
  t.pane.remove();
  delete terms[id];
  const rest = Object.values(terms);
  if (activeTerm === t) activeTerm = rest[rest.length - 1] || null;
  if (activeTerm) selectTerminal(activeTerm.id);
  else { paintTermTabs(); setTermVisible(false); }
}

// Pure show/hide. Never creates a terminal (newTerminal calls this, so it must not call back).
function setTermVisible(show) {
  $('term').hidden = !show;
  $('termBtn').style.color = show ? 'var(--accent)' : '';
}

// Toggle button / Ctrl+`: show the panel, creating the first terminal if there is none.
function showTerm(force) {
  const show = force ?? $('term').hidden;
  setTermVisible(show);
  if (!show) return;
  if (!Object.keys(terms).length) { newTerminal(); return; }
  fitTerm(activeTerm);
  activeTerm?.term.focus();
}

// For /run: type the command into the active terminal as if you had typed it.
async function runInTerminal(cmd) {
  if (!activeTerm) await newTerminal();
  if (!activeTerm) return;
  setTermVisible(true);
  api.termInput(activeTerm.id, cmd + '\r');
  activeTerm.term.focus();
}

api.onTermData(({ id, data }) => {
  if (terms[id]) terms[id].term.write(data);
  else (termBuffer[id] ||= []).push(data);
});
api.onTermExit(({ id, code }) => {
  const t = terms[id];
  if (!t) return;
  t.exited = true;
  t.term.write(`\r\n\x1b[90m[process exited with code ${code}. Press any key to close]\x1b[0m`);
  paintTermTabs();
});

new ResizeObserver(() => fitTerm(activeTerm)).observe($('termHost'));
$('termNew').onclick = newTerminal;

// drag the top edge to resize the terminal panel
$('termSplit').addEventListener('mousedown', (e) => {
  e.preventDefault();
  $('termSplit').classList.add('drag');
  const bottom = $('term').getBoundingClientRect().bottom;
  const move = (ev) => $('term').style.setProperty('--termh', Math.min(innerHeight - 220, Math.max(120, bottom - ev.clientY)) + 'px');
  const up = () => {
    $('termSplit').classList.remove('drag');
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
});
