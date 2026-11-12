#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$PWD/.pulumi}"
case "$PULUMI_BACKEND_URL" in file:///*) ;; *) echo 'PULUMI_BACKEND_URL must be an absolute file:// URL' >&2; exit 1;; esac
: "${PULUMI_CONFIG_PASSPHRASE:?PULUMI_CONFIG_PASSPHRASE is required}"
mkdir -p "${PULUMI_BACKEND_URL#file://}"
pulumi login "$PULUMI_BACKEND_URL" --non-interactive >/dev/null
pulumi stack select dev --cwd infra --create --non-interactive >/dev/null
case "$1" in
 up) pulumi up --cwd infra --yes --non-interactive --skip-preview ;;
 destroy) pulumi destroy --cwd infra --yes --non-interactive ;;
 *) exit 2 ;;
esac
