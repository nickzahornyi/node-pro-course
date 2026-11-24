#!/usr/bin/env bash
set -euo pipefail
mkdir -p evidence/hw31
npm run check --prefix infra/base
npm run check --prefix infra/demo
# Idempotent, dedicated stack lifecycle. Always attempt cleanup on failure.
cleanup() {
  local result=$?
  trap - EXIT
  bash scripts/hw31.sh destroy demo > evidence/hw31/destroy-demo.txt 2>&1 || result=1
  bash scripts/hw31.sh destroy base > evidence/hw31/destroy-base.txt 2>&1 || result=1
  if ! node demo/hw31-teardown.mjs; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
bash scripts/hw31.sh start
bash scripts/hw31.sh up base 2>&1 | tee evidence/hw31/up-base.txt
bash scripts/hw31.sh evidence
bash scripts/hw31.sh iam
bash scripts/hw31.sh preview demo 2>&1 | tee evidence/hw31/preview-demo.txt
grep -q 'aws:rds/instance:Instance' evidence/hw31/preview-demo.txt
set +e
bash scripts/hw31.sh up demo > evidence/hw31/501.txt 2>&1
status=$?
set -e
cat evidence/hw31/501.txt
if [ "$status" -eq 0 ]; then echo 'Expected unsupported-service error, but demo succeeded' >&2; exit 1; fi
grep -q 'StatusCode: 501' evidence/hw31/501.txt
grep -Eq 'not included within your LocalStack license|not included in your current license plan' evidence/hw31/501.txt
for action in failover nat alb; do node "demo/$action.mjs"; done
