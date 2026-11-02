// Builds the UniFi Talk "profiles_update" body that tells a Talk phone its SIP account, so it registers to
// Asterisk as a normal extension. Shape reverse-engineered from the console's Talk app (module 66294,
// lib/devices/ucp4/cmd/config.ts): the controller pushes an event_request named "profiles_update" whose
// body is an ARRAY of profile objects, each carrying sip:{host,port,user,password,transport}.

// user: { id, extension, first_name, last_name, sip_password }; host: Asterisk's address the phone reaches.
export function buildProfiles(user, host, { port = 5060, did = '' } = {}) {
  const ext = String(user.extension);
  return [{
    id: user.id,
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    active_ring_flow_id: null,
    can_start_intercom_calls: false,
    can_start_group_intercom_calls: false,
    can_handle_external_parked_calls: true,
    can_edit_user_status: true,
    avatar: null,
    avatar_bytes: null,
    call_timeout: 999,
    server_timezone: null,
    install_region: null,
    country_code: 'US',
    server_time_in_utc: Date.now(),
    numbers: [{ type: 'extension', number: ext }, ...(did ? [{ type: 'did', number: did, direction: null }] : [])],
    group_numbers: [],
    groups: [],
    sip: { host, port, user: ext, password: user.sip_password, transport: 'udp' },
    rprtng_auth: '',
    last_updated: Date.now(),
  }];
}

// Builds the "contacts_update" body (the phone's directory), shaped like the console's inform_contacts
// (module 2603). Ids: users are their plain id, everything else "<type>_<id>". The phone merges these
// into its list, so ids that disappear must be removed with a separate "contacts_delete" ({ids}).
export function buildTalkContacts(dir) {
  const ts = (d) => (d ? new Date(d).getTime() : null);
  const byExt = new Map(dir.allUsers.map((u) => [u.extension, u]));
  const users = dir.users.map((u) => ({
    id: String(u.id), first_name: u.first_name || u.extension, last_name: u.last_name || '', avatar: null, avatar_bytes: null,
    numbers: [{ type: 'extension', number: u.extension }, ...u.extra.map((p) => ({ type: 'did', number: p.number, label: p.label })),
      { type: 'voicemail_redirect', number: `voicemail_${u.extension}` }],
    last_updated: ts(u.updated_at || u.created_at), supports_intercom: false, supports_video_calls: false, type: 'user',
  }));
  const groups = dir.groups.map((g) => ({
    id: `group_${g.id}`, uuid: `asterfi-group-${g.id}`, first_name: g.name, last_name: '', avatar: null,
    numbers: [{ type: 'extension', number: g.extension }], last_updated: null, type: 'group',
    users: (g.members || []).map((m) => byExt.get(m)).filter(Boolean).map((u) => String(u.id)), contacts: [],
  }));
  const contacts = dir.contacts.filter((c) => c.phones.length).map((c) => ({
    id: `contact_${c.id}`, first_name: c.first_name || (!c.last_name ? c.company : ''), last_name: c.last_name || '',
    avatar: null, avatar_bytes: null,
    numbers: c.phones.map((p) => ({ type: 'did', number: p.number, label: p.label })),
    org_name: c.company || '', org_title: '', email: c.email || '', contact_lists: [],
    last_updated: ts(c.updated_at), type: 'contact',
  }));
  return [...users, ...groups, ...contacts].sort((a, b) => (a.first_name.toLowerCase() < b.first_name.toLowerCase() ? -1 : 1));
}
