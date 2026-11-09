#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="${KIND_CLUSTER_NAME:-hw28}"
case "$1" in
 up)
   if ! kind get clusters | grep -qx "$name"; then
     kind create cluster --name "$name" --image kindest/node:v1.35.0 --config k8s/kind-config.yaml --wait 120s
   fi
   docker image inspect postgres:17-alpine >/dev/null 2>&1 || docker pull postgres:17-alpine
   kind load docker-image --name "$name" "${IMAGE:-marketplace:hw28}" postgres:17-alpine
   ;;
 down) kind delete cluster --name "$name" ;;
 *) exit 2 ;;
esac
