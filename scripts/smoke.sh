#!/bin/sh
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
CONTEXT="kind-calling-agent"
NAMESPACE="calling-agent"
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT HUP INT TERM

attempt=0
until curl --silent --show-error --fail "$BASE_URL/healthz" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Health check did not become ready" >&2
    kubectl --context "$CONTEXT" --namespace "$NAMESPACE" logs deployment/calling-agent --tail=100 >&2 || true
    exit 1
  fi
  sleep 2
done

curl --silent --show-error --fail \
  -H 'content-type: application/json' \
  --data-binary @calls/test.example.json \
  "$BASE_URL/api/calls" >"$RESPONSE_FILE"
RUN_ID="$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!value.runId) process.exit(1); process.stdout.write(value.runId)' "$RESPONSE_FILE")"

attempt=0
while [ "$attempt" -lt 60 ]; do
  curl --silent --show-error --fail "$BASE_URL/api/calls/$RUN_ID" >"$RESPONSE_FILE"
  STATUS="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).status)' "$RESPONSE_FILE")"
  if [ "$STATUS" = "completed" ]; then
    node -e 'const fs=require("fs"); const run=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Array.isArray(run.transcript)||run.transcript.length<2||!run.summary) process.exit(1)' "$RESPONSE_FILE"
    echo "Smoke test passed for run $RUN_ID"
    exit 0
  fi
  if [ "$STATUS" = "failed" ] || [ "$STATUS" = "cancelled" ]; then
    echo "Smoke run ended unexpectedly with status: $STATUS" >&2
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

kubectl --context "$CONTEXT" --namespace "$NAMESPACE" logs deployment/calling-agent --tail=100 >&2 || true
exit 1
