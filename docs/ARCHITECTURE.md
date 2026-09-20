# Calling Agent Architecture

The application is a browser-controlled outbound voice agent isolated inside a
local kind cluster. Twilio provides the telephone leg, while OpenAI Realtime
provides the conversational audio leg. A temporary public tunnel exposes only
the media/callback server required by Twilio.

## Component architecture

```mermaid
flowchart LR
    User["Operator<br/>local browser"]
    Phone["Authorized recipient<br/>telephone"]

    subgraph Mac["Developer Mac"]
        UIMap["Loopback mapping<br/>127.0.0.1:8080"]
        MediaForward["Temporary port-forward<br/>127.0.0.1:5051"]

        subgraph Kind["kind cluster: calling-agent"]
            subgraph Namespace["namespace: calling-agent"]
                Control["Control UI + API<br/>Fastify :8080"]
                Provider["Telephony adapter<br/>Twilio / Telnyx"]
                Media["Signed media + callbacks<br/>Fastify :5050"]
                Realtime["OpenAI Realtime bridge"]
                Store[("RunStore<br/>text JSON only")]
                Secret["Kubernetes Secret<br/>credentials + public URL"]

                Control --> Provider
                Control --> Store
                Provider --> Media
                Media --> Realtime
                Media --> Store
                Secret -. runtime configuration .-> Control
                Secret -. runtime configuration .-> Provider
                Secret -. runtime configuration .-> Realtime
            end
        end
    end

    Tunnel["localhost.run<br/>temporary HTTPS/WSS tunnel"]
    Twilio["Twilio Programmable Voice"]
    OpenAI["OpenAI Realtime API"]

    User -->|"HTTP: call brief / status"| UIMap
    UIMap --> Control
    Provider -->|"REST: create / end call"| Twilio
    Twilio <-->|"PSTN audio"| Phone
    Twilio -->|"signed status callback"| Tunnel
    Twilio <-->|"signed bidirectional WebSocket"| Tunnel
    Tunnel --> MediaForward
    MediaForward --> Media
    Realtime <-->|"realtime audio + events"| OpenAI

    classDef local fill:#e8f4ff,stroke:#1976d2,color:#0d2a45;
    classDef external fill:#fff4df,stroke:#d98200,color:#4a2b00;
    classDef data fill:#eaf8ec,stroke:#288a3e,color:#123d1e;
    class User,UIMap,MediaForward,Control,Provider,Media,Realtime,Secret local;
    class Phone,Tunnel,Twilio,OpenAI external;
    class Store data;
```

## Successful call flow

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    participant UI as Local browser
    participant App as Control API
    participant TP as Twilio adapter
    participant Twilio
    actor Recipient
    participant Media as Media server
    participant AI as OpenAI Realtime
    participant Store as RunStore

    Operator->>UI: Submit authorized call brief
    UI->>App: POST /api/calls
    App->>Store: Persist dialing run
    App->>TP: Start call with guarded prompt
    TP->>Twilio: Create call with inline TwiML
    Twilio-->>TP: Provider call ID
    TP-->>App: Call accepted
    Twilio->>Recipient: Dial verified destination
    Recipient-->>Twilio: Answer
    Twilio->>Media: Signed status callback
    Twilio->>Media: Open signed WSS Media Stream
    Media->>AI: Attach realtime audio transport
    AI-->>Media: AI audio and transcript events
    Media-->>Twilio: AI audio frames
    Twilio-->>Recipient: Play assistant audio
    Media->>Store: Persist transcript/status/summary
    App-->>UI: Stream current public state
    UI-->>Operator: Show status and transcript
    Recipient-->>Twilio: Hang up
    Twilio->>Media: Completed callback
    Media->>AI: Close realtime session
    Media->>Store: Persist terminal result
```

## Trust boundaries and controls

| Boundary | Control |
| --- | --- |
| Browser to control API | Permanently exposed only on Mac loopback |
| Provider to media server | Twilio request-signature validation or Telnyx Ed25519 validation |
| Media session lookup | Cryptographically random per-call URL token |
| Pod execution | Application container uses non-root UID/GID `10001`, runtime-default seccomp, dropped capabilities, and a read-only root filesystem. A constrained root init container has only `CHOWN`/`FOWNER` to prepare the PVC. |
| Credentials | Kubernetes Secret references; never returned by the UI or stored in run JSON |
| Persistence | Text artifacts only on a dedicated `128Mi` PVC; no audio recording |
| Public ingress | Temporary and limited to the media server; remove by stopping the tunnel |
| Call authority | Strict JSON schema, explicit allowed actions/disclosures, one active call, bounded duration |

## Runtime separation

The control and media listeners run in the same pod but on different ports and
with different exposure rules:

- Port `8080` serves the local UI, call-control API, state stream, downloads,
  and readiness endpoint.
- Port `5050` accepts provider media WebSockets, signed lifecycle callbacks,
  and a minimal health endpoint.
- The public tunnel targets only port `5050`; it does not expose the browser
  control panel.

This split keeps dialing authority local while giving the telephony provider
the smallest public surface required for realtime media.
