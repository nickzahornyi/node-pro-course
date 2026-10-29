#!/usr/bin/env bash
set -euo pipefail
npm run build
# exec keeps signals attached to the actual server; demo closes its own ephemeral listener in finally.
exec node dist/auth/demo.js "$1"
