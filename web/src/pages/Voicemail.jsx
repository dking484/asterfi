import { Fragment, useCallback, useState } from 'react';
import { Voicemail as VmIcon, Trash2, Download, FileText } from 'lucide-react';
import { api, formatNumber, fmtDuration, fmtWhen } from '../api.js';
import { useData, useLiveEvents, useToast, Empty, Confirm } from '../components/ui.jsx';
import { CallNumber } from './Calls.jsx';

export default function Voicemail({ me }) {
  const { data, reload, setData } = useData('/api/voicemail');
  const { data: boxes } = useData('/api/voicemail/boxes');
  const { data: stt } = useData('/api/voicemail/transcription');
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
  const transcribe = async (m) => {
    try {
      await api.post(`/api/voicemail/${m.mailbox}/${encodeURIComponent(m.msgId)}/transcribe`);
      setData((d) => d.map((x) => (x.msgId === m.msgId ? { ...x, transcriptStatus: 'pending' } : x)));
    } catch (e) { toast(e.message, 'error'); }
  };
  const cols = multi ? 7 : 6;

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
              <Fragment key={m.msgId}>
              <tr className={hasTranscriptRow(m, stt) ? 'vm-has-transcript' : ''}>
                <td style={{ width: 20 }}>{m.folder === 'INBOX' && <span className="dot" style={{ background: 'var(--accent)' }} title="New" />}</td>
                <td style={{ fontWeight: m.folder === 'INBOX' ? 600 : 400 }}>{m.callerName && m.callerName !== m.callerNum ? m.callerName : <CallNumber number={m.callerNum}>{formatNumber(m.callerNum) || 'Unknown'}</CallNumber>}{m.callerName && m.callerName !== m.callerNum && <div className="muted small" style={{ fontWeight: 400 }}><CallNumber number={m.callerNum} /></div>}</td>
                {multi && <td>{m.groupBox ? <span className="badge">{m.boxName}</span> : <span className="muted">Mine</span>}</td>}
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(m.receivedAt)}</td>
                <td className="num muted">{fmtDuration(m.duration)}</td>
                <td><audio controls preload="none" src={audio(m)} onPlay={() => played(m)} /></td>
                <td className="actions">
                  <a className="btn ghost sm icon" href={audio(m)} download={`voicemail-${m.msgId}.mp3`} title="Download"><Download size={15} /></a>
                  <button className="btn ghost sm icon" title="Delete" onClick={() => setDel(m)}><Trash2 size={15} /></button>
                </td>
              </tr>
              {hasTranscriptRow(m, stt) && <tr className="vm-transcript-row"><td /><td colSpan={cols - 1}><Transcript m={m} onTranscribe={() => transcribe(m)} /></td></tr>}
              </Fragment>
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

// A transcript row shows under a message once it has (or is getting) one, or when it could be transcribed now.
const hasTranscriptRow = (m, stt) => !!m.transcriptStatus || !!stt?.available;

function Transcript({ m, onTranscribe }) {
  if (m.transcriptStatus === 'pending') return <div className="vm-transcript muted">Transcribing…</div>;
  if (m.transcriptStatus === 'done') {
    return m.transcript ? <div className="vm-transcript">{m.transcript}</div> : <div className="vm-transcript muted">No speech in this message.</div>;
  }
  return (
    <div className="vm-transcript muted">
      {m.transcriptStatus === 'failed' && "Couldn't transcribe this message. "}
      <button type="button" className="btn ghost sm" onClick={onTranscribe}><FileText size={13} />{m.transcriptStatus === 'failed' ? 'Try again' : 'Transcribe'}</button>
    </div>
  );
}
