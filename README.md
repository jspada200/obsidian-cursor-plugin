# Cursor Agent (Obsidian plugin)

## NOTE: This plugin is in early development so bugs are sure to be found! Keep this in mind and if you encounter any issues, please let me know here: https://github.com/jspada200/obsidian-cursor-plugin/issues 🙏

<p align="center">
  <img src="assets/demo.gif" alt="Cursor Agent Obsidian Plugin Demo" width="700"/>
</p>


This plugin is aimed at **[Cursor](https://cursor.com) subscribers** who already use Cursor and want the **same vault-scoped assistant inside [Obsidian](https://obsidian.md)**—so your notes stay in Obsidian while the **Cursor CLI** (`agent`) runs against the vault root as its workspace.

It connects Obsidian to Cursor’s Agent through **ACP** (stdio JSON-RPC): **Ask**, **Plan**, and **Agent** modes, streaming replies, permission prompts when tools run, and optional plan / multiple-choice dialogs when the Agent requests them.

## What you get

- **Vault as workspace** — Every session uses your Obsidian vault folder as `--workspace`, so paths and edits line up with your notes.
- **Session tabs** — Multiple chats; tab metadata can persist across restarts (message history is kept in memory for the current session).
- **Context** — Each send can include open tabs, outbound links from the active note, and paths you `@`-mention (search by path/name or `#tag`).
- **Modes & model** — Dropdowns for mode (agent / plan / ask) and model. Models are loaded by running **`agent models`** (fallback: **`agent --list-models`**); each option stores only the **model id** (the part before ` - `), which is what gets passed as **`--model`** to the CLI.
- **Agent log file** — Optional append-only **`cursor-agent.log`** next to the plugin (spawn command, ACP RPC summaries, stderr, session/update stream events). Toggle under **Settings → Cursor Agent → Diagnostics log**. Command palette: **Reveal Cursor Agent log file**.

Log path: `<Vault>/.obsidian/plugins/obsidian-cursor-plugin/cursor-agent.log` (same folder as `main.js`). Large logs rotate automatically.


## Like what I am doing?

<a href="https://www.buymeacoffee.com/spadjv" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Requirements

- **Obsidian** desktop (this plugin is **desktop-only**; see `manifest.json`).
- **Cursor Agent CLI** installed and on your `PATH`, or configured in plugin settings (default install location is often `~/.local/bin/agent`).
- A **Cursor account / subscription** that includes access to **Cursor Agent via the CLI** — authenticate once with `agent login` (see [Cursor CLI docs](https://cursor.com/docs/cli)).

Exact CLI availability and pricing are defined by Cursor; if `agent` cannot log in or run models, check your Cursor account and CLI status first.

## User setup

1. Install the Cursor CLI using Cursor’s installation instructions (`curl … | bash` or their current installer).
2. In a terminal, run **`agent login`** and complete authentication.
3. Confirm the binary exists, e.g. `~/.local/bin/agent` or `which agent`.

Manual installation:

1. Copy or symlink this plugin folder into your vault:

   `<Vault>/.obsidian/plugins/obsidian-cursor-plugin/`

   That folder must contain at least **`main.js`**, **`manifest.json`**, and **`styles.css`** (build first; see below).

2. In Obsidian: **Settings → Community plugins → Safe mode off** → enable **Cursor Agent**.

3. Optional: **Settings → Cursor Agent** — set binary path, defaults, trust (`--trust`), context toggles, and whether to write **`cursor-agent.log`** for debugging.

Open the chat from the ribbon (**message** icon) or the command palette: **Open Cursor Agent chat**.

## Development setup

```bash
git clone <repository-url>
cd obsidian-cursor-plugin
npm install
```

- **Production build** (minified `main.js`):

  ```bash
  npm run build
  ```

- **Watch mode** (rebuild on change while you hack):

  ```bash
  npm run dev
  ```

Point Obsidian at this folder under `.obsidian/plugins/obsidian-cursor-plugin/` (symlink is fine). Reload Obsidian after builds when not using watch.

Typecheck only:

```bash
npx tsc -noEmit -skipLibCheck
```

## Troubleshooting

- **`agent: command not found` in Terminal** — The installer often puts the binary at `~/.local/bin/agent`, which may not be on your shell `PATH`. Either add that directory to `PATH` in `~/.zshrc`, or log in with the full path:  
  `~/.local/bin/agent login`  
  In the plugin, set **Agent binary path** to that full path (the default is already `~/.local/bin/agent` expanded to an absolute path, which does **not** rely on `PATH`).
- **`agent` not found / ENOENT from the plugin** — Confirm the file exists and is executable; use **Settings → Cursor Agent → Verify binary**. Rebuild after changing the path.
- **Auth / subscription errors** — Run `~/.local/bin/agent login` (or your installed path). Use non-interactive auth only if Cursor documents it for your account.
- **“ACP” / JSON-RPC errors** — Open **Developer Tools** and check the console for `[Cursor Agent]` and `[cursor-agent stderr]`. Error notices now include recent CLI stderr when available.
- **Sessions after restart** — Persisted tab rows may reference old server session IDs; sending a message may create a new session if the CLI process restarted.


## Current limitations
- No plan mode
- No multiple-choice dialogs when context needs refinement

## License

MIT (see `package.json`).
