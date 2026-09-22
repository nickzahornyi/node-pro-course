#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# The grading/CI runner already supplied configuration in the environment.
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"
if [ -f "$CREDS" ]; then
  set -a
  source "$CREDS"
  set +a
fi
command -v infisical >/dev/null 2>&1 || { echo 'Install Infisical CLI; see README. CI may use SKIP_VAULT=1.' >&2; exit 1; }
: "${INFISICAL_PROJECT_ID:?Set INFISICAL_PROJECT_ID in .secrets/infisical.env or environment}"
exec infisical run --projectId="$INFISICAL_PROJECT_ID" --env="$ENV_SLUG" -- "$@"
