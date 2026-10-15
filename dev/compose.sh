#!/bin/sh
# Uruchamia "docker compose" albo "podman compose" - zależnie od tego, co jest dostępne.
set -e
cd "$(dirname "$0")/.."

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    exec docker compose "$@"
fi
if command -v podman >/dev/null 2>&1; then
    exec podman compose "$@"
fi
echo "Nie znaleziono 'docker compose' ani 'podman compose'." >&2
exit 1
