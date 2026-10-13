'use strict';
// Helpers for reading command output.

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');

// Keep the start and (mostly) the end of long output; the end is where summaries and failures are.
function trimOutput(text, max = 6000) {
  text = stripAnsi(String(text)).replace(/\r\n/g, '\n').trim();
  if (text.length <= max) return text;
  const head = Math.floor(max / 4), tail = max - head;
  return text.slice(0, head) + `\n...[${text.length - max} characters omitted]...\n` + text.slice(-tail);
}

// -> {status:'pass'|'fail'|'unknown', passed, failed, skipped, line}
function summarizeTests(output, code) {
  const t = stripAnsi(output);
  let passed = null, failed = null, skipped = null, m;
  const num = (re) => { const r = re.exec(t); return r ? Number(r[1]) : null; };
  if ((m = /^Tests:\s+(.*)$/m.exec(t))) {                           // jest
    passed = (/(\d+) passed/.exec(m[1]) || [0, 0])[1] * 1; failed = (/(\d+) failed/.exec(m[1]) || [0, 0])[1] * 1; skipped = (/(\d+) skipped/.exec(m[1]) || [0, 0])[1] * 1;
  } else if ((m = /^\s*Tests\s+(.*)$/m.exec(t)) && /passed|failed/.test(m[1])) {   // vitest
    passed = (/(\d+) passed/.exec(m[1]) || [0, 0])[1] * 1; failed = (/(\d+) failed/.exec(m[1]) || [0, 0])[1] * 1; skipped = (/(\d+) skipped/.exec(m[1]) || [0, 0])[1] * 1;
  } else if (/^(?:#|\u2139) pass \d+/m.test(t)) {                    // node --test
    passed = num(/^(?:#|\u2139) pass (\d+)/m); failed = num(/^(?:#|\u2139) fail (\d+)/m); skipped = num(/^(?:#|\u2139) skipped (\d+)/m);
  } else if ((m = /^=+ (.*?) in [\d.]+s.*=+\s*$/m.exec(t) || /^(\d+ (?:passed|failed|error).*) in [\d.]+s/m.exec(t))) {   // pytest
    const s = m[1];
    passed = (/(\d+) passed/.exec(s) || [0, 0])[1] * 1; failed = ((/(\d+) failed/.exec(s) || [0, 0])[1] * 1) + ((/(\d+) errors?/.exec(s) || [0, 0])[1] * 1); skipped = (/(\d+) skipped/.exec(s) || [0, 0])[1] * 1;
  } else if (/^test result: /m.test(t)) {                            // cargo
    passed = 0; failed = 0; skipped = 0;
    for (const r of t.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)) { passed += +r[1]; failed += +r[2]; skipped += +r[3]; }
  } else if ((m = /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+)/.exec(t))) {   // dotnet
    failed = +m[1]; passed = +m[2]; skipped = +m[3];
  } else if (/^(ok|FAIL)\s+\S+/m.test(t) || /^--- FAIL/m.test(t)) {  // go
    passed = (t.match(/^ok\s+\S+/gm) || []).length; failed = (t.match(/^FAIL\s+\S+/gm) || []).length;
  }
  let status = code === 0 ? 'pass' : 'fail';
  if (failed) status = 'fail';
  const known = passed !== null || failed !== null;
  const line = known
    ? `${status === 'pass' ? 'PASS' : 'FAIL'}: ${passed || 0} passed, ${failed || 0} failed${skipped ? `, ${skipped} skipped` : ''}`
    : `${status === 'pass' ? 'PASS' : 'FAIL'}: exit code ${code}`;
  return { status, passed: passed || 0, failed: failed || 0, skipped: skipped || 0, line };
}

module.exports = { stripAnsi, trimOutput, summarizeTests };
