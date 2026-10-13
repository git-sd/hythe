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

## Build the installer (developers)
    npm install
    npm run dist        # -> dist/Faber Setup 0.1.0.exe

## Dev run
    npm start

## Notes
- Programs you run in the terminal can use the internet; only Faber's own window is locked offline.
- If Ollama says the model needs a newer version: `winget upgrade Ollama.Ollama`.
- Login is off; set REQUIRE_LOGIN = true in main.js to enable the offline login.
