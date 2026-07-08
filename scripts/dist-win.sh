#!/usr/bin/env bash
# Build Windows NSIS installer (x64) on macOS using native Wine.
# Prerequisites: Wine, electron-builder.
# The macOS @serialport/bindings-cpp build is removed first so electron-builder
# picks up the pre-built win32-x64 binary from the serialport package instead.
set -euo pipefail

rm -rf node_modules/@serialport/bindings-cpp/build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --config.npmRebuild=false
