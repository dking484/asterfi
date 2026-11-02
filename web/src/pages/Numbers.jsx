import { useState } from 'react';
import { Plus, Hash, Trash2, ArrowRight } from 'lucide-react';
import { api, formatNumber } from '../api.js';
import { useData, useToast, Drawer, Confirm, Field, Empty, useForm } from '../components/ui.jsx';
import { useDirectory, DestinationPicker, describeDest } from '../components/Destination.jsx';

export default function Numbers() {
  const { data, reload } = useData('/api/numbers');
  const { data: trunks } = useData('/api/trunks');
  const trunkName = (id) => (id ? trunks?.find((t) => t.id === id)?.name || 'Removed trunk' : 'Any trunk');
  const [editing, setEditing] = useState(null);
  const dir = useDirectory();
  const add = () => setEditing({ number: '', name: '', trunk_id: trunks?.length === 1 ? trunks[0].id : null, destination: { type: dir.flows.length ? 'flow' : 'user', target: '' } });

  return (
    <>
      <div className="toolbar"><div className="muted">Phone numbers from your carrier, and where their calls go.</div><div className="spacer" /><button className="btn primary" onClick={add}><Plus size={16} />Add Number</button></div>
      <div className="card">
        {data && data.length === 0 ? <Empty icon={Hash} title="No numbers yet" text="Add the numbers your carrier delivers to you and choose where each one rings." action={<button className="btn primary" onClick={add}><Plus size={16} />Add Number</button>} /> : (
          <table className="t">
            <thead><tr><th>Number</th><th>Label</th><th>Trunk</th><th></th><th>Routes to</th></tr></thead>
            <tbody>{(data || []).map((n) => (
              <tr key={n.id} className="clickable" onClick={() => setEditing(n)}>
                <td className="num" style={{ fontWeight: 500 }}>{n.number === '*' ? 'Any other number' : formatNumber(n.number)}</td>
                <td className="muted">{n.name || '—'}</td>
                <td className="muted">{trunkName(n.trunk_id)}</td>
                <td style={{ width: 24 }}><ArrowRight size={14} className="muted" /></td>
                <td>{describeDest(n.destination, dir)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {editing && <NumberDrawer trunks={trunks || []} num={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function NumberDrawer({ num, trunks, onClose, onSaved }) {
  const isNew = !num.id;
  const [f, set] = useForm(num);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const save = async () => {
    setErr('');
    try {
      const body = { number: f.number, name: f.name, trunk_id: f.trunk_id || null, destination: f.destination };
      if (isNew) await api.post('/api/numbers', body); else await api.put(`/api/numbers/${num.id}`, body);
      toast('Number saved'); onSaved();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Drawer title={isNew ? 'Add Number' : formatNumber(num.number)} onClose={onClose} footer={<>
      {!isNew && <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button>}
      <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button>
    </>}>
      {err && <div className="alert error">{err}</div>}
      <Field label="Phone number" hint="Enter * to catch calls to numbers that aren't listed."><input type="text" value={f.number} onChange={set('number')} autoFocus placeholder="(860) 555-0100" /></Field>
      <Field label="Label"><input type="text" value={f.name || ''} onChange={set('name')} placeholder="Main line" /></Field>
      <Field label="Arrives on trunk" hint="Calls for this number from a different trunk are ignored and go to the * catch-all number if there is one.">
        <select value={f.trunk_id || ''} onChange={(e) => set('trunk_id')(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any trunk</option>
          {trunks.map((t) => <option key={t.id} value={t.id}>{t.name}{t.enabled ? '' : ' (disabled)'}</option>)}
        </select>
      </Field>
      <Field label="Send calls to"><DestinationPicker value={f.destination} onChange={set('destination')} /></Field>
      {confirm && <Confirm title="Delete this number?" message="Calls to it will no longer be answered." onConfirm={async () => { await api.del(`/api/numbers/${num.id}`); onSaved(); }} onCancel={() => setConfirm(false)} />}
    </Drawer>
  );
}
