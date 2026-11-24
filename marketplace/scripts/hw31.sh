#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PULUMI_HOME="$PWD/.pulumi/hw31-home"
export PULUMI_BACKEND_URL="file://$PWD/.pulumi/hw31-state"
# Public local-only passphrase; no production secrets exist in these stacks.
export PULUMI_CONFIG_PASSPHRASE="hw31-local-only"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
unset AWS_PROFILE AWS_SESSION_TOKEN AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
export HW31_SKIP_BUDGET=1
mkdir -p "$PULUMI_HOME" "${PULUMI_BACKEND_URL#file://}"
action="${1:?action}"; stack="${2:-base}"
case "$stack" in base|demo) ;; *) exit 2;; esac
case "$action" in
 start) exec docker compose -f infra/hw31-compose.yml up -d --wait ;;
 stop) exec docker compose -f infra/hw31-compose.yml down ;;
 evidence) exec node demo/hw31-evidence.mjs ;;
 iam) exec bash demo/hw31-iam.sh ;;
 verify) exec bash demo/hw31-verify.sh ;;
esac
pulumi stack select "$stack" --cwd "infra/$stack" --create --non-interactive >/dev/null
case "$action" in
 up) exec pulumi up --cwd "infra/$stack" --stack "$stack" --yes --non-interactive --skip-preview ;;
 preview) exec pulumi preview --cwd "infra/$stack" --stack "$stack" --non-interactive --diff ;;
 export) exec pulumi stack export --cwd "infra/$stack" --stack "$stack" ;;
 outputs) exec pulumi stack output --cwd "infra/$stack" --stack "$stack" --json ;;
 destroy) exec pulumi destroy --cwd "infra/$stack" --stack "$stack" --yes --non-interactive ;;
 *) echo "Unknown action: $action" >&2; exit 2 ;;
esac
