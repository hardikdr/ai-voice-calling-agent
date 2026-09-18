#!/bin/sh
set -eu

CLUSTER_NAME="calling-agent"
CONTEXT="kind-$CLUSTER_NAME"
NAMESPACE="calling-agent"
IMAGE="calling-agent:dev"

for command_name in docker kind kubectl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if ! kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --config deploy/kind-config.yaml
fi

docker build --tag "$IMAGE" .
kind load docker-image "$IMAGE" --name "$CLUSTER_NAME"

kubectl --context "$CONTEXT" apply -f deploy/namespace.yaml
if [ -f .env ]; then
  kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic calling-agent-secrets \
    --from-env-file=.env --dry-run=client -o yaml \
    | kubectl --context "$CONTEXT" apply -f -
else
  kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic calling-agent-secrets \
    --from-literal=CONFIGURED=false --dry-run=client -o yaml \
    | kubectl --context "$CONTEXT" apply -f -
fi

CA_CERT_PATH="${CUSTOM_CA_CERT_PATH:-}"
if [ -z "$CA_CERT_PATH" ] && [ -f .certs/custom-ca.pem ]; then
  CA_CERT_PATH=.certs/custom-ca.pem
fi
if [ -n "$CA_CERT_PATH" ]; then
  if [ ! -r "$CA_CERT_PATH" ]; then
    echo "Custom CA certificate is not readable: $CA_CERT_PATH" >&2
    exit 1
  fi
  kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic calling-agent-custom-ca \
    --from-file="custom-ca.pem=$CA_CERT_PATH" --dry-run=client -o yaml \
    | kubectl --context "$CONTEXT" apply -f -
else
  kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic calling-agent-custom-ca \
    --from-literal=CONFIGURED=false --dry-run=client -o yaml \
    | kubectl --context "$CONTEXT" apply -f -
fi

kubectl --context "$CONTEXT" apply -f deploy/storage.yaml
kubectl --context "$CONTEXT" apply -f deploy/deployment.yaml
kubectl --context "$CONTEXT" apply -f deploy/service.yaml
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" rollout restart deployment/calling-agent
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" rollout status deployment/calling-agent --timeout=180s

echo "Calling Agent is ready at http://localhost:8080"
