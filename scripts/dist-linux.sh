#!/usr/bin/env bash
# Build Linux AppImage + deb packages via Docker (electronuserland/builder).
# Prerequisites: Docker Desktop running.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm \
  -v "${PROJECT_DIR}":/project \
  -v 6502-emulator-linux-modules:/project/node_modules \
  -v "${HOME}/.cache/electron":/root/.cache/electron \
  -v "${HOME}/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder \
  bash -c "cd /project && npm ci && npm run build && npx electron-builder --linux"
