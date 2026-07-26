# AI providers

Starlib uses an LLM for its AI-powered features (metadata clean-up, suggestions). You choose which provider backs them under **Settings > AI**.

| Provider | Runs | Needs |
|----------|------|-------|
| **Ollama** | Locally, offline | A local [Ollama](https://ollama.com) install |
| **Claude Code** | Locally, via the CLI | The [Claude Code](https://claude.com/claude-code) CLI on your `PATH` |
| **Anthropic API** | Anthropic's servers | An Anthropic API key |

Pick one with the **Provider** toggle at the top of the section. Each provider keeps its own settings, so switching back and forth doesn't lose your configuration.

## Ollama

Local inference — nothing leaves your machine.

### 1. Install Ollama

=== "macOS"

    ```bash
    brew install ollama
    ```

=== "Linux"

    ```bash
    curl -fsSL https://ollama.com/install.sh | sh
    ```

=== "Windows"

    Download the installer from [ollama.com/download](https://ollama.com/download).

If Starlib can't find Ollama, the AI section shows an **Install Ollama** link instead of the connection controls.

### 2. Pull a model

Starlib defaults to `gemma4:e2b` — a good balance of quality and speed for consumer hardware:

```bash
ollama pull gemma4:e2b
```

!!! tip "Alternative models"
    If you have more RAM/VRAM, `gemma4:e4b` (9.6 GB) produces better results. You can use any model installed in Ollama — check what's available with `ollama list`.

### 3. Connect

1. The **Server URL** defaults to `http://localhost:11434`. Change it only if you're running Ollama on a different host or port.
2. Click the :material-lightning-bolt: button to test the connection — Starlib starts the local server for you if it isn't already running. The status dot turns green when Ollama is reachable, amber when it's installed but stopped, and red when it isn't installed.
3. Select your preferred model from the **Model** dropdown (populated automatically from your installed models).

You can stop the server again from the same panel.

## Claude Code

Uses the Claude Code CLI already installed on your machine, so it piggybacks on your existing Claude subscription — no API key to manage.

Starlib detects the CLI automatically and shows **Claude Code CLI detected** when it's available; otherwise it offers an install link. Pick the model (defaults to `haiku`) from the dropdown.

## Anthropic API

Calls the Anthropic API directly. Paste an **Anthropic API key** into the field and save — the key goes to your OS credential store, not a config file. Once a key is saved, choose a model from the dropdown (defaults to Claude Haiku 4.5).

Remove the key with the delete button to disconnect.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Ollama status shows "Not reachable" | Click the test-connection button — Starlib tries to start the server. If that fails, run `ollama serve` manually and check the URL matches where Ollama is listening. |
| No models in the Ollama dropdown | Pull a model first: `ollama pull gemma4:e2b` |
| Ollama works locally but not from another machine | Ollama binds to `127.0.0.1` by default. Set `OLLAMA_HOST=0.0.0.0` when starting the server to allow remote connections. |
| Claude Code shows "not installed" | Make sure the `claude` binary is on your `PATH`, then reopen Settings. |

## API endpoints

For developers integrating with the AI backend — all providers share one set of endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ai/status` | GET | Readiness of the active provider |
| `/api/ai/models` | GET | Models offered by the active provider |
| `/api/ai/settings` | GET | Current AI configuration (all providers + selection) |
| `/api/ai/settings` | POST | Update the provider selection or any provider's settings |
| `/api/ai/ollama/start` | POST | Start the local Ollama server |
| `/api/ai/ollama/stop` | POST | Stop the local Ollama server |
| `/api/ai/anthropic/credentials` | POST | Store the Anthropic API key |
| `/api/ai/anthropic/credentials` | DELETE | Remove the stored key |
