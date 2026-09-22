#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh scripts/prepare-secret.sh
docker compose --profile api up --build -d --wait
