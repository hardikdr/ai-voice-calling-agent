#!/bin/sh
set -eu

CLUSTER_NAME="calling-agent"

if ! command -v kind >/dev/null 2>&1; then
  echo "Missing required command: kind" >&2
  exit 1
fi

if kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  kind delete cluster --name "$CLUSTER_NAME"
  echo "Deleted kind cluster: $CLUSTER_NAME"
else
  echo "Kind cluster does not exist: $CLUSTER_NAME"
fi
