# Real-model results

Everything on this page was run for real: a real Ollama server, real GGUF models, a real CPU with no GPU. Nothing here comes from
the scripted stand-in models in `tests/` (those only test the plumbing). The raw outputs are in `docs/evidence/`, and the five
orchestration traces can be re-checked with `node tools/orchestra-cli.js verify docs/evidence/run3.trace.jsonl --show`.

## The machine and the models

- Intel Xeon @ 2.1 GHz, 4 cores (1 thread per core), AVX-512 with VNNI and AMX, 15.7 GB RAM, no GPU. A server CPU in a container, not a PC.
  Windows PCs will differ: run `node tools/orchestra-cli.js bench --models a,b` on yours.
- Ollama 0.40.3, taken from the official `ollama/ollama` Docker image.
- ollama.com and huggingface.co were blocked from the build environment, so the models came from Docker Hub's `ai/` namespace
  (`ai/qwen3.5` 0.8B / 4B / 9B, `ai/qwen3` 4B-instruct-2507, Q4_K_M unless noted; digests verified) and were imported with `ollama create`.

## 1. Running the primary model (qwen3.5 9B) efficiently on this CPU

Write speed is what you wait for while the model answers; read speed is how fast it takes in your prompt.

| What was compared | Result |
|---|---|
| Quantization, 9B: Q4_K_M (5.3 GB) vs Q8_0 (8.9 GB) | 3.70 vs 4.84 tokens/s writing. Q8_0 is 30% faster here, but 1.7x the RAM. |
| Quantization, 0.8B: Q4_K_M / Q8_0 / BF16 | 26 / 35 / 16 tokens/s writing |
| Threads, 9B Q4_K_M: 1 / 2 / 3 / 4 | 1.17 / 2.22 / 2.95 / 3.78 tokens/s. Scales with the 4 physical cores. |
| Flash attention off / on | 3.81 / 3.66 tokens/s writing. No difference: an earlier run of the same test showed +4% for "on", so it is noise (about 5%). |
| KV cache f16 / q8_0 (flash attention on) | writing 3.66 / 3.65 (same); reading the prompt 41.0 / 36.7 tokens/s (-10%; about -15% in an earlier run whose output was not kept). It saves memory, not time. |
| Ollama defaults vs the Faber profile (threads 4, ctx 4096, flash attention) | 3.88 vs 3.77 tokens/s: no difference. See below. |
| Loading a 9B | 10 to 30 s each time it is swapped in |

The honest summary: **on this machine Ollama's defaults were already about as fast as the Faber profile.** Ollama picked 4 threads
(the physical cores) and a 4096 context by itself, and flash attention is worth a few percent at most. What the tuner adds is
not a faster default; it stops you doing the things that were measured to be slower or to crash (a quantized KV cache when RAM is
fine, more threads than cores, more loaded models than fit in RAM) and it measures instead of guessing. Run-to-run noise on this
machine is about 5%, so differences smaller than that (flash attention) are not claimed. The one real speed lever
found is quantization: Q8_0 beat Q4_K_M by 30% on a CPU with AMX/VNNI, at a memory cost. Speculative decoding (a 0.8B draft model for
the 9B) could help more but Ollama does not expose it, so it was not tried.

Three recommendations in the tuner were wrong before they were measured, and were changed:

1. It assumed Q4 is about twice as fast as Q8. On an AMX/VNNI CPU Q8_0 was faster. The advice now depends on the CPU features.
2. It recommended a q8_0 KV cache for everyone. Measured: reading the prompt is 10 to 15% slower. Now only when RAM is tight, and it says so.
   (It also claimed flash attention was worth "+3 to 5%"; the repeat showed that was noise, and the text no longer says it.)
3. Its speed estimate (4.7 to 9.5 tokens/s for the 9B) was above what the machine did (3.7 to 4.0). The range is now 2.8 to 9.4.

## 2. Specialist models

Speeds measured inside the orchestration runs (`evidence/run*.trace.jsonl`, USAGE entries):

| Role | Model | Writing | Notes |
|---|---|---|---|
| conductor | qwen3.5:9b (5.3 GB) | 3.5 tokens/s | writes the plan (about 100 s) and the final answer (about 100 s) |
| coder | qwen3.5:4b (2.6 GB) | 5.9 tokens/s | wrote and edited the code correctly in every run; one README step ran out of tokens (run 4) |
| reviewer | qwen3:4b-instruct-2507 (2.3 GB) | 5.3 tokens/s | a different model from the coder (qwen3 instead of qwen3.5), on purpose, so the check is independent |
| fast | qwen3.5:0.8b (0.5 GB) | 25.3 tokens/s | 7 times faster than the 9B |

What the speed model is and is not good for: reading a file and describing it takes 8 to 12 s and was mostly right. Asked to judge
(run 3: "No problems detected" on a file with two bugs) or to do something it has no tool for (run 2: "run node test.js"; it made up a report
saying it had fixed things), it is unreliable. So the orchestrator gives it only read and describe jobs and only its own step.

## 3. Five real multi-model runs

Each run is the same machine, four models (9B conductor, 4B coder, 4B-instruct reviewer, 0.8B fast), `--effort low --ctx 4096 --concurrency 1`.
"Verified" means I ran the produced files myself afterwards, not that a model said so.

| Run | Task | Time | What happened |
|---|---|---|---|
| 1 | Write fizzbuzz.js, test.js, README.md | 375 s | Only 2 of the 4 models were used: the 9B put every step on the coder and ignored "end with a reviewer step". The code was right (verified, 5/5). Led to: the review is now enforced by the orchestrator. |
| 2 | Fix `median()` in stats.js, add tests and a changelog | 672 s | All 4 models. Code fix was right (verified). But: the 9B's JSON plan arrived as a bogus tool call instead of text, the Ollama runner was then killed twice (4 models resident on a 16 GB machine), so the final answer failed; the read-only fast model was told to "run node test.js" and invented a report. Led to: conductor without tools, retry after a killed runner, steps moved to a capable agent, `OLLAMA_MAX_LOADED_MODELS` advice from the roster size. |
| 3 | Same task, after those fixes | 691 s | All 4 models, no errors. Fix verified. The produced test.js fails on the original buggy code, as it should (8 pass, 1 fail, exit 1). Its "input is not modified" checks use already-sorted arrays, so they could not have caught the mutation bug: a weak test that the reviewer approved. |
| 4 | Fix wordcount.js (case, punctuation), add a test, update the README | 732 s | The code fix was right (verified). **Failed honestly**: the README step hit the token limit and returned nothing, yet was marked done; the reviewer approved without opening a single file; the 9B's final answer said the README was updated. It was not. Led to: the orchestrator now checks its own ledger (see below). |
| 5 | Same task, after the evidence checks | 673 s | All 7 steps done, 4 models, no errors. Verified: code fix right, README updated with the example, produced test.js fails on the original buggy code. Weakness: that test prints FAIL but still exits 0, so a script could not tell. |

What the orchestrator now does itself, because the real models did not:

- The conductor gets no tools and a listing of the project folder in its prompt (run 2).
- A step that begins with "run / create / fix ..." but names a read-only agent is moved to the coder, and the move is logged (run 2).
- The fast model only sees its own step, not the whole task (it tried to do the whole task in run 2).
- After the steps ran, any step whose tools really wrote files and has no reviewer after it gets a reviewer step (runs 1, 3).
- Each step is checked against the tool log: a coder step that asked for a change but wrote nothing, a reviewer that opened no file, or an empty
  reply after the token limit gets one visible nudge; if it still shows no evidence the step FAILS and what depends on it is skipped (run 4).
- The final answer ends with a block the orchestrator writes itself from the tool log: every step, its model, its result and what its tools did.
  A model cannot talk its way into that block (run 4).
- A request that dies because Ollama's model runner was killed is retried once, visibly (run 2).

## 4. Talking to the orchestrator (real models, terminal chat)

`node tools/orchestra-cli.js chat` on the same machine and models. The conversation, in order: "I want 4 agents: 2 coders, a reviewer and a fast
helper" -> "use qwen3.5:4b for the coders" -> "use qwen3:4b-instruct-2507 for the reviewer" -> "show the team" -> "don't ask me anything" -> a task
(fix `slugify()` so `Hello,  World!` becomes `hello-world`, add a test, add a Usage section) -> "ask coder2 to add a line to README.md saying the
module has no dependencies". Raw output: `evidence/chat-real.console.txt`, trace `evidence/chat-real.trace.jsonl` (121 entries, chain verified,
27 of them the conversation itself).

- **It worked as asked.** Four agents were created from one sentence; the 9B conductor's plan used `coder1` and `coder2` by name, so the two
  coders (same 4B model) split the steps; the 0.8B helper read the file, the reviewer (a different model) read three files and approved; the
  direct question went to `coder2` alone and it really did append the line (I checked the file). 1,028 s for the task on this CPU.
- **Verified by me afterwards:** the code fix is right (`Hello,  World!` -> `hello-world`, and other inputs behave), `test.js` passes 6/6 and
  exits non-zero on failure (an improvement on the earlier runs' tests). **Not right:** the README's Usage example calls
  `require('./test').runTests()`, which does not exist, and the reviewer approved it. The orchestrator's own tool-log block was correct about
  what each agent did; it cannot judge whether the content is right.
- **A first attempt failed for an environmental reason and exposed a bug.** The volume's page cache was cold and read at about 17 MB/s
  (`evidence/chat-real-attempt1-cold-disk.console.txt`), so the 9B did not finish loading within the 5 minutes Node's `fetch` waits for a
  first response. Faber reported "Cannot reach Ollama", which was wrong: Ollama was up and loading. Now a timeout is reported as "Ollama is
  running but did not answer within 5 minutes ... try again (the part already read is cached)", and the request is retried once. After the
  model files were read once (`cat file > /dev/null`) the second attempt ran normally. (A real PC's disk is much faster; the lesson is that
  "slow" and "unreachable" must not look the same.)
- The team commands in that conversation were understood by rules, not by a model, so they answered instantly; only the task used the models.

## What was NOT verified

- The nudge-then-fail path for a lazy coder, a reviewer that reads nothing and a cut-off reply is tested only with scripted models
  (`tests/orchestrator-unit.js`). In run 5 the real models did the work properly, so those paths never fired on a real model.
- Five orchestration runs and one chat session, on three small tasks. Small models vary from run to run; run 4 failed where runs 3 and 5 did not.
- The chat's understanding of what you type is a rule set tested on about 120 phrasings, not a language model. A sentence it does not recognise
  is treated as a task, so an unusual way of asking for agents may start a task instead; "undo" and the explanation of what it understood are the safety net.
- The Orchestra tab (chat and form) and the Trace panel were tested in a browser harness with scripted models, not with these real models, and
  not in real Electron. The terminal chat is the one that ran with real models.
- Nothing was run on Windows, with a GPU, or with the Claude provider.
- The reviewers approve tests that cannot catch the bug they are about. The orchestrator checks that a review happened, not that it was good.

## Reproduce

    ollama pull qwen3.5:9b            # or any models you have; Faber picks a role for each installed model
    node tools/orchestra-cli.js roster
    node tools/orchestra-cli.js run "<task>" --dir <folder> --effort low --ctx 4096 --trace trace.jsonl
    node tools/orchestra-cli.js verify trace.jsonl --show
    node tools/orchestra-cli.js bench --models qwen3.5:9b,qwen3.5-q:9b-q8 --threads 4 --long 1500
