#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${IMAGE:=marketplace:hw28}"
: "${NPM_TOKEN_FILE:=$PWD/.npm_token}"
[ -s "$NPM_TOKEN_FILE" ] || { echo "NPM_TOKEN_FILE missing: create .npm_token as shown in Grading" >&2; exit 1; }
DOCKER_BUILDKIT=1 docker build "$@" --secret "id=npm_token,src=$NPM_TOKEN_FILE" -f docker/Dockerfile -t "$IMAGE" .
