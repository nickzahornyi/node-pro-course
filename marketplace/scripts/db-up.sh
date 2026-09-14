#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p secrets
if [ ! -f secrets/db_password ]; then
  cp db/db_password.example secrets/db_password
fi
chmod 700 secrets
chmod 644 secrets/db_password
docker compose up -d --wait db
