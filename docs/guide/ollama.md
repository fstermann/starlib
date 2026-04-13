# Ollama Setup

Starlib can connect to a local [Ollama](https://ollama.com) instance for LLM-powered features like auto-editing metadata.

## 1. Install Ollama

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

After installing, start the server:

```bash
ollama serve
```

## 2. Pull a model

Starlib defaults to `gemma4:e2b` — a good balance of quality and speed for consumer hardware:

```bash
ollama pull gemma4:e2b
```

!!! tip "Alternative models"
    If you have more RAM/VRAM, `gemma4:e4b` (9.6 GB) produces better results. You can use any model installed in Ollama — check what's available with `ollama list`.

## 3. Connect in Starlib

Open **Settings > Ollama** in the app.

1. The **Server URL** defaults to `http://localhost:11434`. Change it only if you're running Ollama on a different host or port.
2. Click the :material-lightning-bolt: button to test the connection. The status dot turns green when Ollama is reachable.
3. Select your preferred model from the **Model** dropdown (populated automatically from your installed models).

Your settings are saved automatically and persist across sessions.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Status shows "Not reachable" | Make sure `ollama serve` is running. Check the URL matches where Ollama is listening. |
| No models in the dropdown | Pull a model first: `ollama pull gemma4:e2b` |
| Connection works locally but not on another machine | Ollama binds to `127.0.0.1` by default. Set `OLLAMA_HOST=0.0.0.0` when starting the server to allow remote connections. |

## API endpoints

For developers integrating with the Ollama backend:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ollama/status` | GET | Connection status and available model names |
| `/api/ollama/models` | GET | Installed models with size and digest |
| `/api/ollama/settings` | GET | Current Ollama configuration |
| `/api/ollama/settings` | POST | Update URL and/or selected model |
