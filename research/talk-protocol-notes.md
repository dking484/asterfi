# UniFi Talk device protocol — reverse-engineered from the console's Talk app

Source: the user's own UniFi console, app at `/usr/share/unifi-talk/app/server.js`
(Node 24, webpack-bundled; a copy is saved beside this file as `unifi-talk-server.js`).
FreeSWITCH is the console's SIP/media backend (the `/data/unifi-talk` dir is group `freeswitch`).

## Ports (from the bundle's config object)
- `inform_http_port: 3417` — POST `/device/inform` (Express). Binary TNBU inform. **POST only** (that's why our WS GET there 404'd).
- `ws_ucp_port: 3416` — the **device WebSocket** ("UCP"), a SEPARATE mutual-TLS HTTPS server. This is the real device channel.
- `http_port: 3423`, `stun_port: 3421`, `internal_sip_port` (SIP registrar port for devices), `discovery_port: 10001`.
- `external_pbx_hostname` / `external_talk_hostname` — the host the device uses for SIP + WS.

## Device WebSocket (port 3416) — auth
- Mutual TLS: server `requestCert:true, rejectUnauthorized:false`. Device presents a client cert; its
  fingerprint256 (`cfp`) is bound to the device row on FIRST connect (trust-on-first-use), then required to match.
- `Authorization: Basic <n>` where **n = auth_key_digest = SHA-512(auth_key)** (hex). Lookup: `device_discovery where auth_key_digest = n`. On first connect also checks `auth_key_digest === n` and stores `cfp`, sets `ucp4=true`. Fail → `401`.
- NOTE: AsterFi does NOT need to replicate 3416/mutual-TLS. The phone already speaks the SAME message protocol to AsterFi's plain WS on 8080 `/device/inform` (it prefers the WS; AsterFi accepts it, so it uses it). AsterFi can keep accepting the WS on 8080 and just needs to SEND the right messages.

## Message framing (confirmed both from captures and the bundle)
A WS message = 1+ parts, each: `[type u8][flags u8=01][len u48 BE][JSON]`. type1=envelope, type2=payload.
Envelope: `{id, type:'request'|'event'|'response', timestamp, action?|name?}`. Controller parses to `{header:{name}, body}`.
Phone→controller seen: request `create_contacts {contacts:[]}`, event `device_metadata {firmware_version, serial_number, ip_address}`.
Requests carry an id and want a response msg with the same id. (talkws.js in AsterFi already encodes/decodes this.)

## Message dispatcher (controller handling device requests) — message `name`/`type` values
device_metadata, create_contacts, get_voicemail_recording, get_voicemail_transcription, get_contacts_status,
get_contacts_backup, get_call_metadata, get_wallpaper_gallery, get_ringtone_list, unlock_door,
get_sms_messages, get_sms_events, ... (and controller→device types below).

## Provisioning (controller → device) — THE KEY PART
Driven by a `cmd_queue` table. When a device is adopted/assigned, the controller enqueues commands:
`add(mac,"config")`, `add(mac,"contacts")`, `add(mac,"call_log",...)`, `add(mac,"user_profile_update")`.
Each queued cmd is built into a device message with a `_type` and sent over the WS.

### The "config" message (what makes the phone register SIP) — `_type:"config"` (body `$`):
```
$.profiles = [{
  id, first_name, last_name,
  can_start_intercom_calls, can_start_group_intercom_calls, can_handle_external_parked_calls,
  avatar, call_timeout: 999, install_region, country_code,
  numbers: [{type:"extension", number: <ext>}, {type:"did", number: <did>}],
  group_numbers: [...],
  sip: { host: <external_pbx_hostname>, port: <internal_sip_port>, user: <ext>, password: <sip_password>, transport: "udp" },
  last_updated: <ms>,
  line2?: { ...same shape for a 2nd account... }
}]
$.system_cfg = [            // newline-joined string, for lower-level/uvpg2 firmware
  "# unifi", "unifi.version=5.9.29", "unifi.idp=enabled", "unifi.mcip=239.254.127.63",
  "unifi.key=<...>", "mgmt.ubic.env=stage",
  "# system", "system.timezone=<tz>", "locale.timezone=<tz>",
  "# users", "users.1.name=admin", "users.1.password=<device_ssh_password>", "users.1.status=enabled",
  "users.2.name=nobody", "users.2.password=x", "users.2.shell=/bin/false", "users.2.status=enabled",
  "# uvpg2 sip config",
  "sip_hostname=<external_pbx_hostname>", "sip_username=<ext>", "sip_password=<sip_password>", "sip_auth_username=<ext>",
  // optional line 2: sip_hostname_2/sip_username_2/sip_password_2/sip_auth_username_2
  "sip_outbound_proxy=", "sip_transport_type=udp"
].join("\n")+"\n"
```
Other controller→device `_type`s: `contacts {contacts:[...]}`, `show_message {data}`, `max_rc_ver_filter`,
`parking_lots`, `parked_calls`, `freeswitch_entering_reconfiguration`/`exiting`, `forget` (delete), `noop`.

### SIP account = the assigned user's `ext` + `sip_password` (from `public.user`), registering to `external_pbx_hostname:internal_sip_port` over UDP.

## What AsterFi must do to natively provision the phone (implementation plan)
1. Keep accepting the phone's WS on 8080 `/device/inform` (already works). Auth: accept `Basic sha512(authkey)`.
2. Answer the phone's requests (create_contacts → {}, device_metadata → store) — already does.
3. When the phone's user is assigned, SEND a `config` message: build `profiles[0].sip = {host: <AsterFi/Asterisk IP>, port: 5060, user: <ext>, password: <that user's SIP password>, transport:"udp"}` and the matching `system_cfg` sip_* lines. Use AsterFi's existing user ext + sip_password (Users → Phone Setup).
4. The phone registers SIP to Asterisk as <ext> and works like any other extension (desk/web phones already do this).
5. Later: contacts, call_log, presence, call control messages for full parity.

Open detail: exact envelope `name` the controller uses when SENDING config (the body carries `_type:"config"`; the outer header `name` is likely "config"/"message" — confirm from the send path / the phone's handler). Start by sending `_type:"config"` as the payload with an event-style envelope and watch the phone's reaction (it's the oracle).
