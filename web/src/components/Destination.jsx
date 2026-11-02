import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, fullName, formatNumber } from '../api.js';

// Users, groups and flows, shared by every destination picker.
const DirCtx = createContext(null);
export function DirectoryProvider({ children, isAdmin }) {
  const [dir, setDir] = useState({ users: [], groups: [], flows: [], prompts: [] });
  const refresh = useCallback(async () => {
    const [users, groups, flows, prompts] = await Promise.all([
      api.get('/api/users'), api.get('/api/groups'),
      isAdmin ? api.get('/api/flows') : [], isAdmin ? api.get('/api/prompts') : [],
    ]);
    setDir({ users, groups, flows, prompts });
  }, [isAdmin]);
  useEffect(() => { refresh().catch(() => {}); }, [refresh]);
  return <DirCtx.Provider value={{ ...dir, refresh }}>{children}</DirCtx.Provider>;
}
export const useDirectory = () => useContext(DirCtx);

export const DEST_TYPES = [
  { value: 'user', label: 'User' },
  { value: 'group', label: 'Ring group' },
  { value: 'flow', label: 'Call flow' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'external', label: 'External number' },
  { value: 'hangup', label: 'Hang up' },
];

export function describeDest(d, dir) {
  if (!d) return 'Hang up';
  switch (d.type) {
    case 'user': { const u = dir.users.find((x) => x.extension === d.target); return u ? `${fullName(u)} (${u.extension})` : `User ${d.target}`; }
    case 'group': { const g = dir.groups.find((x) => x.extension === d.target); return g ? `${g.name} (${g.extension})` : `Group ${d.target}`; }
    case 'flow': { const f = dir.flows.find((x) => String(x.id) === String(d.target)); return f ? `Call flow: ${f.name}` : 'Call flow'; }
    case 'voicemail': {
      const u = dir.users.find((x) => x.extension === d.target);
      const g = !u && dir.groups.find((x) => x.extension === d.target);
      return `Voicemail: ${u ? fullName(u) : g ? `${g.name} group` : d.target}`;
    }
    case 'external': return `Forward to ${formatNumber(d.target)}`;
    case 'voicemail-self': return 'Voicemail';
    default: return 'Hang up';
  }
}

export function TargetSelect({ type, value, onChange, placeholder = 'Select…' }) {
  const dir = useDirectory();
  if (type === 'external') {
    return <input type="text" placeholder="Phone number" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  let opts = [];
  if (type === 'user' || type === 'voicemail') {
    opts = dir.users.filter((u) => type === 'user' || u.vm_enabled).map((u) => ({ v: u.extension, l: `${fullName(u)} (${u.extension})` }));
    // Ring groups with a shared mailbox can be voicemail targets too.
    if (type === 'voicemail') opts.push(...dir.groups.filter((g) => g.voicemail?.enabled).map((g) => ({ v: g.extension, l: `${g.name} group (${g.extension})` })));
  } else if (type === 'group') opts = dir.groups.map((g) => ({ v: g.extension, l: `${g.name} (${g.extension})` }));
  else if (type === 'flow') opts = dir.flows.map((f) => ({ v: String(f.id), l: f.name }));
  else return null;
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

export function DestinationPicker({ value, onChange, types, selfVoicemail }) {
  const d = value || { type: 'hangup' };
  const list = DEST_TYPES.filter((t) => !types || types.includes(t.value));
  return (
    <div className="row">
      <select value={d.type} onChange={(e) => onChange({ type: e.target.value, target: '' })} style={{ flex: '0 0 46%' }}>
        {selfVoicemail && <option value="voicemail-self">Their voicemail</option>}
        {list.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
      {!['hangup', 'voicemail-self'].includes(d.type) && <TargetSelect type={d.type} value={d.target} onChange={(t) => onChange({ ...d, target: t })} />}
    </div>
  );
}
