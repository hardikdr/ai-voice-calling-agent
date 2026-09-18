# Cost notes

Rates checked on **2026-09-18**. Provider pricing, taxes, carrier routing, exchange rates, free-unit policies, and model aliases can change; verify the linked pages immediately before a paid test.

## OpenAI Realtime

The default model is `gpt-realtime-2.1-mini`. Its official model page lists these per-one-million-token rates:

| Modality | Input | Cached input | Output |
|---|---:|---:|---:|
| Text | $0.60 | $0.06 | $2.40 |
| Audio | $10.00 | $0.30 | $20.00 |

Source: <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>

A common rough conversion for Realtime phone audio is about 600 input audio tokens per minute of user speech and 1,200 output audio tokens per minute of synthesized agent speech. At the rates above, that is approximately:

- Audio input: **$0.006 per spoken minute**
- Audio output: **$0.024 per spoken minute**

Actual usage depends on speech/silence handling, interruptions, cached context, prompt length, transcript text, and reasoning/tool activity. Treat these as planning estimates, not billing guarantees.

## Twilio Germany

Twilio's Germany page was current as of August 2026 and lists:

| Item | Rate |
|---|---:|
| Germany landline outbound | $0.0283/min |
| Germany mobile from EEA route | $0.0420/min |
| Other/generic Germany mobile routes | up to $0.3763/min |
| Media Streams | $0.0044/min |
| German local number | $1.35/month |
| German mobile number | $30.00/month |

Source: <https://www.twilio.com/en-us/voice/pricing/de>

The route matters enormously: Twilio's detailed table distinguishes EEA-origin mobile routes from generic Germany mobile routes. Confirm the console's destination and caller-ID route before dialing. Taxes are not included in these examples.

Twilio trial Voice accounts block the `<Stream>` verb. The upgraded-account free-unit table currently includes 30 Media Streams minutes, but confirm the account's tracker rather than assuming a zero charge: <https://www.twilio.com/docs/usage/trials>.

## Representative five-minute call

Assumption: a five-minute call with roughly 2.5 minutes of human speech and 2.5 minutes of agent speech.

OpenAI estimate:

```text
input  = 2.5 min × $0.006 = $0.015
output = 2.5 min × $0.024 = $0.060
OpenAI subtotal           = $0.075
```

Twilio Media Streams:

```text
5 min × $0.0044 = $0.022
```

Estimated totals, excluding number rental, taxes, and small text-token usage:

| Destination route | Voice | Stream | OpenAI | Five-minute total |
|---|---:|---:|---:|---:|
| Germany landline | $0.1415 | $0.0220 | $0.0750 | **$0.2385** |
| Germany mobile, EEA route | $0.2100 | $0.0220 | $0.0750 | **$0.3070** |
| Germany mobile, generic high route | $1.8815 | $0.0220 | $0.0750 | **$1.9785** |

A deliberately conservative envelope that bills five full minutes of both audio input and output is $0.15 for OpenAI audio. With Media Streams, that yields approximately $0.3135 for landline, $0.3820 for the EEA mobile route, or $2.0535 for the high mobile route.

No call recording, Twilio transcription, Answering Machine Detection, Conversation Relay, or branded calling is enabled by this application, so those add-ons are not included.
