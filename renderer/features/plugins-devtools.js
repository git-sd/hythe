/* Developer utilities (part of the plugins feature, loaded on demand by features/plugins.js).
   Fully offline. Pure helpers live in window.FaberDevtools.lib so they can be tested. */
(() => {
  const ENC = new TextEncoder();
  const DEC = new TextDecoder();

  /* ---------------- JSON ---------------- */
  function jsonCheck(text) {
    let i = 0;
    const fail = (msg) => { throw { msg, at: i }; };
    const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
    const str = () => {
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') { i++; return; }
        if (c === '\\') {
          const n = text[i + 1];
          if (n === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { i += 2; fail('Bad \\u escape'); } i += 6; continue; }
          if (!'"\\/bfnrt'.includes(n || '#')) { i++; fail('Bad escape character'); }
          i += 2; continue;
        }
        if (c < ' ') fail('Control character in string (use \\n)');
        i++;
      }
      fail('Unterminated string');
    };
    const num = () => {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fail('Bad number');
      i += m[0].length;
    };
    const val = () => {
      ws();
      const c = text[i];
      if (c === '{') {
        i++; ws();
        if (text[i] === '}') { i++; return; }
        for (;;) {
          ws();
          if (text[i] !== '"') fail('Expected a property name in double quotes');
          str(); ws();
          if (text[i] !== ':') fail('Expected ":"');
          i++; val(); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return; }
          fail('Expected "," or "}"');
        }
      }
      if (c === '[') {
        i++; ws();
        if (text[i] === ']') { i++; return; }
        for (;;) {
          val(); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return; }
          fail('Expected "," or "]"');
        }
      }
      if (c === '"') return str();
      if (c === '-' || (c >= '0' && c <= '9')) return num();
      for (const w of ['true', 'false', 'null']) if (text.startsWith(w, i)) { i += w.length; return; }
      fail(c === undefined ? 'Unexpected end of input' : 'Unexpected character ' + JSON.stringify(c));
    };
    if (!text.trim()) return { ok: false, error: 'Nothing to check', line: 1, col: 1 };
    try {
      val(); ws();
      if (i < text.length) fail('Unexpected text after the JSON value');
      return { ok: true };
    } catch (e) {
      if (e && e.msg === undefined) throw e;
      const before = text.slice(0, e.at).split('\n');
      return { ok: false, error: e.msg, line: before.length, col: before[before.length - 1].length + 1 };
    }
  }
  const jsonFormat = (text, indent = 2) => JSON.stringify(JSON.parse(text), null, indent === 'tab' ? '\t' : indent);
  const jsonMin = (text) => JSON.stringify(JSON.parse(text));

  // $.a.b[0].c   a.b[*]   ['key with space']   .*   (no filters or recursion)
  function jsonQuery(data, path) {
    let p = path.trim();
    if (p.startsWith('$')) p = p.slice(1);
    const steps = [];
    const re = /\.\*|\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[\*\]|\['([^']*)'\]|\["([^"]*)"\]|^([A-Za-z_$][\w$-]*)/y;
    let pos = 0;
    while (pos < p.length) {
      re.lastIndex = pos;
      const m = re.exec(p);
      if (!m) throw new Error('Cannot read the path at: ' + p.slice(pos));
      if (m[0] === '.*' || m[0] === '[*]') steps.push({ all: true });
      else if (m[2] !== undefined) steps.push({ key: Number(m[2]) });
      else steps.push({ key: m[1] ?? m[3] ?? m[4] ?? m[5] });
      pos = re.lastIndex;
    }
    let cur = [data];
    for (const s of steps) {
      const next = [];
      for (const v of cur) {
        if (v === null || typeof v !== 'object') continue;
        if (s.all) next.push(...(Array.isArray(v) ? v : Object.values(v)));
        else if (Object.prototype.hasOwnProperty.call(v, s.key)) next.push(v[s.key]);
      }
      cur = next;
    }
    return cur;
  }

  /* ---------------- encoders ---------------- */
  const b64Encode = (s, url) => {
    const bytes = ENC.encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    let out = btoa(bin);
    if (url) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return out;
  };
  const b64Decode = (s) => {
    let t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return DEC.decode(bytes);
  };
  const urlEncode = (s, whole) => (whole ? encodeURI(s) : encodeURIComponent(s));
  const urlDecode = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
  const HTML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7', deg: '\u00b0', plusmn: '\u00b1', para: '\u00b6', sect: '\u00a7', bull: '\u2022', rarr: '\u2192', larr: '\u2190' };
  const htmlEncode = (s, nonAscii) => {
    let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    if (nonAscii) out = Array.from(out).map((c) => (c.codePointAt(0) > 127 ? '&#' + c.codePointAt(0) + ';' : c)).join('');
    return out;
  };
  const htmlDecode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(HTML_NAMED, e) ? HTML_NAMED[e] : m;
  });

  /* ---------------- ids ---------------- */
  const uuid4 = () => crypto.randomUUID();
  const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function ulid(ms = Date.now()) {
    let t = ms, time = '';
    for (let i = 0; i < 10; i++) { time = CROCK[t % 32] + time; t = Math.floor(t / 32); }
    const r = crypto.getRandomValues(new Uint8Array(16));
    return time + Array.from(r, (b) => CROCK[b & 31]).join('');
  }
  function ulidTime(id) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return null;
    let t = 0;
    for (const c of id.slice(0, 10).toUpperCase()) t = t * 32 + CROCK.indexOf(c);
    return t;
  }

  /* ---------------- JWT (decode only) ---------------- */
  function jwtDecode(token) {
    const parts = token.trim().split('.');
    if (parts.length !== 3) throw new Error('A JWT has three dot-separated parts (header.payload.signature).');
    const part = (s, name) => {
      try { return JSON.parse(b64Decode(s)); } catch { throw new Error(`The ${name} is not valid base64url JSON.`); }
    };
    const header = part(parts[0], 'header');
    const payload = part(parts[1], 'payload');
    const times = {};
    for (const k of ['iat', 'nbf', 'exp']) if (typeof payload[k] === 'number') times[k] = new Date(payload[k] * 1000).toISOString();
    const note = [];
    if (header.alg === 'none') note.push('alg is "none": this token is unsigned.');
    if (typeof payload.exp === 'number') note.push(payload.exp * 1000 < Date.now() ? 'The exp claim says this token has expired.' : 'The exp claim says it has not expired yet.');
    return { header, payload, signature: parts[2], times, note };
  }

  /* ---------------- time ---------------- */
  function epoch(input) {
    const s = String(input).trim();
    let ms;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      ms = Math.abs(n) >= 1e11 ? n : n * 1000;       // 11+ digits means milliseconds
    } else {
      ms = Date.parse(s);
    }
    if (!Number.isFinite(ms)) throw new Error('Not a number or a date I can read. Try 1700000000 or 2024-05-01T12:00:00Z.');
    const d = new Date(ms);
    if (isNaN(d.getTime())) throw new Error('That is outside the range of dates.');
    const diff = Math.round((ms - Date.now()) / 1000);
    const abs = Math.abs(diff);
    const unit = abs < 60 ? [abs, 'second'] : abs < 3600 ? [Math.round(abs / 60), 'minute'] : abs < 86400 ? [Math.round(abs / 3600), 'hour'] : [Math.round(abs / 86400), 'day'];
    return {
      seconds: Math.floor(ms / 1000), millis: ms, iso: d.toISOString(), utc: d.toUTCString(), local: d.toString(),
      relative: `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'} ${diff < 0 ? 'ago' : 'from now'}`,
    };
  }

  /* ---------------- colour ---------------- */
  const NAMES = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', lime: '#00ff00', navy: '#000080', teal: '#008080', silver: '#c0c0c0' };
  function parseColour(input) {
    let s = String(input).trim().toLowerCase();
    if (NAMES[s]) s = NAMES[s];
    let m;
    if ((m = /^#([0-9a-f]{3,4})$/.exec(s))) { const h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: h[3] ? parseInt(h[3] + h[3], 16) / 255 : 1 }; }
    if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s))) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    if ((m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+%?))?\s*\)$/.exec(s))) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: Math.min(255, +m[1]), g: Math.min(255, +m[2]), b: Math.min(255, +m[3]), a };
    }
    if ((m = /^hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%(?:[\s,/]+(\d*\.?\d+%?))?\s*\)$/.exec(s))) {
      const h = ((+m[1] % 360) + 360) % 360, sat = Math.min(100, +m[2]) / 100, l = Math.min(100, +m[3]) / 100;
      const k = (n) => (n + h / 30) % 12, a2 = sat * Math.min(l, 1 - l);
      const f = (n) => l - a2 * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a };
    }
    throw new Error('Try #1e90ff, rgb(30, 144, 255), hsl(210, 100%, 56%) or a basic colour name.');
  }
  function colourFormats(c) {
    const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    const A = Math.round(c.a * 1000) / 1000;
    const H = Math.round(h), S = Math.round(s * 100), L = Math.round(l * 100);
    return {
      hex: '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a < 1 ? hex2(c.a * 255) : ''),
      rgb: c.a < 1 ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${A})` : `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`,
      hsl: c.a < 1 ? `hsla(${H}, ${S}%, ${L}%, ${A})` : `hsl(${H}, ${S}%, ${L}%)`,
    };
  }

  /* ---------------- diff ---------------- */
  // -> [{t:'=' | '+' | '-', s}] line diff. Returns null if the inputs are too big for the simple algorithm.
  function diffLines(a, b, ignoreWs) {
    const A = a === '' ? [] : a.split('\n'), B = b === '' ? [] : b.split('\n');
    const key = (s) => (ignoreWs ? s.replace(/\s+/g, ' ').trim() : s);
    let p = 0;
    while (p < A.length && p < B.length && key(A[p]) === key(B[p])) p++;
    let q = 0;
    while (q < A.length - p && q < B.length - p && key(A[A.length - 1 - q]) === key(B[B.length - 1 - q])) q++;
    const a2 = A.slice(p, A.length - q), b2 = B.slice(p, B.length - q);
    if (a2.length * b2.length > 6e6) return null;
    const n = a2.length, m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = key(a2[i]) === key(b2[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = A.slice(0, p).map((s) => ({ t: '=', s }));
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (key(a2[i]) === key(b2[j])) { out.push({ t: '=', s: a2[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a2[i++] });
      else out.push({ t: '+', s: b2[j++] });
    }
    while (i < n) out.push({ t: '-', s: a2[i++] });
    while (j < m) out.push({ t: '+', s: b2[j++] });
    for (const s of A.slice(A.length - q)) out.push({ t: '=', s });
    return out;
  }

  const lib = { jsonCheck, jsonFormat, jsonMin, jsonQuery, b64Encode, b64Decode, urlEncode, urlDecode, htmlEncode, htmlDecode, uuid4, ulid, ulidTime, jwtDecode, epoch, parseColour, colourFormats, diffLines };

  /* ---------------- UI ---------------- */
  function open(F, { call }) {
    const el = F.el;
    const debounce = (fn, ms = 120) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    const area = (ph, rows) => { const t = el('textarea'); t.placeholder = ph || ''; t.spellcheck = false; if (rows) t.rows = rows; return t; };
    const line = (ph) => { const i = el('input'); i.type = 'text'; i.placeholder = ph || ''; i.spellcheck = false; return i; };
    const label = (t) => el('div', 'dvLabel', t);
    const btn = (t, fn) => { const b = el('button', '', t); b.onclick = fn; return b; };
    const row = (...kids) => { const r = el('div', 'dvRow'); r.append(...kids); return r; };
    const copy = (getText) => btn('Copy', () => {
      const text = getText();
      const done = () => F.toast('Copied');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); else fallbackCopy(text, done);
    });
    function fallbackCopy(text, done) {
      const t = el('textarea'); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); } catch { F.toast('Copy failed'); }
      t.remove();
    }
    const check = (text, checked) => { const l = el('label', 'dvLabel'); const c = el('input'); c.type = 'checkbox'; c.checked = !!checked; l.append(c, ' ' + text); return { l, c }; };

    const tools = {};

    tools.Regex = (box) => {
      const pat = line('Pattern, e.g. (\\d+)-(\\w+)');
      pat.id = 'dvRePat';
      const flags = {};
      const fl = row(label('Flags'));
      for (const f of ['g', 'i', 'm', 's', 'u']) { const c = check(f, f === 'g'); flags[f] = c.c; fl.appendChild(c.l); }
      const text = area('Text to test', 6); text.id = 'dvReText';
      const hl = el('div', 'dvHl'); hl.id = 'dvReHl';
      const info = el('div', 'dvNote'); info.id = 'dvReInfo';
      const table = el('table', 'dvTable'); table.id = 'dvReTable';
      let seq = 0;
      const run = debounce(async () => {
        const my = ++seq;
        const fs = Object.keys(flags).filter((k) => flags[k].checked).join('');
        if (!pat.value) { hl.textContent = text.value; info.textContent = 'Type a pattern.'; info.className = 'dvNote'; table.textContent = ''; return; }
        const r = await call('regex', { pattern: pat.value, flags: fs, text: text.value }).catch((e) => ({ ok: false, error: e.message }));
        if (my !== seq) return;
        table.textContent = '';
        if (!r.ok) { info.textContent = r.error; info.className = 'dvErr'; hl.textContent = text.value; return; }
        info.className = 'dvOk';
        info.textContent = r.matches.length + ' match' + (r.matches.length === 1 ? '' : 'es') + (r.truncated ? ' (first 1000)' : '');
        hl.textContent = '';
        let pos = 0;
        for (const m of r.matches) {
          if (m.index < pos) continue;
          hl.append(text.value.slice(pos, m.index));
          hl.appendChild(el('span', 'dvMatch', m.text));
          pos = m.index + m.text.length;
        }
        hl.append(text.value.slice(pos));
        const head = table.insertRow();
        for (const h of ['#', 'Index', 'Match', 'Groups']) head.appendChild(el('th', '', h));
        r.matches.slice(0, 200).forEach((m, i) => {
          const tr = table.insertRow();
          tr.insertCell().textContent = i + 1;
          tr.insertCell().textContent = m.index;
          tr.insertCell().textContent = m.text;
          const named = m.named ? Object.entries(m.named).map(([k, v]) => `${k}=${JSON.stringify(v)}`) : [];
          tr.insertCell().textContent = [...m.groups.map((x, gi) => `$${gi + 1}=${x === null ? 'undefined' : JSON.stringify(x)}`), ...named].join('  ');
        });
      });
      for (const e of [pat, text, ...Object.values(flags)]) { e.addEventListener('input', run); e.addEventListener('change', run); }
      box.append(pat, fl, text, info, hl, table);
    };

    tools.JSON = (box) => {
      const inp = area('Paste JSON here', 10); inp.id = 'dvJsonIn';
      const out = area('Result', 10); out.id = 'dvJsonOut'; out.readOnly = true; out.className = 'dvOut';
      const msg = el('div', 'dvNote'); msg.id = 'dvJsonMsg';
      const q = line('Path query, e.g. $.users[0].name or items[*].id'); q.id = 'dvJsonQ';
      const set = (ok, t) => { msg.textContent = t; msg.className = ok ? 'dvOk' : 'dvErr'; };
      const act = (fn) => () => {
        const c = jsonCheck(inp.value);
        if (!c.ok) { out.value = ''; return set(false, `Invalid JSON at line ${c.line}, column ${c.col}: ${c.error}`); }
        try { out.value = fn(); set(true, 'Valid JSON'); } catch (e) { set(false, e.message); }
      };
      const validate = btn('Validate', act(() => inp.value));
      const fmt = btn('Format (2 spaces)', act(() => jsonFormat(inp.value, 2)));
      const fmt4 = btn('Format (4 spaces)', act(() => jsonFormat(inp.value, 4)));
      const min = btn('Minify', act(() => jsonMin(inp.value)));
      const query = btn('Run query', act(() => { const r = jsonQuery(JSON.parse(inp.value), q.value); return r.length === 1 ? JSON.stringify(r[0], null, 2) : JSON.stringify(r, null, 2); }));
      for (const b of [validate, fmt, fmt4, min, query]) b.classList.add('dvAct');
      box.append(inp, row(validate, fmt, fmt4, min), row(q, query), msg, out, row(copy(() => out.value)));
    };

    tools.Encode = (box) => {
      const inp = area('Text', 5); inp.id = 'dvEncIn';
      const out = area('Result', 5); out.id = 'dvEncOut'; out.readOnly = true; out.className = 'dvOut';
      const msg = el('div', 'dvErr'); msg.id = 'dvEncMsg';
      const run = (fn) => () => { try { out.value = fn(inp.value); msg.textContent = ''; } catch (e) { out.value = ''; msg.textContent = 'Could not convert: ' + e.message; } };
      const b = (t, fn) => { const x = btn(t, run(fn)); x.dataset.act = t; return x; };
      box.append(inp,
        row(b('Base64 encode', (s) => b64Encode(s)), b('Base64 decode', b64Decode), b('Base64URL encode', (s) => b64Encode(s, true))),
        row(b('URL encode', (s) => urlEncode(s)), b('URL decode', urlDecode), b('encodeURI', (s) => urlEncode(s, true))),
        row(b('HTML encode', (s) => htmlEncode(s)), b('HTML encode (non-ASCII too)', (s) => htmlEncode(s, true)), b('HTML decode', htmlDecode)),
        msg, out, row(copy(() => out.value)));
    };

    tools.IDs = (box) => {
      const out = area('', 8); out.id = 'dvIdOut'; out.readOnly = true; out.className = 'dvOut';
      const n = el('input'); n.type = 'number'; n.min = 1; n.max = 100; n.value = 5; n.style.width = '70px';
      const gen = (fn) => () => { const c = Math.max(1, Math.min(100, +n.value || 1)); out.value = Array.from({ length: c }, fn).join('\n'); };
      const chk = line('Paste a ULID to read its time'); chk.id = 'dvUlidIn';
      const res = el('div', 'dvNote'); res.id = 'dvUlidOut';
      chk.addEventListener('input', () => { const t = ulidTime(chk.value.trim()); res.textContent = chk.value ? (t === null ? 'Not a valid ULID' : 'Created ' + new Date(t).toISOString()) : ''; });
      const g1 = btn('UUID v4', gen(uuid4)); g1.dataset.act = 'uuid';
      const g2 = btn('ULID', gen(() => ulid())); g2.dataset.act = 'ulid';
      box.append(row(label('How many'), n, g1, g2), out, row(copy(() => out.value)), chk, res);
    };

    tools.Hash = (box) => {
      const inp = area('Text to hash (UTF-8)', 5); inp.id = 'dvHashIn';
      const out = el('table', 'dvTable'); out.id = 'dvHashOut';
      const msg = el('div', 'dvNote'); msg.id = 'dvHashMsg';
      const show = (r, what) => {
        out.textContent = '';
        if (!r.ok) { msg.textContent = r.error; msg.className = 'dvErr'; return; }
        msg.textContent = what + ' (' + r.bytes + ' bytes)'; msg.className = 'dvNote';
        for (const k of ['md5', 'sha1', 'sha256']) { const tr = out.insertRow(); tr.insertCell().textContent = k.toUpperCase(); const c = tr.insertCell(); c.textContent = r[k]; c.className = 'dvHash_' + k; }
      };
      const text = debounce(async () => show(await call('hash', { text: inp.value }).catch((e) => ({ ok: false, error: e.message })), 'Text'));
      inp.addEventListener('input', text);
      const pick = btn('Choose file...', async () => { const r = await call('hash', { pick: true }).catch((e) => ({ ok: false, error: e.message })); if (r.ok || r.error !== 'Cancelled.') show(r, r.file || 'File'); });
      box.append(inp, row(pick, el('span', 'dvNote', 'md5 and sha1 are for checksums only, not for security.')), msg, out);
      text();
    };

    tools.JWT = (box) => {
      box.append(el('div', 'dvWarn', 'Decode only. The signature is NOT verified here, so a token that decodes is not proof it is genuine. Never trust a token because it decodes.'));
      const inp = area('Paste a JWT', 4); inp.id = 'dvJwtIn';
      const out = el('div', 'dvMono'); out.id = 'dvJwtOut';
      inp.addEventListener('input', () => {
        out.textContent = '';
        if (!inp.value.trim()) return;
        try {
          const j = jwtDecode(inp.value);
          out.className = 'dvMono';
          out.textContent = 'Header\n' + JSON.stringify(j.header, null, 2) + '\n\nPayload\n' + JSON.stringify(j.payload, null, 2) +
            (Object.keys(j.times).length ? '\n\nTimes (UTC)\n' + Object.entries(j.times).map(([k, v]) => `${k}: ${v}`).join('\n') : '') +
            '\n\nSignature (not verified)\n' + j.signature + (j.note.length ? '\n\n' + j.note.join('\n') : '');
        } catch (e) { out.className = 'dvErr'; out.textContent = e.message; }
      });
      box.append(inp, out);
    };

    tools.Time = (box) => {
      const inp = line('Epoch seconds / milliseconds, or a date like 2024-05-01T12:00:00Z'); inp.id = 'dvTimeIn';
      const out = el('table', 'dvTable'); out.id = 'dvTimeOut';
      const msg = el('div', 'dvErr'); msg.id = 'dvTimeMsg';
      const run = () => {
        out.textContent = ''; msg.textContent = '';
        if (!inp.value.trim()) return;
        try {
          const r = epoch(inp.value);
          for (const [k, v] of [['Seconds', r.seconds], ['Milliseconds', r.millis], ['ISO 8601 (UTC)', r.iso], ['UTC', r.utc], ['Local', r.local], ['Relative', r.relative]]) { const tr = out.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
        } catch (e) { msg.textContent = e.message; }
      };
      inp.addEventListener('input', run);
      box.append(row(inp, btn('Now', () => { inp.value = String(Math.floor(Date.now() / 1000)); run(); })), msg, out);
    };

    tools.Colour = (box) => {
      const inp = line('#1e90ff, rgb(30, 144, 255), hsl(210, 100%, 56%) or a name'); inp.id = 'dvColIn';
      const out = el('table', 'dvTable'); out.id = 'dvColOut';
      const sw = el('div', 'dvSwatch');
      const msg = el('div', 'dvErr'); msg.id = 'dvColMsg';
      const picker = el('input'); picker.type = 'color';
      const run = () => {
        out.textContent = ''; msg.textContent = '';
        if (!inp.value.trim()) { sw.style.background = 'transparent'; return; }
        try {
          const c = parseColour(inp.value), f = colourFormats(c);
          sw.style.background = f.hex;
          for (const k of ['hex', 'rgb', 'hsl']) { const tr = out.insertRow(); tr.insertCell().textContent = k.toUpperCase(); tr.insertCell().textContent = f[k]; }
        } catch (e) { msg.textContent = e.message; sw.style.background = 'transparent'; }
      };
      inp.addEventListener('input', run);
      picker.addEventListener('input', () => { inp.value = picker.value; run(); });
      box.append(row(inp, picker, sw), msg, out);
    };

    tools.Diff = (box) => {
      const a = area('Original text', 8), b = area('Changed text', 8);
      a.id = 'dvDiffA'; b.id = 'dvDiffB';
      const ws = check('Ignore whitespace differences');
      const out = el('div', 'dvDiff'); out.id = 'dvDiffOut';
      const stat = el('div', 'dvNote'); stat.id = 'dvDiffStat';
      const run = debounce(() => {
        out.textContent = '';
        const d = diffLines(a.value, b.value, ws.c.checked);
        if (!d) { stat.textContent = 'These texts are too large to compare here.'; return; }
        const add = d.filter((x) => x.t === '+').length, del = d.filter((x) => x.t === '-').length;
        stat.textContent = add || del ? `${add} added, ${del} removed` : 'The texts are identical';
        for (const x of d) out.appendChild(el('div', x.t === '+' ? 'add' : x.t === '-' ? 'del' : '', (x.t === '=' ? '  ' : x.t + ' ') + x.s));
      });
      for (const e of [a, b, ws.c]) { e.addEventListener('input', run); e.addEventListener('change', run); }
      box.append(row(ws.l), a, b, stat, out);
    };

    F.modal({
      title: 'Developer utilities (offline)', wide: true,
      body: (content) => {
        const wrap = el('div', 'dvWrap');
        const tabs = el('div', 'dvTabs');
        const panes = {};
        const show = (name) => {
          for (const k of Object.keys(panes)) { panes[k].hidden = k !== name; tabs.querySelector(`[data-t="${k}"]`).classList.toggle('on', k === name); }
        };
        for (const [name, build] of Object.entries(tools)) {
          const t = el('button', 'dvTab', name); t.dataset.t = name; t.onclick = () => show(name);
          tabs.appendChild(t);
          const pane = el('div', 'dvPane'); pane.dataset.pane = name; pane.hidden = true;
          build(pane);
          panes[name] = pane;
        }
        wrap.append(tabs, ...Object.values(panes));
        content.appendChild(wrap);
        show('Regex');
      },
    });
  }

  window.FaberDevtools = { lib, open };
})();
