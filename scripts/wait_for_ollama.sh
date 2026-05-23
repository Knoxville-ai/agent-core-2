#!/usr/bin/env bash
# Wait for Ollama to be ready, then pull the model if not already present.
set -euo pipefail

OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:4b}"
MAX_WAIT=120
INTERVAL=2

echo "Waiting for Ollama to be ready..."
elapsed=0
while ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do
    if (( elapsed >= MAX_WAIT )); then
        echo "ERROR: Ollama did not start within ${MAX_WAIT}s" >&2
        exit 1
    fi
    sleep "$INTERVAL"
    elapsed=$((elapsed + INTERVAL))
done
echo "Ollama is ready (waited ${elapsed}s)"

# Pull extraction model if not already present
if ! ollama list | grep -q "$OLLAMA_MODEL"; then
    echo "Pulling extraction model $OLLAMA_MODEL ..."
    ollama pull "$OLLAMA_MODEL"
    echo "Model $OLLAMA_MODEL pulled successfully"
else
    echo "Extraction model $OLLAMA_MODEL already present"
fi

# When Ollama is the agent chat provider, also pull the chat model
if [[ "${LLM_PROVIDER:-}" == "ollama" ]]; then
    CHAT_MODEL="${LLM_MODEL:-$OLLAMA_MODEL}"
    if [[ "$CHAT_MODEL" != "$OLLAMA_MODEL" ]]; then
        if ! ollama list | grep -q "$CHAT_MODEL"; then
            echo "Pulling chat model $CHAT_MODEL ..."
            ollama pull "$CHAT_MODEL"
            echo "Chat model $CHAT_MODEL pulled successfully"
        else
            echo "Chat model $CHAT_MODEL already present"
        fi
    fi
fi
