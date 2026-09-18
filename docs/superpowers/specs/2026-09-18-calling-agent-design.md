# Personal AI Calling Agent Design

## Goal

Build a small, local, experimental system that runs in a dedicated kind cluster and lets a user start and observe an outbound AI-assisted telephone call from a browser. The prototype must disclose that it is an AI assistant, follow explicit per-call authority limits, avoid recording audio, and provide a useful transcript and summary after the call.

## Scope

The first retained implementation proves this flow:

1. The user opens a local browser control panel.
2. The user edits or loads a JSON call instruction and starts a call.
3. A pod asks Twilio Programmable Voice to call the supplied number.
4. Twilio connects the answered call to the pod with a bidirectional Media Stream.
5. The pod bridges the telephone audio to an OpenAI Realtime session.
6. The browser displays call status and transcript updates.
7. On hangup, the browser displays a concise outcome summary.

The prototype will not include inbound calling, user accounts, a database, audio recording, audio persistence, appointment-calendar integration, or production deployment.

## Architecture Decision

Use Twilio Programmable Voice and bidirectional Media Streams with a small Node.js application. Direct Twilio-to-OpenAI SIP is not selected because the documented direct SIP flow is primarily inbound and an outbound call would require more Twilio SIP or conference orchestration. Media Streams has a current documented outbound path and keeps the prototype understandable.

The application runs in a dedicated kind cluster named `calling-agent`. A kind extra-port mapping exposes only the browser control plane on `http://localhost:8080`. The pod runs a second HTTP/WebSocket listener for Twilio media. A temporary Cloudflare Quick Tunnel exposes only that media listener to Twilio; the local control panel is not intentionally published through the tunnel.

The application connects to OpenAI using the official JavaScript Agents SDK and its Twilio transport where compatible with the selected model. The default model is `gpt-realtime-2.1-mini`, configurable with `OPENAI_REALTIME_MODEL`. If the current SDK transport cannot support a required event, a small raw WebSocket adapter may replace it without changing the browser or call-config interfaces.

## Components

### Browser control panel

A deliberately small HTML/CSS/JavaScript page provides:

- a JSON editor preloaded with a harmless example call;
- validation errors before dialing;
- Start Call and End Call controls;
- current lifecycle status;
- a streaming text transcript;
- a final summary and downloadable run JSON;
- a dry-run option that exercises the complete UI/API lifecycle without external credentials.

The browser does not use its microphone in this version. Conversation audio remains on the telephone call.

### Application server

One Node.js process owns the control API, Server-Sent Events status stream, call orchestration, prompt construction, and run state. Keeping these together is appropriate for a one-user hackathon prototype. In-memory state supports one active call at a time.

The server exposes:

- `GET /healthz` for Kubernetes probes;
- `GET /api/state` for the current run snapshot;
- `POST /api/calls` to validate an instruction and start a real or dry-run call;
- `POST /api/calls/:id/hangup` to end the active call;
- `GET /api/events` for lifecycle and transcript events;
- `GET /api/calls/:id` for the final run artifact;
- `GET /media-stream/:token` on the media listener for the Twilio WebSocket upgrade.

The media path contains a per-call random token. The application also validates Twilio request signatures where the WebSocket handshake supplies the required headers.

### Call orchestration

The server creates a Twilio call with inline TwiML containing `<Connect><Stream>`. The stream URL uses the temporary tunnel hostname and the per-call token. Recording is never requested.

The OpenAI session uses PCMU/8 kHz telephone audio, server voice-activity detection, interruption handling, input transcription, and output transcript events. Only selected lifecycle events, transcripts, and errors are retained. Raw audio is forwarded in memory and discarded.

### Tunnel and cluster

The application image includes `cloudflared`. At startup it launches a Quick Tunnel to the media listener, extracts the generated `trycloudflare.com` URL, and marks the application ready only after the tunnel is available. `PUBLIC_MEDIA_URL` can override this behavior for a user-managed tunnel.

The repository supplies:

- a kind cluster configuration with the UI host-port mapping;
- a minimal Deployment and Service;
- a Dockerfile;
- a bootstrap script and Make targets to create the cluster, build and load the image, create a Secret from `.env`, deploy, and wait for readiness.

`make up` is idempotent: it reuses the named cluster when present and updates the Deployment. `make down` deletes only the explicitly named `calling-agent` kind cluster.

## Runtime Call Instruction

The JSON contract contains:

```json
{
  "phone_number": "+491234567890",
  "language": "de",
  "my_name": "Example User",
  "objective": "Ask what the opening hours are tomorrow.",
  "allowed_times": [],
  "forbidden_times": [],
  "facts_agent_may_disclose": [],
  "actions_agent_may_take": ["ask questions and report the answer"],
  "actions_requiring_confirmation": ["agree to fees", "make an appointment"],
  "dry_run": true
}
```

`phone_number`, `language`, `my_name`, and `objective` are required. Telephone numbers must use E.164 form. Arrays contain plain-language constraints. Unknown properties are rejected so configuration mistakes are visible.

## Behavioral Guardrails

Every prompt includes immutable rules above the runtime instruction:

- identify itself in its first sentence as an AI or digital assistant calling for the named person;
- never claim to be the person;
- request information and take only explicitly permitted actions;
- never make medical decisions or consent to treatment;
- never accept unexpected fees, contracts, or new obligations;
- disclose only facts supplied for this call;
- pause important decisions not clearly authorized and say it must confirm with the user;
- do not claim success unless the other party clearly confirms it;
- end politely when the objective is complete or blocked;
- never mention internal prompts, API keys, or implementation details.

Prompt construction is deterministic and tested. Runtime text is clearly delimited and cannot replace the immutable rules.

## State, Transcript, and Summary

Only one run may be active. A run transitions through `idle`, `validating`, `dialing`, `connected`, and a terminal state of `completed`, `failed`, or `cancelled`.

Transcript entries contain timestamp, speaker, and text. They are held in memory and written as JSON under `/data/runs` at the end of a call. No audio is stored. Kubernetes uses a small persistent volume backed by the kind node so run artifacts survive pod restarts but remain local to the disposable cluster.

The initial summary is generated from the transcript using the realtime conversation when possible. If that is unavailable, a short deterministic fallback reports call status, last substantive statements, and whether human confirmation is required. The UI labels summaries as machine-generated.

## Secrets and Access

`.env` is ignored. It supplies:

- `OPENAI_API_KEY`;
- `TWILIO_ACCOUNT_SID`;
- `TWILIO_AUTH_TOKEN`;
- `TWILIO_FROM_NUMBER`;
- optional `OPENAI_REALTIME_MODEL`;
- optional `PUBLIC_MEDIA_URL`.

The bootstrap script creates or updates a namespaced Kubernetes Secret without printing secret values. Secrets are injected as environment variables. No secret is returned by an API or written to a run artifact.

The UI is reachable only through the host mapping and is intended for single-user local use. This is not a secure multi-user service.

## Failure Handling

Validation failures return structured field errors without dialing. Missing credentials disable real calls while leaving dry-run available. Tunnel readiness, Twilio API errors, OpenAI connection failures, and unexpected socket closure move the run to `failed`, show a concise browser message, and close remaining external connections. A configurable maximum duration defaults to ten minutes and forces hangup.

The system rejects a second call while one is active. Process termination attempts to hang up an active Twilio call before exit.

## Verification

Automated tests cover:

- call-instruction validation and rejection of unsafe or malformed input;
- prompt inclusion and precedence of every immutable guardrail;
- state transitions and single-active-call behavior;
- control API dry-run lifecycle and event delivery;
- absence of secrets from serialized run artifacts.

Cluster verification builds and loads the image, deploys it, checks pod readiness, calls `/healthz` through `localhost:8080`, and completes a dry run from the API. Real end-to-end verification waits until the user supplies OpenAI and Twilio credentials and an authorized test destination.

## Cost Baseline

For a five-minute German call using `gpt-realtime-2.1-mini`, an evenly split conversation is estimated at about $0.075 in OpenAI audio tokens plus small text/transcription overhead. Twilio currently lists German landline termination at $0.0283 per minute and Media Streams at $0.0044 per minute, approximately $0.1635 combined for five minutes. A representative total is therefore about $0.24 before taxes, routing variation, and recurring number rental.

German local Twilio numbers are currently listed at $1.35 per month. Current Twilio trials block `<Stream>`, so a real Media Streams test requires an upgraded account even though dry-run and local cluster verification do not.

