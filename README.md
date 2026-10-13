# Faber

Offline, local-only coding assistant. Dark theme, purple accent. Runs Qwen 3.5 9B on your own PC through Ollama.

## Install (users)
1. Install Ollama (https://ollama.com/download) or `winget install Ollama.Ollama`.
2. Run `Faber Setup 0.1.0.exe`.
On first launch Faber starts Ollama if needed and downloads the model into it once, with a progress screen.
After that the app itself runs offline.

## Using it
- Open a folder in the sidebar. The AI can only read/edit files inside it. Click a file to open it in the editor (Ctrl+S saves).
- Reload (header button, F5 or Ctrl+R): re-reads every open file and the file tree from disk. The editor also updates on its own when the AI or a terminal program changes a file.
- Terminal (Ctrl+`): a real PowerShell, anywhere on your PC. Run claude, python, vim, ssh, anything interactive. Multiple tabs.
- Bottom bar: model, effort and permission menus. Type / for commands.
- Layout: drag the title of the Chat, Editor or Terminal panel onto the edge of another panel to dock it there, or onto its middle to stack them as tabs. Drag the thin dividers to resize. View > Split Editor (Ctrl+\\) opens a second editor on the same files. View > Save Layout As... / Saved Layouts / Reset Layout. The layout is remembered.
- Split chats: Split (header) or `/split columns|rows|grid|focus` shows every agent in its own pane with its own input and a live activity line. "Broadcast" sends one message to all of them.
- Team: the Team tab runs several agents on one task. A lead plans, coders and reviewers work from a shared board, files are claimed so two agents never edit the same one, and there are round limits, Stop, Pause, checkpoints and a final summary.
- Models > Resources: live CPU / RAM / GPU meters, what Ollama has loaded, and an advisor that says whether (and how) a model fits, with GPU layers / threads / context controls. Be realistic: an 8 GB graphics card and 15 GB RAM run 9B models well, 14B-30B slowly, and cannot run 70B+ models such as an 80B.
- **Talk to the orchestrator** (Orchestra tab, Chat): tell it how many agents you want and it creates them. "Create 4 agents", "I want 2 coders, a tester and a reviewer", "add a researcher", "use qwen3.5:4b for the coders", "remove coder2", "undo". Then give it a task ("build a snake game in snake.js") and it plans it and runs it with that team, reporting in the conversation; or talk to one agent ("ask coder1 to ..."). The team commands are understood by rules, not by a model, so they are instant and work offline. The same chat is in the terminal: `node tools/orchestra-cli.js chat --dir <folder>`.
- Orchestra: a conductor model plans a task and hands the steps to specialist agents, each on its own model (a code model for the coder, a different one for the reviewer, the smallest installed model as the fast helper). Every message between them is recorded word for word in the **Trace** panel (View > Agent Trace), tamper-evident, exportable.
- Faster on a CPU: Models > Resources > "Run it fast on the CPU" shows the best thread count, context size, keep-alive and Ollama environment settings for a model, and can benchmark and auto-tune on your PC.
- Command line: `node tools/orchestra-cli.js run "<task>" --dir <folder>` (prints the whole trace in the terminal), `roster`, `tune --model <m> --autotune`, `bench --models a,b`, `verify <trace.jsonl>` (checks a saved trace was not altered).
- What was measured with real models on a real CPU, and what failed along the way: [docs/REAL-MODEL-RESULTS.md](docs/REAL-MODEL-RESULTS.md). Short version: Ollama's defaults were already about as fast as the tuned profile on that machine; the orchestrator checks the agents' work against the tool log instead of trusting what small models say.
- Claude (online, optional): Settings > Claude (online). You enter your own Anthropic API key (stored encrypted with your Windows account), turn it on, and pick a Claude model. It is off by default and off again at every start; while on, an amber ONLINE indicator is always visible because your prompts and the file contents the AI reads then leave this PC.

## Build the installer (developers)
    npm install
    npm run dist        # -> dist/Faber Setup 0.1.0.exe

## Dev run
    npm start

## Notes
- Programs you run in the terminal can use the internet; only Faber's own window is locked offline.
- If Ollama says the model needs a newer version: `winget upgrade Ollama.Ollama`.
- Login is off; set REQUIRE_LOGIN = true in main.js to enable the offline login.
