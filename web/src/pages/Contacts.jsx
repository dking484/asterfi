import { useMemo, useState } from 'react';
import { Plus, Trash2, Phone, Search, BookUser, X, Mail } from 'lucide-react';
import { api, formatNumber, fullName } from '../api.js';
import { useData, useToast, Drawer, Confirm, Field, Empty, Seg, Avatar, useForm } from '../components/ui.jsx';
import { useDirectory } from '../components/Destination.jsx';
import { useFieldDefs, CustomFieldInputs, CustomFieldView } from '../components/CustomFields.jsx';
import { usePresence, PresenceBadge } from '../components/Presence.jsx';

const LABELS = ['Mobile', 'Work', 'Home', 'Other'];
const NEW = { first_name: '', last_name: '', company: '', email: '', phones: [{ label: 'Mobile', number: '' }], notes: '' };

export const contactName = (c) => `${c.first_name} ${c.last_name}`.trim() || c.company;

// Asks the web phone to place a call; with the web phone off, AsterFi rings the user's desk phone first.
export const dialNumber = (number) => window.dispatchEvent(new CustomEvent('asterfi:dial', { detail: { number } }));

// Looks up one of your contacts by phone number (last 10 digits), for labelling calls.
export function useContactLookup() {
  const { data } = useData('/api/contacts');
  return useMemo(() => {
    const m = new Map();
    for (const c of data || []) for (const p of c.phones || []) {
      const d = String(p.number).replace(/\D/g, '').slice(-10);
      if (d.length >= 7) m.set(d, c);
    }
    return (num) => (num ? m.get(String(num).replace(/\D/g, '').slice(-10)) || null : null);
  }, [data]);
}

export default function Contacts({ me }) {
  const { data, reload } = useData('/api/contacts');
  const dir = useDirectory();
  const [show, setShow] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const presence = usePresence();

  const rows = useMemo(() => {
    const mine = (data || []).filter((c) => !c.coworker_id).map((c) => ({ key: `c${c.id}`, kind: 'contact', name: contactName(c), sub: c.first_name || c.last_name ? c.company : '', email: c.email, phones: c.phones || [], c }));
    // Your own extra details for a coworker live in a contact attached to them.
    const extra = new Map((data || []).filter((c) => c.coworker_id).map((c) => [c.coworker_id, c]));
    const coworkers = dir.users.filter((u) => u.extension !== me.extension).map((u) => {
      const x = extra.get(u.id);
      return {
        key: `u${u.id}`, kind: 'coworker', name: fullName(u), sub: `Ext. ${u.extension}`, email: u.email || x?.email,
        phones: [{ label: 'Ext.', number: u.extension, ext: true }, ...(x?.phones || [])], u, x,
      };
    });
    const all = show === 'mine' ? mine : show === 'coworkers' ? coworkers : [...mine, ...coworkers];
    const s = search.trim().toLowerCase();
    const d = s.replace(/\D/g, '');
    return all
      .filter((r) => !s || [r.name, r.sub, r.email].some((x) => String(x || '').toLowerCase().includes(s)) || (d && r.phones.some((p) => String(p.number).replace(/\D/g, '').includes(d))))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, dir.users, show, search, me.extension]);

  return (
    <>
      <div className="toolbar">
        <Seg value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'My contacts' }, { value: 'coworkers', label: 'Coworkers' }]} />
        <div className="spacer" />
        <div className="search"><Search size={15} /><input type="search" placeholder="Search name, company or number" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <button className="btn primary" onClick={() => setEditing(NEW)}><Plus size={16} />Add Contact</button>
      </div>
      <div className="card">
        {data && rows.length === 0 ? (
          <Empty icon={BookUser} title={search ? 'No matches' : 'No contacts yet'} text={search ? 'Try a different name or number.' : 'Add the people you call often. Only you can see your contacts.'}
            action={!search && <button className="btn primary" onClick={() => setEditing(NEW)}><Plus size={16} />Add Contact</button>} />
        ) : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key} className="clickable" onClick={() => (r.kind === 'contact' ? setEditing(r.c) : setViewing(r))}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar name={r.name} size={30} />
                    <div><div style={{ fontWeight: 500 }}>{r.name}</div>{r.sub && <div className="muted small">{r.sub}</div>}</div>
                    {r.kind === 'coworker' && <span className="badge blue">Coworker</span>}
                    {r.kind === 'coworker' && <PresenceBadge p={presence[r.u.extension]} />}
                  </div>
                </td>
                <td>{r.phones.map((p, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm icon" title={`Call ${p.number}`} onClick={(e) => { e.stopPropagation(); dialNumber(p.number); }}><Phone size={14} /></button>
                    <span className="num">{p.ext ? p.number : formatNumber(p.number)}</span>
                    {!p.ext && <span className="muted small">{p.label}</span>}
                  </div>
                ))}</td>
                <td>{r.email ? <a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} className="muted"><Mail size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{r.email}</a> : <span className="muted">—</span>}</td>
                <td className="actions"><button className="btn ghost sm">{r.kind === 'contact' ? 'Open' : 'View'}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {viewing && <CoworkerDrawer r={viewing} onClose={() => setViewing(null)} onSaved={() => { setViewing(null); reload(); }} />}
      {editing && <ContactDrawer contact={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

// Coworkers come from Users (admins change those details there); below that, you can keep your own
// extra numbers, email and notes for them, which only you see.
function CoworkerDrawer({ r, onClose, onSaved }) {
  const { defs } = useFieldDefs();
  const x = r.x;
  const [f, set, setF] = useForm({ email: x?.email || '', notes: x?.notes || '', custom: x?.custom || {}, phones: x?.phones?.length ? x.phones : [{ label: 'Mobile', number: '' }] });
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const save = async () => {
    setErr('');
    try {
      const body = { email: f.email, notes: f.notes, phones: f.phones, custom: f.custom };
      if (x) await api.put(`/api/contacts/${x.id}`, body); else await api.post('/api/contacts', { ...body, coworker_id: r.u.id });
      toast('Saved'); onSaved();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Drawer title={r.name} onClose={onClose} footer={<>
      {x && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Clear my details</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button>
    </>}>
      {err && <div className="alert error">{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Avatar name={r.name} size={48} />
        <div><div style={{ fontWeight: 600, fontSize: 16 }}>{r.name}</div><span className="badge blue">Coworker</span></div>
      </div>
      <Field label="Extension">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="num" style={{ fontSize: 15 }}>{r.u.extension}</span>
          <button className="btn sm" onClick={() => dialNumber(r.u.extension)}><Phone size={13} />Call</button>
        </div>
      </Field>
      {r.u.email && <Field label="Work email"><a href={`mailto:${r.u.email}`}>{r.u.email}</a></Field>}
      <CustomFieldView defs={defs.filter((d) => d.users)} values={r.u.custom} />
      <p className="muted small">An administrator changes a coworker's name, extension and work email on the Users page.</p>

      <div className="section-title">Your details for {r.u.first_name || r.name}</div>
      <PhoneList phones={f.phones} setF={setF} canCall />
      <div style={{ height: 12 }} />
      {!r.u.email && <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>}
      <CustomFieldInputs defs={defs.filter((d) => d.contacts)} values={f.custom} onChange={(c) => setF((cur) => ({ ...cur, custom: c }))} />
      <Field label="Notes"><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
      <p className="muted small">Only you can see these. The numbers also appear in your phone's directory.</p>
      {confirm && <Confirm title="Clear your details?" message={`This removes the numbers and notes you added for ${r.name}. Their extension stays.`}
        onConfirm={async () => { await api.del(`/api/contacts/${x.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}

// Editable list of labelled phone numbers, shared by contacts and coworker details.
function PhoneList({ phones, setF, canCall }) {
  const setPhone = (i, patch) => setF((cur) => ({ ...cur, phones: cur.phones.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  return (
    <>
      {phones.map((p, i) => (
        <div key={i} className="row" style={{ marginBottom: 8, alignItems: 'center', gap: 8 }}>
          <select value={p.label} onChange={(e) => setPhone(i, { label: e.target.value })} style={{ flex: '0 0 110px' }}>{LABELS.map((l) => <option key={l}>{l}</option>)}</select>
          <input type="tel" value={p.number} placeholder="(860) 555-0100" onChange={(e) => setPhone(i, { number: e.target.value })} />
          {canCall && /\d/.test(p.number) && <button className="btn ghost sm icon" style={{ flex: '0 0 auto' }} title="Call" onClick={() => dialNumber(p.number)}><Phone size={14} /></button>}
          <button className="btn ghost sm icon" style={{ flex: '0 0 auto' }} disabled={phones.length === 1} onClick={() => setF((cur) => ({ ...cur, phones: cur.phones.filter((_, j) => j !== i) }))}><X size={14} /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setF((cur) => ({ ...cur, phones: [...cur.phones, { label: 'Work', number: '' }] }))}><Plus size={13} />Add number</button>
    </>
  );
}

function ContactDrawer({ contact, onClose, onSaved }) {
  const isNew = !contact.id;
  const [f, set, setF] = useForm({ ...contact, email: contact.email || '', custom: contact.custom || {}, phones: contact.phones?.length ? contact.phones : [{ label: 'Mobile', number: '' }] });
  const { defs } = useFieldDefs();
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const save = async () => {
    setErr('');
    try {
      const body = { first_name: f.first_name, last_name: f.last_name, company: f.company, email: f.email, notes: f.notes, phones: f.phones, custom: f.custom };
      if (isNew) await api.post('/api/contacts', body); else await api.put(`/api/contacts/${contact.id}`, body);
      toast('Contact saved'); onSaved();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Drawer title={isNew ? 'Add Contact' : contactName(contact)} onClose={onClose} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button>
    </>}>
      {err && <div className="alert error">{err}</div>}
      <div className="row">
        <Field label="First name"><input type="text" value={f.first_name} onChange={set('first_name')} autoFocus /></Field>
        <Field label="Last name"><input type="text" value={f.last_name} onChange={set('last_name')} /></Field>
      </div>
      <Field label="Company"><input type="text" value={f.company} onChange={set('company')} /></Field>
      <div className="section-title">Phone numbers</div>
      <PhoneList phones={f.phones} setF={setF} canCall={!isNew} />
      <div style={{ height: 12 }} />
      <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
      <CustomFieldInputs defs={defs.filter((d) => d.contacts)} values={f.custom} onChange={(c) => setF((cur) => ({ ...cur, custom: c }))} />
      <Field label="Notes"><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
      <p className="muted small">Only you can see your contacts. Calls from these numbers show the contact's name in your call history.</p>
      {confirm && <Confirm title={`Delete ${contactName(contact)}?`} message="This removes the contact from your list." onConfirm={async () => { await api.del(`/api/contacts/${contact.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}
