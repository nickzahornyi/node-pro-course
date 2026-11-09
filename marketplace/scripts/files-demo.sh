#!/usr/bin/env bash
set -euo pipefail
npm run build
exec node dist/files/demo.js "$@"
