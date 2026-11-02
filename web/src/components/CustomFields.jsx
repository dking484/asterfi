// Admin-defined extra fields (Settings > Contact Fields) for contacts and user profiles.
import { formatNumber } from '../api.js';
import { useData, Field } from './ui.jsx';

export const FIELD_TYPES = [
  ['text', 'Text'], ['textarea', 'Long text'], ['phone', 'Phone number'], ['email', 'Email'],
  ['url', 'Link'], ['date', 'Date'], ['select', 'Dropdown'],
];

export function useFieldDefs() {
  const { data, reload } = useData('/api/contact-fields');
  return { defs: data || [], reload, loaded: !!data };
}

function Input({ def, value, onChange, disabled }) {
  const v = value || '';
  const on = (e) => onChange(e.target.value);
  switch (def.type) {
    case 'textarea': return <textarea rows={3} value={v} onChange={on} disabled={disabled} />;
    case 'select': return (
      <select value={v} onChange={on} disabled={disabled}>
        <option value="">—</option>
        {def.options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
    case 'date': return <input type="date" value={v} onChange={on} disabled={disabled} />;
    case 'phone': return <input type="tel" value={v} onChange={on} disabled={disabled} />;
    case 'email': return <input type="email" value={v} onChange={on} disabled={disabled} />;
    case 'url': return <input type="url" value={v} onChange={on} disabled={disabled} placeholder="https://" />;
    default: return <input type="text" value={v} onChange={on} disabled={disabled} />;
  }
}

// Editable inputs for each field. `readOnly(def)` shows a field without letting it change.
export function CustomFieldInputs({ defs, values, onChange, readOnly = () => false, title = 'More details' }) {
  if (!defs.length) return null;
  const set = (id) => (v) => onChange({ ...(values || {}), [id]: v });
  return (
    <>
      {title && <div className="section-title">{title}</div>}
      {defs.map((d) => (
        <Field key={d.id} label={d.label} hint={readOnly(d) ? 'Set by an administrator.' : null}>
          <Input def={d} value={values?.[d.id]} onChange={set(d.id)} disabled={readOnly(d)} />
        </Field>
      ))}
    </>
  );
}

export function formatFieldValue(def, v) {
  if (!v) return '';
  if (def.type === 'phone') return formatNumber(v);
  if (def.type === 'date') return new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
  return v;
}

// Read-only list of the fields that have a value.
export function CustomFieldView({ defs, values }) {
  const shown = defs.filter((d) => values?.[d.id]);
  if (!shown.length) return null;
  return shown.map((d) => {
    const v = values[d.id];
    const text = formatFieldValue(d, v);
    const body = d.type === 'email' ? <a href={`mailto:${v}`}>{v}</a>
      : d.type === 'url' ? <a href={v} target="_blank" rel="noreferrer">{v}</a>
        : <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
    return <Field key={d.id} label={d.label}>{body}</Field>;
  });
}
