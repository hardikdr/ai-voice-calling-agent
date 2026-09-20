# Working Local Configuration Snapshot

Captured on **2026-09-20 at 17:38 UTC** after a successful end-to-end
Twilio/OpenAI test call. This snapshot is intentionally safe to keep in Git: it
contains configuration names and topology, but no credentials, phone numbers,
provider identifiers, transcript text, or active tunnel hostname.

## Verified outcome

| Check | Result |
| --- | --- |
| Browser control panel | Reachable at `http://localhost:8080` |
| Kubernetes workload | `1/1` available, zero container restarts |
| Dry-run readiness | `true` |
| Public media-tunnel readiness | `true` |
| Real-call readiness | `true` |
| Twilio primary compliance profile | `twilio-approved` |
| Outbound provider call | Provider call ID recorded |
| Realtime conversation | 36 transcript events recorded |
| Final application error | None |

The run was ended from the application and therefore has the terminal status
`cancelled`; it nevertheless connected successfully, streamed realtime audio,
and produced transcript and summary data.

## Effective topology

| Setting | Working value |
| --- | --- |
| kind cluster | `calling-agent` |
| kubectl context | `kind-calling-agent` |
| namespace | `calling-agent` |
| deployment | `calling-agent`, one replica |
| container image | `calling-agent:dev` |
| telephony provider | `twilio` |
| OpenAI realtime model | `gpt-realtime-2.1-mini` |
| UI inside pod | TCP `8080` |
| Media server inside pod | TCP `5050` |
| Mac UI exposure | `127.0.0.1:8080` through kind NodePort `30080` |
| Mac media forward | `127.0.0.1:5051` to service `calling-agent-media:5050` |
| Public ingress | Temporary `localhost.run` HTTPS/WSS tunnel to port `5051` |
| Run persistence | `calling-agent-runs` PVC, `128Mi`, text JSON only |

The temporary tunnel hostname is deliberately not recorded. Anonymous
`localhost.run` hostnames expire and must be treated as runtime state rather
than durable configuration.

## Local toolchain observed

| Tool | Version |
| --- | --- |
| Node.js | `v25.8.1` (the application requires Node.js 22 or newer) |
| npm | `11.11.0` |
| Docker client/server | `28.0.1` |
| kind | `v0.22.0` |
| kubectl client | `v1.29.3` |

## Secret inventory

The Kubernetes Secret is named `calling-agent-secrets`. The working Twilio
path requires these keys:

- `TELEPHONY_PROVIDER=twilio`
- `OPENAI_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `PUBLIC_MEDIA_URL`

Never commit the values. `.env`, `.certs/`, and runtime data are ignored by
Git. The destination phone number is supplied in the browser call brief and is
not a deployment secret.

The same image also supports the optional Telnyx adapter. Its inactive secret
keys are documented in `.env.example`; they are not needed for this verified
Twilio configuration.

## Recreate the working deployment

1. Export the required private values in the current shell, or place them in a
   local `.env` file.
2. Run `make up` to create/update the kind cluster, image, manifests, and
   Kubernetes Secret.
3. If the built-in Cloudflare Quick Tunnel is blocked, establish the two-hop
   `localhost.run` path:

   ```bash
   kubectl --context kind-calling-agent -n calling-agent \
     port-forward service/calling-agent-media 5051:5050

   ssh -o ServerAliveInterval=15 \
     -o ServerAliveCountMax=6 \
     -o TCPKeepAlive=yes \
     -o ExitOnForwardFailure=yes \
     -o StrictHostKeyChecking=accept-new \
     -R 80:localhost:5051 nokey@localhost.run
   ```

4. Copy the new HTTPS hostname printed by `localhost.run` into
   `PUBLIC_MEDIA_URL`, refresh `calling-agent-secrets`, and restart the
   deployment. Keep both foreground commands running for the duration of the
   call.
5. Verify readiness before dialing:

   ```bash
   curl http://localhost:8080/healthz
   curl "$PUBLIC_MEDIA_URL/healthz"
   ```

   Expected local response:

   ```json
   {
     "ok": true,
     "dryRunReady": true,
     "mediaTunnelReady": true,
     "realCallReady": true
   }
   ```

6. Open `http://localhost:8080`, use an authorized E.164 destination, set
   `dry_run` to `false`, and start the call.

## Operational notes

- Restarting the pod invalidates an active `kubectl port-forward`; start that
  forward again before testing the public tunnel.
- An anonymous `localhost.run` hostname may expire even while an old SSH
  process appears alive. A response containing `no tunnel here` means a new
  hostname is required.
- Twilio rejects dialing before producing a call ID when its primary
  compliance profile is not approved.
- Twilio webhook requests are signature-validated. Media sessions also use
  random, per-call bearer tokens in their paths.
- Only the UI is bound permanently to the Mac loopback interface. The media
  service remains a ClusterIP and is exposed temporarily for a test.
- No audio is stored. The PVC stores run metadata, transcript text, status,
  and summary JSON.

## Shut down exposure

Stop the SSH tunnel and `kubectl port-forward` processes with `Ctrl-C` in their
respective terminals. The kind cluster may remain running for later local use.
Run `make down` only when the cluster and its local run history are no longer
needed.
