#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p secrets
chmod 700 secrets
# An existing (possibly rotated) secret must never be overwritten.
if [ ! -e secrets/db_password ]; then
  (umask 022; cp -n db/db_password.example secrets/db_password)
fi
chmod 644 secrets/db_password
