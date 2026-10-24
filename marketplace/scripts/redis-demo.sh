#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  cache|session|ratelimit|queue) ;;
  *) echo 'Expected cache, session, ratelimit or queue' >&2; exit 1 ;;
esac
npm run build
exec node "dist/redis/demo-$1.js"
