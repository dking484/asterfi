import { useCallback, useState } from 'react';
import { Voicemail as VmIcon, Trash2, Download } from 'lucide-react';
import { api, formatNumber, fmtDuration, fmtWhen } from '../api.js';
import { useData, useLiveEvents, useToast, Empty, Confirm } from '../components/ui.jsx';

export default function Voicemail({ me }) {
  const { data, reload, setData } = useData('/api/voicemail');
  const { data: boxes } = useData('/api/voicemail/boxes');
  const [box, setBox] = useState('all');
  const [del, setDel] = useState(null);
  const multi = (boxes || []).length > 1;
  const shown = (data || []).filter((m) => box === 'all' || m.mailbox === box);
  const toast = useToast();
  useLiveEvents(useCallback(() => reload(), [reload]), ['voicemail.']);

  const played = async (m) => {
    if (m.folder !== 'INBOX') return;
    await api.post(`/api/voicemail/${m.mailbox}/${encodeURIComponent(m.msgId)}/heard`).catch(() => {});
    setData((d) => d.map((x) => (x.msgId === m.msgId ? { ...x, folder: 'Old', heard: true } : x)));
  };
  const audio = (m) => `/api/voicemail/${m.mailbox}/${encodeURIComponent(m.msgId)}/audio`;

  return (
    <>
      <div className="toolbar">
        {multi ? (
          <div className="tabs" style={{ marginBottom: 0 }}>
            {[{ mailbox: 'all', name: 'All' }, ...boxes].map((b) => {
              const n = (data || []).filter((m) => m.folder === 'INBOX' && (b.mailbox === 'all' || m.mailbox === b.mailbox)).length;
              return <button key={b.mailbox} className={`tab ${box === b.mailbox ? 'active' : ''}`} onClick={() => setBox(b.mailbox)}>{b.name}{n > 0 && <span className="badge blue" style={{ marginLeft: 6 }}>{n}</span>}</button>;
            })}
          </div>
        ) : <div className="muted">Your mailbox · ext. {me.extension}</div>}
        <div className="spacer" />
        <span className="muted small">You can also dial *97 from your phone{multi ? ', or *98 and the group\'s extension for a group box' : ''}.</span>
      </div>
      <div className="card">
        {data && shown.length === 0 ? <Empty icon={VmIcon} title="No voicemail" /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th></th><th>From</th>{multi && <th>Mailbox</th>}<th>Received</th><th>Length</th><th>Play</th><th></th></tr></thead>
            <tbody>{shown.map((m) => (
              <tr key={m.msgId}>
                <td style={{ width: 20 }}>{m.folder === 'INBOX' && <span className="dot" style={{ background: 'var(--accent)' }} title="New" />}</td>
                <td style={{ fontWeight: m.folder === 'INBOX' ? 600 : 400 }}>{m.callerName && m.callerName !== m.callerNum ? m.callerName : formatNumber(m.callerNum) || 'Unknown'}{m.callerName && m.callerName !== m.callerNum && <div className="muted small" style={{ fontWeight: 400 }}>{formatNumber(m.callerNum)}</div>}</td>
                {multi && <td>{m.groupBox ? <span className="badge">{m.boxName}</span> : <span className="muted">Mine</span>}</td>}
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(m.receivedAt)}</td>
                <td className="num muted">{fmtDuration(m.duration)}</td>
                <td><audio controls preload="none" src={audio(m)} onPlay={() => played(m)} /></td>
                <td className="actions">
                  <a className="btn ghost sm icon" href={audio(m)} download={`voicemail-${m.msgId}.mp3`} title="Download"><Download size={15} /></a>
                  <button className="btn ghost sm icon" title="Delete" onClick={() => setDel(m)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {del && <Confirm title="Delete voicemail?" message="This message will be permanently removed." onCancel={() => setDel(null)} onConfirm={async () => {
        await api.del(`/api/voicemail/${del.mailbox}/${encodeURIComponent(del.msgId)}`); setDel(null); toast('Voicemail deleted'); reload();
      }} />}
    </>
  );
}
