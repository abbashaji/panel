#!/usr/bin/env bash
# Runs inside the work checkout before each acceptance command (trusted copy from main).
set -e
npm ci --no-audit --no-fund
if [ -f web/package.json ]; then npm --prefix web install --no-audit --no-fund; fi
