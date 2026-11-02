-- AsterFi schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- A user is a person (or a shared device like "Lobby") with an extension.
CREATE TABLE IF NOT EXISTS users (
  id              serial PRIMARY KEY,
  extension       text UNIQUE NOT NULL,
  first_name      text NOT NULL,
  last_name       text NOT NULL DEFAULT '',
  email           text,
  sip_password    text NOT NULL,
  outbound_cid    text,                       -- DID presented on outbound calls
  ring_seconds    int  NOT NULL DEFAULT 25,
  vm_enabled      boolean NOT NULL DEFAULT true,
  vm_pin          text NOT NULL DEFAULT '1234',
  notify_voicemail boolean NOT NULL DEFAULT true,
  notify_missed    boolean NOT NULL DEFAULT true,
  vm_attach_audio  boolean NOT NULL DEFAULT true,
  noanswer_dest   jsonb NOT NULL DEFAULT '{"type":"voicemail"}',
  max_devices     int  NOT NULL DEFAULT 5,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ring_groups (
  id           serial PRIMARY KEY,
  extension    text UNIQUE NOT NULL,
  name         text NOT NULL,
  strategy     text NOT NULL DEFAULT 'ringall',   -- ringall | hunt
  ring_seconds int  NOT NULL DEFAULT 20,
  members      text[] NOT NULL DEFAULT '{}',      -- user extensions, in hunt order
  fail_dest    jsonb NOT NULL DEFAULT '{"type":"hangup"}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_flows (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  extension   text UNIQUE,          -- optional internal number to reach the flow
  graph       jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompts (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'upload',  -- upload | tts | phone
  tts_text   text,
  has_audio  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trunks (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  host          text NOT NULL,
  port          int  NOT NULL DEFAULT 5060,
  transport     text NOT NULL DEFAULT 'udp',
  username      text,
  password      text,
  auth_username text,
  from_domain   text,
  from_user     text,
  register      boolean NOT NULL DEFAULT true,
  caller_id     text,
  match_ips     text,                          -- extra comma-separated IPs/CIDRs for inbound identify
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS numbers (
  id          serial PRIMARY KEY,
  number      text UNIQUE NOT NULL,   -- normalized digits, or '*' for catch-all
  name        text,
  destination jsonb NOT NULL DEFAULT '{"type":"hangup"}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_routes (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  priority   int  NOT NULL DEFAULT 10,
  patterns   text[] NOT NULL,          -- Asterisk patterns, e.g. _NXXNXXXXXX
  trunk_ids  int[] NOT NULL,           -- failover order
  strip      int  NOT NULL DEFAULT 0,
  prepend    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id           text PRIMARY KEY,       -- Asterisk linkedid
  direction    text NOT NULL,          -- inbound | outbound | internal
  from_num     text,
  from_name    text,
  to_num       text,
  did          text,
  trunk        text,
  answered_by  text,
  status       text NOT NULL,          -- answered | missed | voicemail | busy | failed | abandoned
  started_at   timestamptz NOT NULL,
  answered_at  timestamptz,
  ended_at     timestamptz NOT NULL,
  duration     int NOT NULL DEFAULT 0,
  talk_seconds int NOT NULL DEFAULT 0,
  missed_exts  text[] NOT NULL DEFAULT '{}',
  path         jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS calls_started_idx ON calls (started_at DESC);

CREATE TABLE IF NOT EXISTS voicemails (
  msg_id      text PRIMARY KEY,
  mailbox     text NOT NULL,
  caller_num  text,
  caller_name text,
  duration    int,
  received_at timestamptz NOT NULL,
  notified    boolean NOT NULL DEFAULT false,
  call_id     text
);
CREATE INDEX IF NOT EXISTS voicemails_mailbox_idx ON voicemails (mailbox, received_at DESC);

CREATE TABLE IF NOT EXISTS webhooks (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  url        text NOT NULL,
  secret     text NOT NULL,
  events     text[] NOT NULL DEFAULT '{*}',
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            bigserial PRIMARY KEY,
  webhook_id    int NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending',   -- pending | success | failed
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt  timestamptz NOT NULL DEFAULT now(),
  response_code int,
  response_body text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx ON webhook_deliveries (status, next_attempt);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  key_hash   text UNIQUE NOT NULL,
  prefix     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used  timestamptz
);

CREATE TABLE IF NOT EXISTS email_log (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  recipient  text NOT NULL,
  subject    text NOT NULL,
  status     text NOT NULL,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- UniFi devices seen via L2 discovery or the inform endpoint (Talk phone adoption, phase 0).
CREATE TABLE IF NOT EXISTS unifi_devices (
  mac          text PRIMARY KEY,
  model        text,
  model_name   text,
  ip           text,
  firmware     text,
  hostname     text,
  source       text NOT NULL,              -- discovery | inform
  state        text NOT NULL DEFAULT 'discovered',
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  inform_count int NOT NULL DEFAULT 0,
  last_discovery jsonb,
  last_inform  jsonb
);

-- v0.2: users sign in (role admin|user); trunk custom options; ignorable UniFi devices.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '[]';
ALTER TABLE unifi_devices ADD COLUMN IF NOT EXISTS ignored boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_sessions (
  token      text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- v0.3: the trunk a number is expected to arrive on (NULL = any trunk).
ALTER TABLE numbers ADD COLUMN IF NOT EXISTS trunk_id int REFERENCES trunks(id) ON DELETE SET NULL;

-- v0.4: when a prompt's audio last changed (lets the UI reload the player after edits).
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- v0.5: per-prompt text-to-speech voice (NULL = system default from Settings).
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS tts_voice text;

-- v0.6: call queuing for ring groups (callers wait on hold instead of going to the fallback).
ALTER TABLE ring_groups ADD COLUMN IF NOT EXISTS queue jsonb NOT NULL DEFAULT '{"enabled":false}';

-- v0.7: shared voicemail box for a ring group (mailbox number = the group's extension).
ALTER TABLE ring_groups ADD COLUMN IF NOT EXISTS voicemail jsonb NOT NULL DEFAULT '{"enabled":false}';

-- v0.8: personal contacts; each user keeps their own list (coworkers come from users).
CREATE TABLE IF NOT EXISTS contacts (
  id          serial PRIMARY KEY,
  owner_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name  text NOT NULL DEFAULT '',
  last_name   text NOT NULL DEFAULT '',
  company     text NOT NULL DEFAULT '',
  email       text,
  phones      jsonb NOT NULL DEFAULT '[]',   -- [{label: 'Mobile'|'Work'|'Home'|'Other', number}]
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts (owner_id);

-- v0.9: values for admin-defined custom fields (definitions live in settings 'contactFields').
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';

-- v0.10: outcome of the last "Adopt" attempt (AsterFi signing in to the device to run set-inform).
ALTER TABLE unifi_devices ADD COLUMN IF NOT EXISTS adopt_result jsonb;

-- v0.11: the encryption key AsterFi gives a device in set-adopt; its check-ins use it from then on.
ALTER TABLE unifi_devices ADD COLUMN IF NOT EXISTS authkey text;

-- v0.12: the AsterFi user a Talk phone is assigned to (its SIP account is pushed to the phone on adopt).
ALTER TABLE unifi_devices ADD COLUMN IF NOT EXISTS assigned_user_id int REFERENCES users(id) ON DELETE SET NULL;

-- v0.13: password reset codes (emailed 6-digit code, 15-min expiry).
CREATE TABLE IF NOT EXISTS password_resets (
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  tries      int NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

-- v0.14: click-to-call was removed; drop its reference column.
ALTER TABLE calls DROP COLUMN IF EXISTS reference;

-- v0.15: directory ids last pushed to each Talk phone, so removed entries can be deleted on the phone.
ALTER TABLE unifi_devices ADD COLUMN IF NOT EXISTS synced_contacts jsonb NOT NULL DEFAULT '[]';

-- v0.16: secret token in each user's remote phonebook URL for standard SIP phones.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phonebook_token text UNIQUE;

-- v0.17: each user's web UI theme ('dark' or 'light'); NULL uses the default (dark).
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text;

-- v0.18: a personal contact can be attached to a coworker, to keep your own extra numbers and notes for them.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS coworker_id int REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_coworker_idx ON contacts (owner_id, coworker_id) WHERE coworker_id IS NOT NULL;

-- v0.19: UniFi phones' Recents: which users have seen a missed call (clears the phone's badge).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS read_by text[] NOT NULL DEFAULT '{}';
