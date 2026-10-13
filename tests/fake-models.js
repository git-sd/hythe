// Four DISTINCT scripted "models" behind one fake Ollama, for testing and demoing multi-model collaboration without
// real models. Each persona behaves differently (planner, coder, fast summariser, reviewer) and keeps its own state.
// This proves the plumbing (routing, model choice, hand-offs, trace). It does NOT prove real-model quality.
const { startFake } = require('./fake-ollama-chat');

const FIZZ = `// fizzbuzz(n): array of strings for 1..n
function fizzbuzz(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : String(i));
  return out;
}
module.exports = { fizzbuzz };
`;
const TEST = `const assert = require('assert');
const { fizzbuzz } = require('./fizzbuzz');
const r = fizzbuzz(15);
assert.strictEqual(r[0], '1');
assert.strictEqual(r[2], 'Fizz');
assert.strictEqual(r[4], 'Buzz');
assert.strictEqual(r[14], 'FizzBuzz');
assert.strictEqual(r.length, 15);
console.log('all fizzbuzz tests passed');
`;

const MODELS = { conductor: 'qwen3.5:9b', coder: 'fake-coder:7b', fast: 'fake-fast:1b', reviewer: 'fake-review:3b' };

async function startPersonaFake(opts = {}) {
  const fake = await startFake({ models: Object.values(MODELS), sizes: { 'qwen3.5:9b': 6.6e9, 'fake-coder:7b': 4.7e9, 'fake-fast:1b': 1.3e9, 'fake-review:3b': 2.5e9 } });
  const seen = { reviews: 0, coderReworks: 0 };
  const call = (name, args) => ({ calls: [{ name, args }] });
  const lastUser = (body) => { const m = body.messages; for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return { i, text: m[i].content }; return { i: -1, text: '' }; };
  const toolCount = (body, i) => body.messages.slice(i + 1).filter((m) => m.role === 'tool').length;

  fake.script = async (body) => {
    const { i, text } = lastUser(body);
    const n = toolCount(body, i);
    const step = (text.match(/YOUR STEP (\w+):/) || [])[1];
    const dl = (opts.delayByModel || {})[body.model] || opts.delay || 0;
    if (dl) await new Promise((r) => setTimeout(r, dl));
    switch (body.model) {
      case MODELS.conductor: {
        if (/Reply with ONLY a JSON/.test(text)) {
          if (n === 0) return call('list_dir', { path: '.' });
          if (opts.badPlan) return { content: 'Sure! Here is my plan: first do it, then check it.' };
          const plan = { steps: [
            { id: 's1', agent: 'coder', instruction: 'Create fizzbuzz.js exporting fizzbuzz(n) that returns an array of strings for 1..n (Fizz, Buzz, FizzBuzz).', depends_on: [] },
            { id: 's2', agent: opts.s2Agent || 'coder', instruction: 'Create test.js that requires ./fizzbuzz and asserts the results for 1..15 with node assert, printing a success line.', depends_on: [] },
            { id: 's3', agent: 'fast', instruction: 'Read fizzbuzz.js and test.js and reply with a two-sentence description of what they do, for a README.', depends_on: ['s1', 's2'] },
            { id: 's4', agent: 'coder', instruction: 'Create README.md using the description from the previous step.', depends_on: ['s3'] },
            { id: 's5', agent: 'reviewer', instruction: 'Review fizzbuzz.js, test.js and README.md against the task.', depends_on: ['s1', 's2', 's4'] },
          ] };
          return { content: 'Here is the plan:\n```json\n' + JSON.stringify(plan, null, 2) + '\n```' };
        }
        if (/All steps are finished/.test(text)) return { content: 'FINAL: Created fizzbuzz.js, test.js and README.md. The reviewer approved after one rework (a usage example was added to the README).' };
        if (/not usable/.test(text)) return { content: 'still not json' };
        return { content: 'ok' };
      }
      case MODELS.coder: {
        if (/asked for changes/.test(text)) {
          if (n === 0) seen.coderReworks++;
          if (n === 0) return call('write_file', { path: 'README.md', content: '# FizzBuzz\n\nfizzbuzz.js exports fizzbuzz(n); test.js checks it.\n\n## Usage\n\n    const { fizzbuzz } = require("./fizzbuzz");\n    fizzbuzz(15);\n' });
          return { content: 'Reworked README.md: added a Usage section.' };
        }
        if (step === 's1') return n === 0 ? call('write_file', { path: 'fizzbuzz.js', content: FIZZ }) : { content: 'Created fizzbuzz.js with fizzbuzz(n).' };
        if (step === 's2') return n === 0 ? call('write_file', { path: 'test.js', content: TEST }) : { content: 'Created test.js with 5 assertions.' };
        if (step === 's4') return n === 0 ? call('write_file', { path: 'README.md', content: '# FizzBuzz\n\nfizzbuzz.js exports fizzbuzz(n); test.js checks it.\n' }) : { content: 'Created README.md.' };
        return { content: 'nothing to do' };
      }
      case MODELS.fast: {
        if (n === 0) return call('read_file', { path: 'fizzbuzz.js' });
        if (n === 1) return call('read_file', { path: 'test.js' });
        return { content: 'fizzbuzz.js exports fizzbuzz(n), returning Fizz/Buzz/FizzBuzz strings for 1..n. test.js asserts the output for 1..15.' };
      }
      case MODELS.reviewer: {
        if (n === 0) return call('read_file', { path: 'fizzbuzz.js' });
        if (n === 1) return call('read_file', { path: 'test.js' });
        if (n === 2) return call('read_file', { path: 'README.md' });
        seen.reviews++;
        if (opts.alwaysReject || seen.reviews === 1) return { content: 'VERDICT: CHANGES NEEDED\n- README.md has no usage example.' };
        return { content: 'VERDICT: APPROVED\nAll three files match the task; README now has a usage example.' };
      }
      default: return { content: 'ok' };
    }
  };
  fake.seen = seen;
  return fake;
}

module.exports = { startPersonaFake, MODELS, FIZZ, TEST };
