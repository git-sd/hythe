'use strict';
// Main-process helpers for the Developer Utilities: hashing and a time-limited regex tester.
const crypto = require('crypto');
const fs = require('fs');
const { Worker } = require('worker_threads');

const ALGOS = ['md5', 'sha1', 'sha256'];

function hashBuffer(buf) {
  const out = { bytes: buf.length };
  for (const a of ALGOS) out[a] = crypto.createHash(a).update(buf).digest('hex');
  return out;
}

function hashFile(file, maxBytes = 2 * 1024 ** 3) {
  return new Promise((resolve, reject) => {
    const hs = ALGOS.map((a) => crypto.createHash(a));
    let bytes = 0;
    const s = fs.createReadStream(file);
    s.on('data', (d) => { bytes += d.length; if (bytes > maxBytes) s.destroy(new Error('File is too large to hash here.')); for (const h of hs) h.update(d); });
    s.on('error', reject);
    s.on('end', () => resolve({ bytes, ...Object.fromEntries(ALGOS.map((a, i) => [a, hs[i].digest('hex')])) }));
  });
}

/* Regex testing runs in a worker thread so a catastrophic pattern can be stopped after a moment. */
const WORKER_SRC = `
const { parentPort } = require('worker_threads');
parentPort.on('message', ({ id, pattern, flags, text, limit }) => {
  try {
    const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    const matches = [];
    let m;
    while ((m = re.exec(text)) && matches.length < limit) {
      matches.push({ index: m.index, text: m[0], groups: Array.from(m).slice(1).map((g) => (g === undefined ? null : g)), named: m.groups ? { ...m.groups } : null });
      if (m[0] === '') re.lastIndex++;
    }
    parentPort.postMessage({ id, ok: true, matches, truncated: matches.length >= limit });
  } catch (e) { parentPort.postMessage({ id, ok: false, error: e.message }); }
});`;

let worker = null;
let seq = 0;
function regexTest({ pattern, flags = '', text = '' }, ms = 1500) {
  if (typeof pattern !== 'string' || pattern.length > 2000) return Promise.resolve({ ok: false, error: 'Pattern is missing or too long.' });
  if (typeof text !== 'string' || text.length > 500000) return Promise.resolve({ ok: false, error: 'Text is too long (limit 500,000 characters).' });
  if (!/^[dgimsuyv]*$/.test(flags)) return Promise.resolve({ ok: false, error: 'Unknown flags.' });
  try { new RegExp(pattern, flags); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
  if (!worker) { worker = new Worker(WORKER_SRC, { eval: true }); worker.unref(); worker.on('error', () => { worker = null; }); }
  const w = worker;
  const id = ++seq;
  return new Promise((resolve) => {
    const done = (r) => { clearTimeout(t); w.off('message', on); resolve(r); };
    const on = (msg) => { if (msg.id === id) done(msg); };
    const t = setTimeout(() => { w.terminate(); if (worker === w) worker = null; done({ ok: false, timeout: true, error: 'The pattern took too long (possible catastrophic backtracking) and was stopped.' }); }, ms);
    w.on('message', on);
    w.postMessage({ id, pattern, flags, text, limit: 1000 });
  });
}

module.exports = { hashBuffer, hashFile, regexTest };
