import { useCallback, useEffect } from 'react';
import { formatNumber } from '../api.js';
import { useData, useLiveEvents } from './ui.jsx';

// Everyone's presence keyed by extension: { status: available|dnd|forward, forwardTo, online, onCall, ringing }.
// Refreshes on call/phone/DND events, and every 20 s for changes made on a phone's status menu.
export function usePresence() {
  const { data, reload } = useData('/api/presence');
  useLiveEvents(useCallback(() => reload(), [reload]), ['call.', 'phone.', 'user.']);
  useEffect(() => { const t = setInterval(reload, 20000); return () => clearInterval(t); }, [reload]);
  return data || {};
}

// What to show for one person; the call state wins over the status while it lasts.
export function presenceInfo(p) {
  if (!p) return { color: '', label: 'Unknown' };
  if (p.onCall) return { color: 'amber', label: 'On a call' };
  if (p.ringing) return { color: 'amber', label: 'Ringing' };
  if (p.status === 'dnd') return { color: 'red', label: 'Do not disturb' };
  if (p.status === 'forward') return { color: 'blue', label: 'Forwarding', detail: p.forwardTo ? `to ${formatNumber(p.forwardTo)}` : '' };
  if (!p.online) return { color: '', label: 'Offline' };
  return { color: 'green', label: 'Available' };
}

export function PresenceBadge({ p }) {
  const i = presenceInfo(p);
  return <span className={`badge ${i.color}`} title={i.detail ? `${i.label} ${i.detail}` : i.label}><span className={`dot ${i.color}`} />{i.label}{i.detail ? ` ${i.detail}` : ''}</span>;
}
