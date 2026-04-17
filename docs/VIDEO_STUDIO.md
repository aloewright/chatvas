# Video Studio (OpenMontage integration)

Chatvas ships with an optional Video Studio node powered by [OpenMontage](https://github.com/calesthio/OpenMontage). You describe a video in plain language, and an embedded Claude agent orchestrates OpenMontage's Python toolchain and Remotion composer to produce an MP4 inline in the node.

## One-time setup

Prereqs on your machine: **Python 3.10+, FFmpeg, Node 18+**. On macOS:
```
brew install python@3.11 ffmpeg node
```

Then from the chatvas repo:

```bash
git submodule update --init --recursive
npm install
npm run setup:video      # creates vendor/OpenMontage/.venv, installs Python + Remotion deps (~5-10 min)
npm run doctor           # verify everything is green
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

- **ffmpeg not found** — install via your package manager and re-run `npm run doctor`.
- **bootstrap incomplete** — re-run `npm run setup:video`. Safe to run multiple times.
- **Python venv broken** — `rm -rf vendor/OpenMontage/.venv` and re-run setup.
- **Anthropic rate limit** — switch to Sonnet in Settings → Orchestrator model.
