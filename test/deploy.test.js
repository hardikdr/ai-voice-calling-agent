import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('kind maps only the local control port into the named cluster node', async () => {
  const manifest = await read('deploy/kind-config.yaml');
  assert.match(manifest, /containerPort:\s*30080[\s\S]*hostPort:\s*8080/);
  assert.match(manifest, /listenAddress:\s*"127\.0\.0\.1"/);
  assert.doesNotMatch(manifest, /hostPort:\s*5050/);
});

test('deployment is non-root, probed, secret-backed, and persists run artifacts', async () => {
  const deployment = await read('deploy/deployment.yaml');
  assert.match(deployment, /namespace:\s*calling-agent/);
  assert.match(deployment, /name:\s*calling-agent/);
  assert.match(deployment, /containerPort:\s*8080/);
  assert.match(deployment, /containerPort:\s*5050/);
  assert.match(deployment, /runAsNonRoot:\s*true/);
  assert.match(deployment, /allowPrivilegeEscalation:\s*false/);
  assert.match(deployment, /readOnlyRootFilesystem:\s*true/);
  assert.match(deployment, /path:\s*\/healthz/);
  assert.match(deployment, /mountPath:\s*\/data\/runs/);
  assert.match(deployment, /secretKeyRef:[\s\S]*name:\s*calling-agent-secrets/);
  assert.match(deployment, /initContainers:[\s\S]*ca-certificates\.crt/);
  assert.match(deployment, /name:\s*prepare-run-storage[\s\S]*chown -R 10001:10001 \/data\/runs/);
  assert.match(deployment, /name:\s*SSL_CERT_FILE[\s\S]*\/etc\/ssl\/combined\/ca-certificates\.crt/);
  assert.match(deployment, /secretName:\s*calling-agent-custom-ca[\s\S]*optional:\s*true/);
  for (const name of ['TELEPHONY_PROVIDER', 'TELNYX_API_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_FROM_NUMBER', 'TELNYX_PUBLIC_KEY']) {
    assert.match(deployment, new RegExp(`name:\\s*${name}`));
  }
  assert.doesNotMatch(deployment, /sk-[A-Za-z0-9]|AC[a-fA-F0-9]{20}/);
});

test('service exposes UI through node port and keeps media internal to the pod service', async () => {
  const service = await read('deploy/service.yaml');
  assert.match(service, /type:\s*NodePort/);
  assert.match(service, /port:\s*8080[\s\S]*nodePort:\s*30080/);
  assert.match(service, /name:\s*media[\s\S]*port:\s*5050[\s\S]*targetPort:\s*media/);
  assert.doesNotMatch(service, /nodePort:\s*30505/);
});

test('workflow scripts are valid shell and scope destructive teardown to the exact cluster', async () => {
  for (const path of ['scripts/up.sh', 'scripts/down.sh', 'scripts/smoke.sh']) {
    execFileSync('sh', ['-n', new URL(`../${path}`, import.meta.url).pathname]);
  }
  const up = await read('scripts/up.sh');
  const down = await read('scripts/down.sh');
  assert.match(up, /CLUSTER_NAME="calling-agent"/);
  assert.match(up, /IMAGE="calling-agent:dev"/);
  assert.match(up, /kind load docker-image "\$IMAGE" --name "\$CLUSTER_NAME"/);
  assert.match(up, /rollout restart deployment\/calling-agent/);
  assert.match(up, /CUSTOM_CA_CERT_PATH/);
  assert.match(up, /calling-agent-custom-ca/);
  assert.match(up, /kubectl[^\n]*rollout status deployment\/calling-agent/);
  assert.doesNotMatch(up, /set -x/);
  assert.match(down, /kind delete cluster --name "\$CLUSTER_NAME"/);
});

test('container excludes local secrets and runs as an unprivileged application user', async () => {
  const dockerfile = await read('Dockerfile');
  const dockerignore = await read('.dockerignore');
  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /FROM cloudflare\/cloudflared:2026\.9\.1/);
  assert.match(dockerfile, /COPY --from=cloudflared/);
  assert.match(dockerfile, /USER app/);
  assert.match(dockerfile, /EXPOSE 8080 5050/);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^test\/$/m);
});
