# AsterFi Integration Guide

This guide covers the two ways an outside application connects to AsterFi:

1. **Webhooks**: AsterFi POSTs call events (ringing, answered, ended, and more) to your URL as they happen.
2. **REST API**: your app calls AsterFi to read users, call history, and voicemail, and to start click-to-call.

Both are set up by an AsterFi administrator under **Settings → Webhooks & API**.

---

## 1. Setup checklist

| Step | Where | Result |
|---|---|---|
| Create an API key | Settings → Webhooks & API → API keys → **Create key** | A key that starts with `afk_`. It is shown **once**, so copy it right away. |
| Create a webhook | Settings → Webhooks & API → **Add Webhook** | Enter your URL, pick events (`call.*` covers all call events) and Save. The webhook stays open and shows its **Signing secret**. |
| Get the signing secret later | Click the webhook in the list → **Signing secret** (Settings tab, also on the Verifying requests tab) | Copy button next to it. **Rotate secret** issues a new one. |
| Send a test | Open the webhook → **Send test** | Sends a `webhook.test` event to your URL. |

**Network requirements**

- **Webhooks** go *out* from AsterFi. AsterFi needs outbound HTTPS to your URL. Nothing has to be opened inbound.
- **The REST API** (only needed if you use it) comes *in* to AsterFi at `https://<asterfi-host>/api/v1`. A cloud-hosted app can't reach a private LAN address such as `192.0.2.10`. Expose AsterFi through one of these:
  - a reverse proxy or port forward that allows only your app's IPs,
  - a VPN or tunnel (WireGuard, Tailscale, Cloudflare Tunnel),
  - a small agent on the LAN that relays requests.
- AsterFi ships with a **self-signed certificate**. Install a real certificate (recommended), or pin or trust the self-signed one in your client. Don't turn off TLS verification everywhere.

---

## 2. Webhooks

### 2.1 Request format

Every delivery is an HTTP `POST` with a JSON body:

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: AsterFi-Webhooks/1.0
X-AsterFi-Event: call.answered
X-AsterFi-Delivery: 4812
X-AsterFi-Signature: t=1761676543,v1=5f2a...c9

{
  "id": "4812",
  "event": "call.answered",
  "timestamp": "2026-10-28T18:35:43.477Z",
  "data": { ... }
}
```

- `id` / `X-AsterFi-Delivery` identifies the delivery. Use it to drop duplicates, because a retry reuses the same id.
- `data.id` is the **call id**. It stays the same across every event for that call (`call.inbound` → `call.ringing` → `call.answered` → `call.ended`), so use it as your call's unique key.

### 2.2 Verifying the signature

`X-AsterFi-Signature` has the form `t=<unix seconds>,v1=<hex>`, where:

```
v1 = HMAC_SHA256(secret, "<t>.<raw request body>")
```

Check it against the **raw body bytes**, before you parse the JSON. Reject the request if the signature doesn't match, or if `t` is more than 5 minutes from your clock.

**Node.js**

```js
import crypto from 'node:crypto';

function verifyAsterFi(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1 || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

**PHP**

```php
function verify_asterfi(string $raw, string $header, string $secret): bool {
  parse_str(str_replace(',', '&', $header), $p);
  $t = (int)($p['t'] ?? 0);
  if (!$t || abs(time() - $t) > 300) return false;
  return hash_equals(hash_hmac('sha256', "$t.$raw", $secret), $p['v1'] ?? '');
}
```

### 2.3 Responding, retries, ordering

- Return any **2xx** status within **10 seconds**. Do slow work after you respond, for example by putting it on a queue.
- A non-2xx response or a timeout is retried after **30s, 2m, 10m, 30m, and 2h**. After 6 attempts the delivery is marked failed. Admins can see each attempt and resend it from the webhook's **Deliveries** tab.
- Retries can make events arrive **out of order**. Order them by `timestamp` and by the call's lifecycle. For example, never let a late `call.ringing` overwrite a call you've already marked ended.

### 2.4 Call events

All call events share this `data` shape (the call summary):

| Field | Type | Notes |
|---|---|---|
| `id` | string | Call id, the same for every event on this call |
| `direction` | `inbound` \| `outbound` \| `internal` | |
| `from` / `fromName` | string | Caller number and caller ID name |
| `to` | string | Number or extension dialed |
| `did` | string \| null | Your phone number the call came in on (inbound only) |
| `startedAt` / `answeredAt` | ISO time | `answeredAt` is null until the call is answered |
| `answeredBy` | string \| null | Extension that answered |
| `state` | `ringing` \| `talking` | |

| Event | When | Extra fields |
|---|---|---|
| `call.inbound` | An outside call arrives on one of your numbers | `numberName` (the label of the number dialed) |
| `call.outbound` | A user dials an outside number | |
| `call.ringing` | A user's phone starts ringing. Sent once per phone. | `extension`, `user {id, extension, name, email}` |
| `call.answered` | The call is answered | `user` (who answered) |
| `call.queued` | A caller starts waiting in a ring group queue | |
| `call.callback` | A caller in a queue pressed 2 to ask for a callback | |
| `call.missed` | Sent once for each user who missed the call | `callId`, `extension`, `user`, `from`, `fromName`, `did`, `at` |
| `call.ended` | The call finished. Carries the **full call record**. | `status`, `endedAt`, `duration`, `talkSeconds`, `missedExtensions`, `voicemailId`, `trunk`, `path` |

`call.ended` `status` values: `answered`, `missed` (rang users but nobody answered), `voicemail`, `busy`, `abandoned` (the caller hung up before anyone answered).

Other events you can subscribe to: `voicemail.new`, `voicemail.transcribed`, `ivr.keypress`, `phone.registered`, `phone.unregistered`, `user.dnd`, `trunk.registration`. Wildcards work: `call.*` or `*`.

`voicemail.transcribed` follows `voicemail.new` once the server has turned the message into text (usually a few seconds; see Settings → General → Voicemail transcription). Its data is `{ id, mailbox, transcript }`, where `id` matches `voicemail.new`. If transcription failed, `transcript` is `null` and `error` says so; an empty string means the message had no speech.

### 2.5 Example: an inbound call "screen pop"

Subscribe to `call.inbound`, `call.answered`, and `call.ended`, then:

1. **`call.inbound`**: look up `data.from` in your CRM and show a ringing card keyed by `data.id`. If you only follow some of your numbers, filter on `data.did`.
2. **`call.answered`**: mark the card answered by `data.answeredBy` or `data.user`.
3. **`call.ended`**: close the card and log `duration`, `talkSeconds`, and `status`.

To show which phones are ringing, also subscribe to `call.ringing`.

---

## 3. REST API

Base URL: `https://<asterfi-host>/api/v1`
Authentication header on every request: `Authorization: Bearer afk_...`

### 3.1 Endpoints

| Method & path | Returns |
|---|---|
| `GET /users` | `[{ id, extension, firstName, lastName, name, email }]` |
| `GET /users/:extension` | One user |
| `GET /calls` | Call history, newest first. Filters: `since`, `until` (ISO), `number` (matches from/to on the last 10 digits), `extension`, `status`, `direction`, `limit` (max 1000), `offset` |
| `GET /calls/active` | Calls in progress right now |
| `GET /calls/:id` | One call, including its step-by-step `path` |
| `GET /voicemail?mailbox=1001` | Voicemail messages (metadata), each with `transcript` and `transcriptStatus` (`pending`, `done`, `failed`, or `null` if never transcribed) |
| `POST /calls` | Click-to-call (section 3.2). `202` with `{ callId, extension, number }` |

Example: every call with one customer number:

```bash
curl -H "Authorization: Bearer $ASTERFI_KEY" \
  "https://asterfi.example.com/api/v1/calls?number=8605551234"
```

### 3.2 Click-to-call

`POST /calls` with a JSON body `{ "extension": "1001", "number": "8605551234" }` places a call for a user:

1. AsterFi rings every phone signed in as that extension (desk phones, softphones and the web phone) for up to 30 seconds. The phone's screen shows **Calling 8605551234**.
2. When the user picks up, AsterFi dials the number from that user, through the normal outbound routes and with their outbound caller ID. An extension number rings that coworker instead.

```bash
curl -X POST -H "Authorization: Bearer $ASTERFI_KEY" -H "content-type: application/json" \
  -d '{"extension":"1001","number":"8605551234"}' \
  "https://asterfi.example.com/api/v1/calls"
```

The reply comes back as soon as the user's phones start ringing. Its `callId` is the call's id: it sends the usual `call.*` webhooks (`call.outbound`, `call.answered`, `call.ended`) and appears at `GET /calls/:id` once it ends. Its path starts with a `click-to-call` step. If the user doesn't pick up, the call ends with status `abandoned`.

| Status | Meaning |
|---|---|
| `202` | The user's phones are ringing |
| `400` | `number` is missing, or is the user's own extension |
| `404` | No user has that extension |
| `409` | No phone is signed in as that extension, so there's nothing to ring |

Only digits and a leading `+` are used from `number`, so feature codes such as `*97` can't be dialed this way.

---

## 4. Security notes

- Keep the API key and webhook secret on your server. Never put them in browser or mobile code.
- An API key can read every user's call history and voicemail list, and can place outside calls as any user (click-to-call). Treat it like a password, and delete it under Settings → Webhooks & API if it leaks.
- Always verify webhook signatures. Only expose `/api/v1` to the networks or IPs that need it.
