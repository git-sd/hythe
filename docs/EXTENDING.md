# Extending Faber (read this first)

Faber is an Electron app (Windows is the primary target) that talks to a local Ollama server. It is an
offline-first coding assistant: chat + tools, file tree, editor, terminal. Several agents are adding
features IN PARALLEL, so everyone works in their OWN files and plugs in through small registries.

## Layout

    main.js                 main process (owned by the maintainer: do not edit; see "Need a core change?")
    preload.js              bridge (maintainer). Features use api.call / api.on only.
    src/agent.js            chat/agent loop                       (owner: AGENTS)
    src/tools.js            AI tools (read/write/edit/list/search/run_command) + registerTool()
    src/features.js         loads src/features/*.js
    src/features/<name>.js  main-process part of a feature   exports (ctx) => void
    renderer/index.html     markup (maintainer). Feature files are already linked, do not add tags.
    renderer/style.css      core styles (maintainer). Put your CSS in renderer/features/<name>.css
    renderer/app.js         core UI: chat rendering, tree, slash commands (owner of chat parts: AGENTS)
    renderer/editor.js      editor pane          renderer/terminal.js  real PTY terminals (xterm)
    renderer/faber.js       the extension API (below)
    renderer/features/<name>.js + .css   renderer part of a feature  Faber.register(name, (F) => {...})

Feature names: `ui-settings`, `background`, `agents`, `debug`, `models`, `git`, `remote`, `plugins`, `claude`
(optional online provider), `resources` (Models > Resources), `panes` (split chats), `team` (team mode).
Core (not features): `renderer/dock.js` (layout engine), `renderer/editor.js` (editor groups), `renderer/layout.js` (saves layouts),
`src/claude.js` (Anthropic API client), `src/team-lib.js` (team board), `src/bus.js` (features talking to features).

## Renderer API: `Faber` (see renderer/faber.js, ~150 lines, read it)

    Faber.register('git', (F) => { ... })     runs once at startup; add tabs/commands/buttons here
    F.onReady(fn)                              runs after settings are loaded and the app is usable
    F.settings() / F.saveSettings(patch)       core settings
    F.featureSettings(name) / F.saveFeatureSettings(name, patch)   your own persisted settings (merged per feature)
    F.addSideTab({id, title, render(el), onShow(el)})   adds a tab next to "Files" in the sidebar
    F.addCommand(name, argsHint, description, async (argString) => {})   slash command
    F.addHeaderButton({id, label, title, onClick})
    F.addSettingsSection({id, title, render(el)})        shows up in the Settings window (built by ui-settings)
    F.openSettings(sectionId)                  provided by ui-settings
    F.modal({title, body(el, api), buttons, wide}) -> {el, close()}      F.toast(text)
    F.sys(text) / F.error(text)                message in the chat      F.openFile(path)  F.refreshTree()
    F.runInTerminal(cmd)   F.folder()          the open folder ('' if none)
    F.call('feat:<name>:<method>', ...args)    invoke your main-process handler (returns a promise)
    F.on('feat:<name>:<event>', cb)            events your main process sends
    F.emit(name, data) / F.onEvent(name, cb)   core emits: 'enter', 'folder' (path), 'settings', and whatever you add
    F.el(tag, cls, text)                       tiny DOM helper

## Main-process API: `ctx` passed to src/features/<name>.js

    ctx.handle('feat:<name>:<method>', async (...args) => result)    channel names MUST start with "feat:"
    ctx.send('feat:<name>:<event>', payload)                          push to the renderer
    ctx.getSettings() / ctx.effective()        ctx.workspace() (open folder or '')    ctx.dataDir (userData path)
    ctx.featureSettings(name) / ctx.setFeatureSettings(name, patch)
    ctx.tools.registerTool(schema, async (args, toolCtx) => string)   add an AI tool (schema via ctx.tools.helpers.fn/str/num)
    ctx.setHost(url, remote)                   change the Ollama address (remote=true only after explicit user consent)
    ctx.ollamaUp()   ctx.window()   ctx.app   ctx.dialog   ctx.fs   ctx.path   ctx.os
    Settings changes made by the user arrive through the renderer; there is no ctx event for them, so re-read.

The loader calls your module once. If it throws, only your feature is disabled.

## Layout: dock, editor groups, panes (renderer)

The main area is a tree of panels managed by `Dock` (renderer/dock.js). Panels are real DOM elements that sit in `#dockPark`
while hidden. Every panel is registered with `Dock.register({ id, title, el, onClose })`: `chat` (the `#chatPanel` element,
always visible), `terminal` (`#term`), and one `editorN` per editor group.

    Dock.show(id[, {near, zone, ratio}])  Dock.hide(id)  Dock.toggle(id)  Dock.visible(id)  Dock.move(id, nearId, zone)
    Dock.reset()  Dock.serialize()  Dock.restore(tree)  Dock.onChange(fn)  Dock.title(id, text)

The user drags a panel's tab onto an edge (dock) or the middle (stack). `layout.js` persists the tree in `features.dock`.
Never hard-code positions of chat / editor / terminal: they move. Use ids (`$('edText')` is always the ACTIVE editor's text area).

Editor groups (`Editors`, renderer/editor.js): documents are shared between groups. The globals `tabs` / `activeTab` and the legacy ids
(`#editor #edText #tabs #edGutter ...`) always point at the active group, so code that edits "the editor" keeps working. Editor DOM
is styled by CLASS (`.edText .edHl .edGutter .edTabs ...`), never by id.

Split chat (`F.panes`, renderer/features/panes.js): `F.panes.show(sids, mode)`. Chat views are moved into pane bodies; a view's
scroll container is `view.scroller` (null in single mode). Streaming text is painted at most once per animation frame (`queuePaint`).

`Faber.chat` (app.js) also offers `views() view(sid) sendTo(sid, text) setBroadcast(fn) runCommand(line) openMenu(...)`. The event
`Faber.emit('agent-event', { view, ev })` fires for every agent event. Models tab views: `F.modelsViews.push({ id, title, render(el), onShow, onHide })`.

## Team mode and tools (main process)

Members are normal agent sessions created through `src/bus.js` (`bus.agents.create/run/stop/close`, filled by agents.js). Team tools
(`board_*`, `claim_files`, `finish_work`) are registered with `ctx.tools.registerTool(schema, impl, { when: (sessionId) => bool })`:
a tool with `when` is only offered to agents for which it returns true. `ctx.tools.setWriteGuard((absPath, toolCtx) => {})` lets a
feature veto `write_file` / `edit_file` (team file claims); it does NOT cover `run_command`. A session can have a restricted tool list
(`allowedTools`) and extra system text (`teamSystem`).

## Multi-agent orchestration, the communication line, CPU tuning

- `src/comms.js`: THE communication line. Anything that makes agents talk (orchestrator, team mode, future features) must do it
  through `line.request(from, {name, model, run}, text)` (logs the task, runs the agent, logs the reply or error) and log other
  traffic with `line.log({from, to, kind, text})`. `agentEventLogger(line, def)` turns an agent's event stream into entries (reasoning,
  tool calls with arguments, tool results, tokens). Entries are hash-chained (`verify()`), kept in memory, in a JSONL file and
  shown live in the Trace dock panel. `comms.shared()` is the one line per process. Never add a side channel between agents.
- `src/orchestrator.js`: conductor -> JSON plan -> steps on specialist agents (each its own model) -> reviewer verdict + rework -> final
  answer. Plain Node (no Electron): the same code runs in the app (`src/features/orchestra.js`) and from `tools/orchestra-cli.js`.
  Agents take turns per agent; `concurrency` (default 1, the right value for a CPU) bounds how many models run at once.
- `src/model-roster.js`: role -> model from what is installed (code specialist, smallest tool-capable model as the speed helper,
  a reviewer different from the coder), with optional download SUGGESTIONS (never installed automatically).
- `src/cpu-tune.js`: core detection, profile (threads, context, mmap, keep_alive, Ollama env vars), quantization advice, `benchmark()`
  and `autoTune()` against Ollama. Estimates are labelled estimates; the benchmark measures the real speed.
- Command line: `node tools/orchestra-cli.js run "<task>" | roster | tune --model M [--autotune] | demo`.

## Online provider (Claude)

`src/claude.js` maps `claude:<model-id>` models to the Anthropic Messages API (streaming, tool use, thinking blocks replayed with
their signatures). Rules: opt-in, never the default, key only via `safeStorage`, never sent to the renderer, a persistent ONLINE
indicator while on, and it is switched off at every start. Plain `fetch` is used on purpose (no new npm dependency).

## Rules for everyone

1. OFFLINE FIRST. The renderer is locked to local resources (CSP + request blocking). Never add a CDN, web font, or
   analytics. Anything that touches the network must be: (a) opt-in, (b) done from the main process, (c) clearly
   labelled "online" in the UI, (d) never run at startup unless the user turned it on.
2. SECRETS: never store tokens/passwords in plain text. Use Electron `safeStorage` (encryptString/decryptString) and
   keep the ciphertext in your feature settings. Never log secrets, never put them in URLs or command lines.
3. DESIGN: flat, solid colours only. NO gradients, glows, drop shadows, blur, translucency, or emoji. Use the CSS
   variables in style.css (`--bg --panel --panel2 --hover --sel --border --text --muted --accent --ok --bad`) so
   themes work. Small radii (4px). Match the existing look. Plain text labels or the simple 16x16 SVG icons.
4. FILES: edit only the files you own (your `features/<name>.*`, plus anything the task says). Never overwrite a file
   you did not read first. Core files (main.js, preload.js, index.html, style.css, faber.js) belong to the
   maintainer. Need a core change? Do NOT edit; describe it exactly in your final report (file, what, why).
   Exception: AGENTS owns src/agent.js and the chat-rendering parts of renderer/app.js; UI owns CSS variable
   definitions in style.css `:root` only through a feature stylesheet.
5. DEPENDENCIES: avoid new npm packages. Use Node/Electron built-ins and the system `git`/`ssh` if present. If a
   package is truly necessary, do not run npm install; say so in the report.
6. NO INSTALLER BUILDS (`npm run dist`) and no changes to package.json. The maintainer builds.
7. Be defensive: every IPC handler validates input, catches errors and returns useful messages. Long work must not
   block the UI. Handle "no folder open", "Ollama not running", "git not installed", etc.
8. Windows: paths use backslashes; use `path` module; shell is PowerShell. Line endings can be CRLF.
9. Keep it small and readable: match the existing style (short functions, comments only for the non-obvious).

## Testing (required: prove it works in the REAL app, not just syntax)

FIRST CHOICE for anything that is not Electron itself: the browser harness. `tests/web/harness.js` runs the REAL renderer in
Chromium (Playwright) against the REAL main.js and features, with a stand-in for Electron (windows, IPC, dialogs, safeStorage)
and a fake PTY. It works on Linux and Windows and needs no display. Run: `NODE_PATH=$(npm root -g) node tests/web/<name>.js`
(it needs the `playwright` package and its Chromium; it is not a project dependency). One launch() per process. Tests:

    tests/web/boot-smoke.js       boots, visits every tab and settings section, no page errors
    tests/web/features-smoke.js   agents, git, models, plugins, debug through IPC
    tests/web/editor-regress.js   ports of editor-live / editor-crlf / editor-reload (run after touching editor.js)
    tests/web/layout-regress.js   port of layout-scroll-smoke (the page never scrolls)
    tests/web/dock-gui.js         drag to dock, stacking, editor groups, save/restore layouts
    tests/web/panes-gui.js  team-gui.js  team-main.js  claude-gui.js  resources-gui.js
    tests/web/orchestra-gui.js    Orchestra tab + Trace panel: four models, filters, verify, export, approvals, stop
    tests/claude-unit.js  team-unit.js  resources-unit.js  comms-unit.js  cpu-tune-unit.js  orchestrator-unit.js  cli-unit.js
                                  plain Node, no browser. fake-models.js = four scripted models behind one fake Ollama.
    tests/orchestration-demo.js   prints a full multi-agent trace to the console (node tests/orchestration-demo.js)
    tests/web/run-all.js          runs everything above, one process per file

NOT covered by the harness: Electron itself (real window, zoom, native dialogs, real PowerShell PTY, GPU). Those still need the
Electron smoke tests below, run on Windows.

Electron pattern: copy `tests/core-scaffold.js`: an Electron script that `require`s main.js with a temp userData dir, drives
the renderer with `webContents.executeJavaScript`, and writes PASS/FAIL lines to a log file. Copy it to
`tests/<yourfeature>-smoke.js` and extend it. Run it with PowerShell, tracking ONLY the process you start:

    $env:FABER_ROOT = '<project root>'
    $p = Start-Process -FilePath "<root>\node_modules\electron\dist\electron.exe" -ArgumentList "`"<root>\tests\<name>-smoke.js`"" -PassThru
    # poll the log for DONE, print it
    $p.Kill($true)

Pitfalls learned the hard way:
- Electron's console.log is NOT visible in the shell: write results to a log file.
- NEVER `Stop-Process -Name electron/Faber` or `taskkill /IM`: the user may have their own Faber open. Kill only
  the PID you started (`$p.Kill($true)`). Do not use `taskkill` (the safety hook blocks it).
- Bash heredocs and `node -e "..."` mangle backslashes and `\n`. Create/modify files with the Write/Edit tools, not shell
  heredocs, whenever the content has backslashes, regexes or escapes.
- `node --check file.js` for every JS file you touch. Syntax-only checking is NOT a test.
- Use unique temp folders (`$env:TEMP\faber-<feature>-...`) and clean them up. Use a separate userData dir per run.
- Each test run needs ~10 seconds of startup; the app opens a window (it is fine).
- To look at the UI, you may serve renderer files with a mock `window.api` and use the browser preview tools.

## Final report format

Reply with: what you built (files), how to use it (UI + slash commands), what you tested and the PASS/FAIL results,
what is NOT done or limited, and any core change you need from the maintainer. Be honest about gaps.

## Regression tests (run these before you report; they must still pass)

    tests/core-scaffold.js   extension API, side tabs, commands, settings merge (14 checks)
    tests/editor-live.js     editor follows disk/AI changes, tree updates (9)
    tests/editor-crlf.js     CRLF files, conflict bar, saving keeps endings (9)
    tests/editor-reload.js   Reload button / F5 / Ctrl+R (10)

Run each like your own test, with a unique tag so parallel runs do not collide:
`$env:FABER_TAG = '<yourname>-1'` before Start-Process. The log is `$env:TEMP\faber-<test>-<tag>.log`; wait for DONE.
Delete your temp folders/logs afterwards.
