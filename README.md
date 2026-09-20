# Calling Agent

A browser-controlled outbound AI calling prototype that runs inside a dedicated local kind cluster. The browser sends a strict JSON call brief to the pod; the pod places the Twilio call, bridges bidirectional phone audio to OpenAI Realtime, and returns lifecycle updates, transcript text, and a short summary.

The default is a deterministic dry run. No audio is recorded or stored.

## Safety boundary

- Call only recipients who have explicitly agreed to receive the test call.
- The agent must disclose in its first sentence that it is an AI/digital assistant calling on the user's behalf.
- Unknown instruction fields are rejected. The prompt separately lists permitted disclosure, permitted actions, and actions requiring confirmation.
- Only one call may be active at a time, with a default ten-minute maximum.
- The service persists transcript/run JSON under `/data/runs`; it does not persist audio, credentials, media tokens, or the assembled system prompt.
- You are responsible for German and destination-country calling, privacy, consent, identification, and data-protection requirements. This prototype is not legal advice.

## Architecture

See [the detailed architecture and call-flow diagrams](./docs/ARCHITECTURE.md)
and [the verified local configuration snapshot](./docs/WORKING_CONFIGURATION.md).

```text
Browser on localhost:8080
        |
        v
kind / calling-agent namespace
  +-------------------------------+
  | control API + UI              |
  | Twilio Media Streams listener |<----- approved HTTPS/WSS tunnel <----- Twilio
  | OpenAI Realtime bridge        |--------------------------------------> OpenAI
  | /data/runs (text only)        |
  +-------------------------------+
```

Only `127.0.0.1:8080` is mapped from the kind node to the Mac. Port `5050` remains internal; cloudflared (or `PUBLIC_MEDIA_URL`) is used only for Twilio's signed WebSocket and status-callback traffic.

## Prerequisites

- Docker Desktop
- `kind`
- `kubectl`
- Node.js 22 or newer for local tests and the smoke script
- `curl`
- For real calls: OpenAI API access, an upgraded Twilio account, a Twilio caller number, and an authorized destination

Twilio trial Voice accounts strip the `<Stream>` verb used by this application. Upgrade the account before attempting a real call. Twilio's current trial documentation lists `<Stream>` among blocked verbs: <https://www.twilio.com/docs/usage/trials/try-out-voice#blocked-verbs>.

## Start the isolated environment

```bash
make up
make smoke
```

Open <http://localhost:8080>. The checked-in example has `dry_run: true`, so it needs no credentials and does not dial its example number.

Useful commands:

```bash
make logs
make smoke
make down
```

`make down` deletes only the kind cluster named `calling-agent`. Its disposable local persistent volume disappears with that cluster.

## Browser workflow

1. Leave `dry_run` set to `true` and select **Start call**.
2. Confirm the UI progresses through dialing, connected, transcript, and completed summary states.
3. Edit the JSON brief. Phone numbers must use E.164 format, such as `+4930123456`.
4. Use **End call** to cancel an active run or **Download run** to save the public JSON artifact.

The authority fields have distinct meanings:

- `facts_agent_may_disclose`: information the agent is allowed to reveal.
- `actions_agent_may_take`: actions it may complete without another decision.
- `actions_requiring_confirmation`: actions it must not complete until the human user confirms.
- `allowed_times` / `forbidden_times`: natural-language timing constraints included in the guarded prompt.

## Enable real calls

Copy the template and populate it locally. Do not paste credentials into chat or commit `.env`.

```bash
cp .env.example .env
```

Required values:

```dotenv
OPENAI_API_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+49...
```

Then rerun `make up` so the Kubernetes Secret and pod are refreshed. Check readiness:

```bash
curl http://localhost:8080/healthz
```

A real call is enabled only when `realCallReady` is `true`. Before changing `dry_run` to `false`, use a harmless objective and a controlled destination whose owner has explicitly authorized the call.

## Public media URL and corporate networks

By default, the pod tries to create a temporary `trycloudflare.com` Quick Tunnel. Cloudflare documents Quick Tunnels as development-only, with no uptime guarantee: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>.

Some WARP, Cisco Umbrella, or other Zero Trust egress policies block `api.trycloudflare.com`. In that case dry-run remains healthy, while `/healthz` reports `mediaTunnelReady: false`. Use one of these options:

1. Ask the network administrator to permit Cloudflare Tunnel egress.
2. Put an approved, stable HTTPS reverse tunnel in front of pod port `5050` and set `PUBLIC_MEDIA_URL` in `.env`.
3. If TLS interception is approved, place the organization's public root CA at `.certs/custom-ca.pem`, or run `CUSTOM_CA_CERT_PATH=/absolute/path/to/root.pem make up`. The certificate is loaded as a Kubernetes Secret and appended to the pod trust bundle; it is not copied into the image or Git.

Never disable TLS verification. Twilio requires a `wss://` Media Streams endpoint.

## Troubleshooting

### UI does not open

```bash
kind get clusters
kubectl --context kind-calling-agent -n calling-agent get pods
make logs
```

The cluster name must be `calling-agent`, and the pod should be `1/1 Running`.

### `mediaTunnelReady` is false

Inspect `make logs`. A Cisco/OpenDNS block page or `tls: handshake failure` usually means the corporate egress policy blocks Quick Tunnels. Use an approved `PUBLIC_MEDIA_URL`; adding a CA only fixes trust and does not bypass an explicit block policy.

### Real-call request returns 503

At least one credential is missing, the tunnel is unavailable, or the pod has not been recreated since `.env` changed. Run `make up`, then inspect `/healthz` again.

### Twilio answers but does not stream audio

- Confirm the Twilio account is upgraded; trial accounts block `<Stream>`.
- Confirm the public URL is reachable as secure WebSocket (`wss`).
- Review Twilio Voice logs and the pod logs.
- Ensure the destination and caller ID are valid for the selected German route.

## Development

```bash
npm ci
npm test
```

The tests use injected transports and never make a phone call or contact OpenAI/Twilio. See [COST.md](./COST.md) before enabling a real call.
