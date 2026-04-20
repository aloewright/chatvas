# Video Studio (OpenMontage integration)

Chatvas ships with an optional Video Studio node powered by [OpenMontage](https://github.com/calesthio/OpenMontage). You describe a video in plain language, and an embedded Claude agent orchestrates OpenMontage's Python toolchain and Remotion composer to produce an MP4 inline in the node.

## End users (installed `.dmg` / `.AppImage` / `.exe`)

Zero prereqs. On first launch the app shows a one-time **"Video Studio setup"** overlay that:

1. Copies OpenMontage into your user data dir (`~/Library/Application Support/Chat Nodes Canvas/openmontage` on macOS).
2. Creates a Python venv from the bundled Python.
3. Installs OpenMontage's Python dependencies (5–10 min, depending on bandwidth).

When the overlay disappears, open the Settings drawer (⚙), paste `ANTHROPIC_API_KEY`, and start generating videos.

## Developers (running from the repo)

Only prereq: **Node 18+**. Python and FFmpeg are downloaded automatically by `npm install`.

```bash
git submodule update --init --recursive
npm install                # downloads Python + ffmpeg-static + ffprobe-static + composer deps (~400 MB)
npm run dev                # first-launch overlay runs bootstrap automatically; or run it up front:
npm run setup:video        # optional pre-bootstrap (same logic; skip if you're OK waiting for the UI)
npm run doctor             # verify runtime state
```

Open chatvas, click ⚙ in the toolbar, and paste at least `ANTHROPIC_API_KEY`. Add premium provider keys you want the agent to use — FAL_KEY, RUNWAY_API_KEY, HEYGEN_API_KEY, ELEVENLABS_API_KEY, SUNO_API_KEY — whichever apply.

Keys are encrypted with Electron's `safeStorage` and never leave the main process.

## Using it

1. Toolbar → **🎬 New Video**.
2. On the Prompt tab, type what you want: `"Make a 45-second animated explainer about why the sky is blue."` Optionally pick a pipeline (`animated-explainer`, `cinematic`, `documentary-montage`, `talking-head`, etc.) — leave on *auto* to let the agent choose.
3. Hit **Generate** (or Cmd/Ctrl+Enter).
4. The Stream tab shows the agent's tool calls, agent text, log output, and render progress as they happen.
5. When the agent calls `finalize`, the Output tab switches on and the MP4 plays inline.

## Branching

A Video Studio node can branch into another Video Studio node that inherits the parent's prompt and finalize summary:

- Run a job once.
- Click **Branch with alternate style**.
- In the new node, enter the directive — e.g. *"same script but cinematic live-action instead of animated"*.
- The new agent job reads the parent's workspace (scripts, plans, assets) via whitelisted `read_file` access, so it can reuse work rather than starting from zero.

## Artifacts & cache

Rendered videos live at `<userData>/renders/<jobId>/` with `out.mp4`, `manifest.json`, `events.ndjson`, and a `workspace/` scratch dir. The Settings drawer has a quota control — default 20 GB, oldest-first eviction.

## How it works

- **Agent loop**: Electron main process runs `@anthropic-ai/claude-agent-sdk` (`src/main/video-agent.js`). Tools registered via `createSdkMcpServer` give the agent access to OpenMontage's Python tools, skill markdown, pipeline YAML, and Remotion rendering.
- **Python bridge**: `vendor/OpenMontage-adapter/run_tool.py` is a persistent stdin/stdout JSON-lines process per job. It imports `tools.tool_registry` and dispatches invocations uniformly (`src/main/python-bridge.js`).
- **System prompt**: constructed from `vendor/OpenMontage/AGENT_GUIDE.md`, `PROJECT_CONTEXT.md`, and the selected `pipeline_defs/<id>.yaml` so the agent behaves identically to a Claude Code session opened inside OpenMontage.
- **Remotion rendering**: shelled out via `npx remotion render` from `vendor/OpenMontage/remotion-composer/`. Progress percentages stream back to the UI.

## Troubleshooting

Run `npm run doctor` or open the Settings drawer — the system-check panel explains which step is broken. Common issues:

- **Bundled Python missing** — run `npm install` (the postinstall step downloads a [python-build-standalone](https://github.com/astral-sh/python-build-standalone) tarball into `vendor/python-runtime/`). If that failed, run `npm run install:python` directly.
- **Bundled ffmpeg missing** — `npm install` pulls `ffmpeg-static` and `ffprobe-static`. Reinstall if those folders are empty.
- **Bootstrap incomplete** — re-run `npm run setup:video`. Safe to run multiple times.
- **Python venv broken** — `rm -rf vendor/OpenMontage/.venv` and re-run setup.
- **Anthropic rate limit** — switch to Sonnet in Settings → Orchestrator model.
- **Secure storage unavailable (Linux)** — Settings shows a warning if the OS keyring (gnome-keyring/kwallet) is absent. Install one, or keys will be written in plaintext under `<userData>/secrets.json`.
