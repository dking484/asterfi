import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, addEdge, applyNodeChanges, applyEdgeChanges, useReactFlow, useStore, MarkerType, BaseEdge, getSmoothStepPath } from '@xyflow/react';
import { routeWires, decorate, pathFromPoints } from '../components/wireRouter.js';
import { Plus, Pencil, Workflow, PhoneIncoming, Volume2, Grid3x3, Clock, Webhook, Tag, User, UsersRound, Voicemail, PhoneForwarded, PhoneOff, ArrowLeft, Save, Trash2, Mic, Upload, Type, Play, AlertTriangle, X, BookUser, Disc, Megaphone } from 'lucide-react';
import { api, fullName, formatNumber, fmtWhen, dayKey } from '../api.js';
import { useData, useToast, Drawer, Confirm, Field, Toggle, Empty, Switch } from '../components/ui.jsx';
import { useDirectory, TargetSelect } from '../components/Destination.jsx';
import { VoiceSelect, PreviewButton } from '../components/Voices.jsx';

// ------------------------------------------------------------------ block catalogue
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

export const BLOCKS = {
  start: { name: 'Incoming call', icon: PhoneIncoming, color: '#22c55e', outs: () => [['next', 'Next']] , noInput: true },
  greeting: { name: 'Play message', icon: Volume2, color: '#006fff', outs: () => [['next', 'Next']], data: { label: 'Greeting' } },
  menu: { name: 'Menu', icon: Grid3x3, color: '#8b5cf6', outs: (d) => [...(d.keys || []).map((k) => [`key-${k}`, `Press ${k}`]), ['timeout', 'No input'], ['invalid', 'Invalid choice']], data: { label: 'Main menu', keys: ['1', '2'], timeout: 5, retries: 2, allowExtensions: false } },
  hours: { name: 'Business hours', icon: Clock, color: '#f59e0b', outs: () => [['open', 'Open'], ['closed', 'Closed']], data: { label: 'Business hours', schedule: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }], holidays: [] } },
  whisper: { name: 'Announce to answerer', icon: Megaphone, color: '#f97316', outs: () => [['next', 'Next']], data: { label: 'Announce' } },
  notify: { name: 'Notify (webhook)', icon: Webhook, color: '#14b8a6', outs: () => [['next', 'Next']], data: { label: 'Notify' } },
  setname: { name: 'Tag caller name', icon: Tag, color: '#64748b', outs: () => [['next', 'Next']], data: { label: 'Tag', prefix: 'Sales: ' } },
  user: { name: 'Ring user', icon: User, color: '#0ea5e9', terminal: true, data: { label: 'Ring user' } },
  group: { name: 'Ring group', icon: UsersRound, color: '#6366f1', terminal: true, data: { label: 'Ring group' } },
  voicemail: { name: 'Voicemail', icon: Voicemail, color: '#a855f7', terminal: true, data: { label: 'Voicemail' } },
  external: { name: 'Forward to number', icon: PhoneForwarded, color: '#ec4899', terminal: true, data: { label: 'Forward' } },
  flow: { name: 'Go to call flow', icon: Workflow, color: '#0d9488', terminal: true, data: { label: 'Other flow' } },
  directory: { name: 'Directory', icon: BookUser, color: '#0891b2', outs: () => [['operator', 'Pressed 0'], ['none', 'No match']], data: { label: 'Directory', searchBy: 'last', sayExtension: false, menu: true } },
  hangup: { name: 'Hang up', icon: PhoneOff, color: '#ef4444', terminal: true, data: { label: 'Hang up', playGoodbye: true } },
};
const PALETTE = [['Callers hear', ['greeting', 'menu']], ['Decide', ['hours']], ['Connect to', ['whisper', 'user', 'group', 'directory', 'voicemail', 'external', 'flow']], ['Other', ['notify', 'setname', 'hangup']]];

const fmtSchedule = (d) => (d.schedule || []).map((r) => {
  const days = r.days || [];
  const idx = days.map((x) => DAYS.findIndex((y) => y[0] === x)).sort((a, b) => a - b);
  const contiguous = idx.length > 1 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const dl = contiguous ? `${DAYS[idx[0]][1]}–${DAYS[idx[idx.length - 1]][1]}` : idx.map((i) => DAYS[i][1]).join(', ');
  return `${dl} ${r.start}–${r.end}`;
}).join('; ');

// ------------------------------------------------------------------ node renderer
function FlowNode({ id, type, data, selected }) {
  const b = BLOCKS[type];
  const dir = useDirectory();
  const Icon = b.icon;
  // What callers hear: the spoken text itself for text-to-speech, otherwise the recording's name.
  const prompt = (pid) => {
    const p = dir.prompts.find((x) => x.id === Number(pid));
    if (!p) return null;
    if (p.kind === 'tts' && p.tts_text) return <span style={{ fontStyle: 'italic' }}>"{p.tts_text.length > 110 ? `${p.tts_text.slice(0, 110)}…` : p.tts_text}"</span>;
    return <span><Mic size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{p.name}{p.has_audio ? '' : ' (not recorded yet)'}</span>;
  };
  let body = null;
  switch (type) {
    case 'start': body = <>
      {data.answer === false ? 'Not answered first' : data.promptId ? <>Answer, then play: {prompt(data.promptId)}</> : 'Answer the call'}
      {data.record && <div style={{ marginTop: 4, color: 'var(--red)' }}><Disc size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Calls are recorded</div>}
    </>; break;
    case 'whisper': body = prompt(data.promptId) || <span style={{ color: 'var(--amber)' }}>Add what the answerer hears</span>; break;
    case 'greeting': body = prompt(data.promptId) || <span style={{ color: 'var(--amber)' }}>Add what callers hear</span>; break;
    case 'menu': body = prompt(data.promptId) || <span style={{ color: 'var(--amber)' }}>Add what callers hear</span>; break;
    case 'hours': body = fmtSchedule(data) || 'No hours set'; break;
    case 'notify': body = 'Sends ivr.keypress'; break;
    case 'setname': body = `Prefix "${data.prefix || ''}"`; break;
    case 'directory': body = `Dial by ${{ first: 'first name', last: 'last name', both: 'first or last name' }[data.searchBy] || 'last name'}`; break;
    case 'user': case 'voicemail': { const u = dir.users.find((x) => x.extension === data.target); body = u ? `${fullName(u)} (${u.extension})` : <span style={{ color: 'var(--amber)' }}>Choose a user</span>; break; }
    case 'group': { const g = dir.groups.find((x) => x.extension === data.target); body = g ? g.name : <span style={{ color: 'var(--amber)' }}>Choose a group</span>; break; }
    case 'flow': { const f = dir.flows.find((x) => String(x.id) === String(data.target)); body = f ? f.name : <span style={{ color: 'var(--amber)' }}>Choose a flow</span>; break; }
    case 'external': body = data.target ? formatNumber(data.target) : <span style={{ color: 'var(--amber)' }}>Enter a number</span>; break;
    case 'hangup': body = data.promptId ? <>Play {prompt(data.promptId)}{data.playGoodbye ? ', say goodbye' : ''}, then hang up</>
      : data.playGoodbye ? 'Say goodbye, then hang up' : 'Hang up'; break;
  }
  const outs = b.outs ? b.outs(data) : [];
  return (
    <div className={`fnode ${selected ? 'selected' : ''}`}>
      {!b.noInput && <Handle type="target" position={Position.Left} id="in" style={{ top: 22 }} />}
      <div className="fnode-head">
        <div className="ic" style={{ background: b.color }}><Icon size={13} /></div>
        <div style={{ minWidth: 0 }}><div className="k">{b.name}</div><div className="nm">{data.label || b.name}</div></div>
      </div>
      {body && <div className="fnode-body">{body}</div>}
      {outs.length > 0 && <div className="fnode-outs">{outs.map(([h, l]) => (
        <div key={h} className="fnode-out">{l}<Handle type="source" position={Position.Right} id={h} /></div>
      ))}</div>}
    </div>
  );
}
const nodeTypes = Object.fromEntries(Object.keys(BLOCKS).map((k) => [k, FlowNode]));

// ---- wires: routed together so they avoid blocks and each other -------------------
const RoutesCtx = createContext(new Map());

function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, interactionWidth }) {
  const routes = useContext(RoutesCtx);
  const route = routes.get(id);
  const pts = route?.pts;
  let path;
  if (pts && pts.length >= 2) {
    // Pin the ends to the live handle positions (the route may lag a frame while dragging).
    const p = pts.map((x) => [...x]);
    p[0] = [sourceX, sourceY];
    p[p.length - 1] = [targetX, targetY];
    if (p.length > 2) { p[1][1] = sourceY; p[p.length - 2][1] = targetY; }
    path = pathFromPoints(p, 8, route.hops);
  } else {
    [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  }
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth ?? 14} />
      {route?.dots.map(([x, y]) => <circle key={`${x},${y}`} cx={x} cy={y} r={4} className="wire-junction" />)}
    </>
  );
}
const edgeTypes = { routed: RoutedEdge };

// Block rectangles and handle points straight from React Flow's measurements.
function useWireGeometry(edges) {
  const geometry = useStore((s) => {
    const rects = [], handles = {};
    for (const [id, n] of s.nodeLookup) {
      const w = n.measured?.width, h = n.measured?.height;
      if (!w || !h) continue;
      const { x, y } = n.internals.positionAbsolute;
      rects.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h)]);
      for (const hb of n.internals.handleBounds?.source || []) handles[`${id}|s|${hb.id || 'next'}`] = [Math.round(x + hb.x + hb.width), Math.round(y + hb.y + hb.height / 2)];
      for (const hb of n.internals.handleBounds?.target || []) handles[`${id}|t`] = [Math.round(x + hb.x), Math.round(y + hb.y + hb.height / 2)];
    }
    return JSON.stringify([rects, handles]);
  });
  return useMemo(() => {
    const [rects, handles] = JSON.parse(geometry);
    const wires = [];
    for (const e of edges) {
      const s = handles[`${e.source}|s|${e.sourceHandle || 'next'}`], t = handles[`${e.target}|t`];
      if (s && t) wires.push({ id: e.id, sx: s[0], sy: s[1], tx: t[0], ty: t[1] });
    }
    return decorate(routeWires(rects.map(([x, y, w, h]) => ({ x, y, w, h })), wires), wires);
  }, [geometry, edges.map((e) => `${e.id}:${e.source}:${e.sourceHandle}:${e.target}`).join('|')]);
}

// ------------------------------------------------------------------ page
export default function Flows() {
  const { id } = useParams();
  const [tab, setTab] = useState('flows');
  if (id) return <ReactFlowProvider><Designer id={id} /></ReactFlowProvider>;
  return (
    <>
      <div className="tabs">{[['flows', 'Call Flows'], ['prompts', 'Audio Prompts']].map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'flows' ? <FlowList /> : <Prompts />}
    </>
  );
}

function FlowList() {
  const { data, reload } = useData('/api/flows');
  const [creating, setCreating] = useState(null);
  const [del, setDel] = useState(null);
  const nav = useNavigate();
  const dir = useDirectory();
  const toast = useToast();
  const create = async () => {
    try { const f = await api.post('/api/flows', creating); dir.refresh(); nav(`/flows/${f.id}`); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <>
      <div className="toolbar"><div className="muted">Auto attendants, business-hours routing and menus, built visually.</div><div className="spacer" /><button className="btn primary" onClick={() => setCreating({ name: '', extension: '' })}><Plus size={16} />New Call Flow</button></div>
      <div className="card">
        {data && data.length === 0 ? <Empty icon={Workflow} title="No call flows yet" text='Build a menu like "Press 1 for Sales" and connect it to a number.' action={<button className="btn primary" onClick={() => setCreating({ name: '', extension: '' })}><Plus size={16} />New Call Flow</button>} /> : (
          <table className="t"><thead><tr><th>Name</th><th>Extension</th><th>Blocks</th><th>Last edited</th><th></th></tr></thead>
            <tbody>{(data || []).map((f) => (
              <tr key={f.id} className="clickable" onClick={() => nav(`/flows/${f.id}`)}>
                <td style={{ fontWeight: 500 }}><Workflow size={14} className="muted" style={{ verticalAlign: -2, marginRight: 8 }} />{f.name}</td>
                <td className="num">{f.extension || '—'}</td><td className="muted">{f.blocks}</td><td className="muted small">{fmtWhen(f.updated_at)}</td>
                <td className="actions"><button className="btn ghost sm icon" onClick={(e) => { e.stopPropagation(); setDel(f); }}><Trash2 size={14} /></button></td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {creating && <Drawer title="New Call Flow" onClose={() => setCreating(null)} footer={<><div className="spacer" /><button className="btn" onClick={() => setCreating(null)}>Cancel</button><button className="btn primary" disabled={!creating.name} onClick={create}>Create and open designer</button></>}>
        <Field label="Name"><input type="text" autoFocus value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Main auto attendant" /></Field>
        <Field label="Extension (optional)" hint="Lets users dial or transfer to this flow internally."><input type="text" value={creating.extension} onChange={(e) => setCreating({ ...creating, extension: e.target.value })} placeholder="700" /></Field>
      </Drawer>}
      {del && <Confirm title={`Delete ${del.name}?`} message="Numbers pointing at this flow will hang up instead." onConfirm={async () => { await api.del(`/api/flows/${del.id}`); setDel(null); reload(); dir.refresh(); }} onCancel={() => setDel(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ designer
let seq = 0;
const newId = (type) => `${type}-${Date.now().toString(36)}${(seq++).toString(36)}`;
const edgeStyle = { type: 'routed', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }, style: { strokeWidth: 1.8 } };

// Compared against the last saved copy to decide whether there are unsaved changes.
const snapshot = (fl, ns, es) => JSON.stringify([fl?.name, fl?.extension || '',
  ns.map((n) => [n.id, n.type, Math.round(n.position.x), Math.round(n.position.y), n.data]),
  es.map((e) => [e.source, e.sourceHandle, e.target])]);

function Designer({ id }) {
  const nav = useNavigate();
  const toast = useToast();
  const dir = useDirectory();
  const rf = useReactFlow();
  const [flow, setFlow] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [sel, setSel] = useState(null);
  const [saved, setSaved] = useState('');
  const [errors, setErrors] = useState([]);
  const [leaving, setLeaving] = useState(false);
  const wrap = useRef(null);
  const dirty = !!flow && snapshot(flow, nodes, edges) !== saved;
  const routes = useWireGeometry(edges);

  useEffect(() => {
    api.get(`/api/flows/${id}`).then((f) => {
      setFlow(f);
      setNodes(f.graph.nodes || []);
      setEdges((f.graph.edges || []).map((e) => ({ ...e, ...edgeStyle })));
      setSaved(snapshot(f, f.graph.nodes || [], f.graph.edges || []));
    }).catch(() => nav('/flows'));
  }, [id]);
  useEffect(() => {
    const h = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const onNodesChange = useCallback((ch) => {
    setNodes((n) => applyNodeChanges(ch.filter((c) => !(c.type === 'remove' && c.id === 'start')), n));
  }, []);
  const onEdgesChange = useCallback((ch) => { setEdges((e) => applyEdgeChanges(ch, e)); }, []);
  const onConnect = useCallback((c) => {
    // One connection per output.
    setEdges((e) => addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle}-${c.target}`, ...edgeStyle }, e.filter((x) => !(x.source === c.source && x.sourceHandle === c.sourceHandle))));
  }, []);

  const addNode = (type, position) => {
    const b = BLOCKS[type];
    const n = { id: newId(type), type, position: position || rf.screenToFlowPosition({ x: (wrap.current?.clientWidth || 800) / 2 + (wrap.current?.getBoundingClientRect().left || 0), y: 160 + (nodes.length % 6) * 40 }), data: structuredClone(b.data || {}) };
    setNodes((x) => [...x.map((y) => ({ ...y, selected: false })), { ...n, selected: true }]);
    setSel(n.id);
  };
  const onDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/asterfi');
    if (BLOCKS[type]) addNode(type, rf.screenToFlowPosition({ x: e.clientX - 100, y: e.clientY - 20 }));
  };
  const updateData = (nid, patch) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patch } } : n)));
    // Drop connections from menu keys that were switched off.
    if (patch.keys) setEdges((es) => es.filter((e) => e.source !== nid || !e.sourceHandle?.startsWith('key-') || patch.keys.includes(e.sourceHandle.slice(4))));
  };
  const removeNode = (nid) => { setNodes((n) => n.filter((x) => x.id !== nid)); setEdges((e) => e.filter((x) => x.source !== nid && x.target !== nid)); setSel(null); };

  const save = async (force = false) => {
    const graph = { nodes: nodes.map(({ id: nid, type, position, data }) => ({ id: nid, type, position, data })), edges: edges.map(({ id: eid, source, sourceHandle, target, targetHandle }) => ({ id: eid, source, sourceHandle, target, targetHandle })), viewport: rf.getViewport() };
    try {
      const r = await api.put(`/api/flows/${id}`, { name: flow.name, extension: flow.extension, graph, force });
      if (!r.ok) { setErrors(r.errors); return; }
      setErrors([]); setSaved(snapshot(flow, nodes, edges)); dir.refresh(); toast('Call flow saved and live');
    } catch (e) { toast(e.message, 'error'); }
  };
  const back = () => (dirty ? setLeaving(true) : nav('/flows'));
  const selected = nodes.find((n) => n.id === sel);

  // Highlight blocks nothing connects to (except Start).
  const reached = useMemo(() => new Set(edges.map((e) => e.target)), [edges]);
  const shown = useMemo(() => nodes.map((n) => (n.type !== 'start' && !reached.has(n.id) ? { ...n, className: 'unreached' } : n)), [nodes, reached]);

  if (!flow) return null;
  return (
    <div className="designer">
      <div className="designer-top">
        <button className="btn ghost icon" onClick={back}><ArrowLeft size={18} /></button>
        <input type="text" value={flow.name} onChange={(e) => { setFlow({ ...flow, name: e.target.value }); }} style={{ width: 260, fontWeight: 600 }} />
        <input type="text" value={flow.extension || ''} onChange={(e) => { setFlow({ ...flow, extension: e.target.value }); }} placeholder="Ext." style={{ width: 80 }} title="Internal extension" />
        <div className="spacer" />
        {dirty && <span className="muted small">Unsaved changes</span>}
        <button className="btn primary" onClick={() => save(false)}><Save size={15} />Save</button>
      </div>
      {errors.length > 0 && <div className="alert warn" style={{ margin: 0, borderRadius: 0 }}>
        <AlertTriangle size={16} /><div style={{ flex: 1 }}>{errors.map((e, i) => <div key={i}>{e}</div>)}</div>
        <button className="btn sm" onClick={() => save(true)}>Save anyway</button><button className="btn ghost sm icon" onClick={() => setErrors([])}><X size={14} /></button>
      </div>}
      <div className="designer-body">
        <div className="palette">
          {PALETTE.map(([title, types]) => (
            <div key={title}><h4>{title}</h4>{types.map((t) => { const b = BLOCKS[t]; return (
              <div key={t} className="pal-item" draggable onDragStart={(e) => { e.dataTransfer.setData('application/asterfi', t); e.dataTransfer.effectAllowed = 'move'; }} title="Drag onto the canvas to add">
                <div className="ic" style={{ background: b.color }}><b.icon size={14} /></div>{b.name}
              </div>
            ); })}</div>
          ))}
          <p className="muted small" style={{ marginTop: 16 }}>Drag from a block's right-hand dots to the next block. Select a connection and press Delete to remove it.</p>
        </div>
        <div className="canvas" ref={wrap} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
          <RoutesCtx.Provider value={routes}>
          <ReactFlow nodes={shown} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onSelectionChange={({ nodes: s }) => setSel(s.length === 1 ? s[0].id : null)} defaultViewport={flow.graph.viewport} fitView={!flow.graph.viewport}
            fitViewOptions={{ maxZoom: 1 }} deleteKeyCode={['Backspace', 'Delete']} snapToGrid snapGrid={[10, 10]} minZoom={0.3} maxZoom={1.6} proOptions={{ hideAttribution: true }}>
            <Background gap={20} size={1.2} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => BLOCKS[n.type]?.color || '#999'} />
          </ReactFlow>
          </RoutesCtx.Provider>
        </div>
        <aside className="inspector">
          {selected ? <Inspector node={selected} onChange={(p) => updateData(selected.id, p)} onDelete={() => removeNode(selected.id)} flowId={Number(id)} flowName={flow.name} /> : (
            <div className="inspector-body muted">
              <p style={{ marginTop: 0 }}>Select a block to edit it.</p>
              <p className="small">Every call starts at <b>Incoming call</b>. Point a number at this flow on the Numbers page{flow.extension ? `, or dial ${flow.extension} from any phone to test it` : ''}.</p>
            </div>
          )}
        </aside>
      </div>
      {leaving && <Confirm title="Discard changes?" message="You have unsaved changes to this call flow." confirmLabel="Discard" onConfirm={() => nav('/flows')} onCancel={() => setLeaving(false)} />}
      <style>{'.react-flow__node.unreached .fnode { opacity: .75; border-style: dashed; }'}</style>
    </div>
  );
}

function Inspector({ node, onChange, onDelete, flowId, flowName }) {
  const b = BLOCKS[node.type];
  const d = node.data;
  const dir = useDirectory();
  const set = (k) => (e) => onChange({ [k]: e?.nativeEvent ? (e.target.type === 'number' ? Number(e.target.value) : e.target.value) : e });
  return (
    <>
      <div className="inspector-head">
        <div className="pal-item" style={{ border: 'none', padding: 0, margin: 0, cursor: 'default' }}><div className="ic" style={{ background: b.color }}><b.icon size={14} /></div></div>
        <h3>{b.name}</h3>
        {node.type !== 'start' && <button className="btn ghost sm icon" title="Delete block" onClick={onDelete}><Trash2 size={15} /></button>}
      </div>
      <div className="inspector-body">
        <Field label="Label"><input type="text" value={d.label || ''} onChange={set('label')} /></Field>
        {node.type === 'start' && <Toggle title="Answer the call" description="Off only if the next block rings someone directly and you want the carrier to keep ringing." checked={d.answer !== false} onChange={(v) => onChange({ answer: v })} />}
        {(node.type === 'greeting' || node.type === 'menu' || (node.type === 'start' && d.answer !== false)) && <PromptEditor key={node.id} node={node} flowName={flowName} onChange={onChange} />}
        {node.type === 'start' && <>
          <Toggle title="Record calls" description="Records the conversation once someone answers. Play it from the call's details in Call History. Many states require telling callers, e.g. in the greeting above." checked={!!d.record} onChange={(v) => onChange({ record: v })} />
        </>}
        {node.type === 'menu' && <>
          <Field label="Keys callers can press">
            <div className="keys-grid">{KEYS.map((k) => <button key={k} type="button" className={(d.keys || []).includes(k) ? 'on' : ''} onClick={() => onChange({ keys: (d.keys || []).includes(k) ? d.keys.filter((x) => x !== k) : KEYS.filter((x) => [...(d.keys || []), k].includes(x)) })}>{k}</button>)}</div>
          </Field>
          <div className="row">
            <Field label="Wait for input (s)"><input type="number" min="1" max="30" value={d.timeout ?? 5} onChange={set('timeout')} /></Field>
            <Field label="Repeat menu"><input type="number" min="0" max="5" value={d.retries ?? 2} onChange={set('retries')} /></Field>
          </div>
          <Toggle title="Allow dialing an extension" description="Callers can type a user or group extension at any time." checked={d.allowExtensions} onChange={(v) => onChange({ allowExtensions: v })} />
          <p className="muted small">"No input" and "Invalid choice" are followed after the menu repeats {d.retries ?? 2} time(s). Leave them unconnected to hang up.</p>
        </>}
        {node.type === 'hours' && <HoursEditor d={d} onChange={onChange} />}
        {node.type === 'notify' && <p className="muted small">When a call passes this block, an <span className="mono">ivr.keypress</span> webhook is sent with the caller's number and this block's label. Use it to open a ticket or trigger a screen-pop in another app.</p>}
        {node.type === 'setname' && <Field label="Prefix" hint="Added in front of the caller's name so whoever answers knows which option they chose (max 12 characters)."><input type="text" maxLength={12} value={d.prefix || ''} onChange={set('prefix')} /></Field>}
        {['user', 'group', 'voicemail', 'flow'].includes(node.type) && <Field label={{ user: 'User', group: 'Ring group', voicemail: 'Mailbox', flow: 'Call flow' }[node.type]}>
          <TargetSelect type={node.type} value={d.target} onChange={(v) => onChange({ target: v })} />
          {node.type === 'flow' && String(d.target) === String(flowId) && <div className="hint" style={{ color: 'var(--amber)' }}>This is the flow you're editing — callers will start over.</div>}
        </Field>}
        {node.type === 'user' && <p className="muted small">If they don't answer, the call follows the user's own "If not answered" setting.</p>}
        {node.type === 'group' && <p className="muted small">If nobody answers, the call follows the group's "If nobody answers" setting.</p>}
        {node.type === 'external' && <Field label="Phone number"><input type="text" value={d.target || ''} onChange={set('target')} placeholder="(860) 555-0199" /></Field>}
        {node.type === 'directory' && <>
          <Field label="Callers spell the person's">
            <select value={d.searchBy || 'last'} onChange={set('searchBy')}>
              <option value="last">Last name</option><option value="first">First name</option><option value="both">First or last name</option>
            </select>
          </Field>
          <Toggle title="List matches as a menu" description={'Callers hear "Press 1 for …, 2 for …" instead of confirming one name at a time.'} checked={d.menu !== false} onChange={(v) => onChange({ menu: v })} />
          <Toggle title="Say each person's extension" checked={d.sayExtension} onChange={(v) => onChange({ sayExtension: v })} />
          <p className="muted small">Callers type the first three letters of the name on their keypad and are connected to the person they pick. Everyone with voicemail turned on is listed. Names are read from each person's recorded name (they can record it by dialing *97, then 0, then 3); anyone without one has their name spelled out.</p>
          <p className="muted small">"Pressed 0" lets callers reach an operator; "No match" is used when nobody matched or the caller gave up. Leave them unconnected to hang up.</p>
        </>}
        {node.type === 'whisper' && <>
          <PromptEditor key={node.id} node={node} flowName={flowName} onChange={onChange} heading="Whoever answers hears"
            placeholder={'e.g. "Service call from the main line."'} />
          <p className="muted small">The caller doesn't hear this. When someone picks up later in the call (a user, a group, a queue, or a forwarded cell), this plays to them first while the caller keeps hearing ringing. Put it before the Ring block.</p>
        </>}
        {node.type === 'hangup' && <>
          <PromptEditor key={node.id} node={node} flowName={flowName} onChange={onChange} />
          <Toggle title={d.promptId ? 'Then say "Goodbye"' : 'Say "Goodbye" first'} checked={d.playGoodbye} onChange={(v) => onChange({ playGoodbye: v })} />
        </>}
        <div className="muted small" style={{ marginTop: 20 }}>{dir.prompts.length === 0 && ['greeting', 'menu'].includes(node.type) && 'Tip: create prompts on the Audio Prompts tab, or add one here.'}</div>
      </div>
    </>
  );
}

function HoursEditor({ d, onChange }) {
  const sched = d.schedule || [];
  const setRule = (i, patch) => onChange({ schedule: sched.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const hol = d.holidays || [];
  return (
    <>
      <div className="section-title">Open hours</div>
      {sched.map((r, i) => (
        <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div className="chips" style={{ marginBottom: 8 }}>{DAYS.map(([k, l]) => (
            <button key={k} type="button" className={`btn sm ${r.days.includes(k) ? 'primary' : ''}`} style={{ padding: '0 7px' }} onClick={() => setRule(i, { days: r.days.includes(k) ? r.days.filter((x) => x !== k) : [...r.days, k] })}>{l}</button>
          ))}</div>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <input type="time" style={{ minWidth: 120 }} value={r.start} onChange={(e) => setRule(i, { start: e.target.value })} />
            <span style={{ flex: '0 0 auto' }} className="muted">to</span>
            <input type="time" style={{ minWidth: 120 }} value={r.end} onChange={(e) => setRule(i, { end: e.target.value })} />
            <button className="btn ghost sm icon" style={{ flex: '0 0 auto' }} onClick={() => onChange({ schedule: sched.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
      <button className="btn sm" onClick={() => onChange({ schedule: [...sched, { days: ['sat'], start: '09:00', end: '12:00' }] })}><Plus size={13} />Add hours</button>
      <div className="section-title">Closed on holidays</div>
      {hol.map((h, i) => (
        <div key={i} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
          <input type="date" value={h.date} onChange={(e) => onChange({ holidays: hol.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)) })} />
          <input type="text" placeholder="Name" value={h.name || ''} onChange={(e) => onChange({ holidays: hol.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          <button className="btn ghost sm icon" style={{ flex: '0 0 auto' }} onClick={() => onChange({ holidays: hol.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => onChange({ holidays: [...hol, { date: dayKey(), name: '' }] })}><Plus size={13} />Add holiday</button>
      <p className="muted small">Holidays repeat on the same date every year. Times use the system time zone.</p>
    </>
  );
}

// ------------------------------------------------------------------ prompts
// Everything about what callers hear in a Menu / Play message block, edited in place.
// Text and recordings made here belong to the block (data.ownPrompt); editing them never
// changes a shared prompt picked from the library, which is copied into a new one instead.
function PromptEditor({ node, flowName, onChange, field = 'promptId', heading, placeholder, name }) { // field: which of the block's prompts
  const d = node.data;
  const ownKey = field === 'promptId' ? 'ownPrompt' : `${field}Own`;
  const dir = useDirectory();
  const toast = useToast();
  const p = dir.prompts.find((x) => x.id === Number(d[field]));
  const own = !!(p && d[ownKey]);
  const [mode, setMode] = useState(!p || (own && p.kind === 'tts') ? 'text' : own ? 'recording' : 'library');
  const [text, setText] = useState(p?.kind === 'tts' ? p.tts_text || '' : '');
  const [voice, setVoice] = useState(p?.kind === 'tts' ? p.tts_voice || null : null);
  const [state, setState] = useState(''); // '', 'working', 'saved'
  const [version, setVersion] = useState(0);
  const isMenu = node.type === 'menu';
  const isStart = node.type === 'start';
  const autoName = `${flowName || 'Call flow'} – ${name || d.label || (isMenu ? 'Menu' : 'Message')}`;

  // Create this block's own prompt the first time it's needed.
  const ensureOwn = async (kind, ttsText) => {
    if (own) return p;
    const np = await api.post('/api/prompts', { name: autoName, kind, tts_text: ttsText || null, tts_voice: kind === 'tts' ? voice : null });
    onChange({ [field]: np.id, [ownKey]: true });
    return np;
  };
  const done = async () => { setVersion((v) => v + 1); await dir.refresh(); setState('saved'); setTimeout(() => setState(''), 2000); };

  const saveText = async () => {
    const t = text.trim();
    // Nothing typed, or unchanged from what is already playing (own or shared prompt).
    if (!t || (p?.kind === 'tts' && t === (p.tts_text || '').trim() && (voice || null) === (p.tts_voice || null))) return;
    setState('working');
    try {
      if (own) await api.put(`/api/prompts/${p.id}`, { tts_text: t, tts_voice: voice });
      else await ensureOwn('tts', t);
      await done();
    } catch (e) { setState(''); toast(e.message, 'error'); }
  };
  const upload = async (file) => {
    if (!file) return;
    setState('working');
    try { const target = await ensureOwn('upload'); await api.upload(`/api/prompts/${target.id}/upload`, file); await done(); } catch (e) { setState(''); toast(e.message, 'error'); }
  };
  const forPhone = async () => {
    try { await ensureOwn('phone'); await dir.refresh(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="section-title" style={{ marginTop: 4, display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>{heading || (isStart ? 'Callers hear first (optional)' : node.type === 'hangup' ? 'Callers hear before hanging up (optional)' : 'Callers hear')}</span>
        {p && <button type="button" className="btn ghost sm" style={{ textTransform: 'none', letterSpacing: 0 }} onClick={() => { onChange({ [field]: null, [ownKey]: false }); setText(''); }}>Remove</button>}
      </div>
      <div className="seg" style={{ marginBottom: 10 }}>
        <button type="button" className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}><Type size={12} style={{ verticalAlign: -2 }} /> Text</button>
        <button type="button" className={mode === 'recording' ? 'on' : ''} onClick={() => setMode('recording')}><Mic size={12} style={{ verticalAlign: -2 }} /> Recording</button>
        <button type="button" className={mode === 'library' ? 'on' : ''} onClick={() => setMode('library')}>Saved prompt</button>
      </div>

      {mode === 'text' && <>
        <textarea rows={isMenu ? 5 : 4} value={text} onChange={(e) => setText(e.target.value)} onBlur={saveText}
          placeholder={placeholder || (isMenu ? 'Thanks for calling. For sales, press 1. For service, press 2.' : node.type === 'hangup' ? 'e.g. "Our office is closed. Please call back during business hours."' : isStart ? 'Optional: e.g. "Thank you for calling. This call may be recorded."' : 'Thanks for calling. Please hold while we connect you.')} />
        <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
          <VoiceSelect value={voice} allowDefault onChange={setVoice} />
          <PreviewButton text={text} voice={voice} />
        </div>
        <div className="row" style={{ alignItems: 'center', marginTop: 6 }}>
          <span className="hint" style={{ flex: 1 }}>{state === 'working' ? 'Generating voice… (a few seconds)' : state === 'saved' ? 'Saved. Callers hear the new version now.' : 'Saved automatically when you click away. Preview first if you like.'}</span>
          <button type="button" className="btn sm primary" style={{ flex: '0 0 auto' }} disabled={!text.trim() || state === 'working'} onClick={saveText}>Save audio</button>
        </div>
      </>}

      {mode === 'recording' && <>
        <label className="btn sm" style={{ cursor: 'pointer' }}><Upload size={13} />Upload audio file<input type="file" accept="audio/*" hidden onChange={(e) => upload(e.target.files[0])} /></label>
        <div className="hint" style={{ marginTop: 8 }}>
          {own ? <>Or record it from any phone: dial <b className="mono">*77{p.id}</b>, speak after the tone, then press #.</>
            : <>Or <a href="#" onClick={(e) => { e.preventDefault(); forPhone(); }}>record it from a phone</a>; you'll get a code to dial.</>}
        </div>
        {state === 'working' && <div className="hint">Uploading…</div>}
      </>}

      {mode === 'library' && <PromptSelect value={d[field]} onChange={(v) => onChange({ [field]: v, [ownKey]: false })} />}

      {mode !== 'library' && p?.has_audio && own && (
        <audio key={`${p.id}-${version}-${p.updated_at}`} controls preload="none" src={`/api/prompts/${p.id}/audio?v=${new Date(p.updated_at).getTime()}-${version}`} style={{ marginTop: 10, width: '100%' }} />
      )}
      {mode !== 'library' && p && !own && <div className="hint" style={{ marginTop: 8 }}>Currently using the saved prompt "{p.name}". Typing text or adding a recording here replaces it for this block only.</div>}
    </div>
  );
}

export function PromptSelect({ value, onChange }) {
  const dir = useDirectory();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0); // bumps after an edit so the player loads the new audio
  const p = dir.prompts.find((x) => x.id === Number(value));
  return (
    <>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <select value={value || ''} onChange={(e) => (e.target.value === '__new' ? setCreating(true) : onChange(e.target.value ? Number(e.target.value) : null))}>
          <option value="">None</option>
          {dir.prompts.map((x) => <option key={x.id} value={x.id}>{x.name}{x.has_audio ? '' : ' (no audio yet)'}</option>)}
          <option value="__new">+ New prompt…</option>
        </select>
        {p && <button type="button" className="btn sm" style={{ flex: '0 0 auto' }} onClick={() => setEditing(true)}><Pencil size={13} />Edit</button>}
      </div>
      {p?.kind === 'tts' && p.tts_text && <div className="hint" style={{ marginTop: 6 }}>"{p.tts_text}"</div>}
      {p?.has_audio && <audio key={`${p.id}-${version}`} controls preload="none" src={`/api/prompts/${p.id}/audio?v=${version}-${new Date(p.updated_at).getTime()}`} style={{ marginTop: 8, width: '100%' }} />}
      {p && !p.has_audio && <div className="hint" style={{ color: 'var(--amber)' }}>No audio yet. Dial *77{p.id} from a phone to record it.</div>}
      {creating && <PromptDrawer onClose={() => setCreating(false)} onSaved={(np) => { setCreating(false); dir.refresh(); if (np) onChange(np.id); }} />}
      {editing && p && <PromptDrawer prompt={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setVersion((v) => v + 1); dir.refresh(); }} />}
    </>
  );
}

// Saved recordings, with where each one is used (Call Flows > Audio Prompts).
function Prompts() {
  const { data, reload } = useData('/api/prompts');
  const { data: usage, reload: reloadUsage } = useData('/api/prompts/usage');
  const [editing, setEditing] = useState(null);
  const [del, setDel] = useState(null);
  const [uses, setUses] = useState(null);
  const dir = useDirectory();
  const done = () => { setEditing(null); reload(); reloadUsage(); dir.refresh(); };
  const usesOf = (p) => (usage || {})[p.id] || [];
  const nav = useNavigate();
  return (
    <>
      <div className="toolbar"><div className="muted">Greetings and menu messages used in call flows.</div><div className="spacer" /><button className="btn primary" onClick={() => setEditing({})}><Plus size={16} />New Prompt</button></div>
      <div className="card">
        {data && data.length === 0 ? <Empty icon={Volume2} title="No prompts yet" text="Type text to have it read aloud, upload a recording, or record one from any phone." /> : (
          <table className="t"><thead><tr><th>Name</th><th>Used in</th><th>Source</th><th>Listen</th><th>Record by phone</th><th></th></tr></thead>
            <tbody>{(data || []).map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 500 }}>{p.name}{p.kind === 'tts' && <div className="muted small" style={{ fontWeight: 400, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{p.tts_text}"</div>}</td>
                <td>{!usage ? null : usesOf(p).length
                  ? <button type="button" className="btn ghost sm" style={{ whiteSpace: 'nowrap' }} onClick={() => setUses(p)}>{usesOf(p).length} {usesOf(p).length === 1 ? 'place' : 'places'}</button>
                  : <span className="badge">Not used</span>}</td>
                <td className="muted">{{ tts: 'Text to speech', upload: 'Uploaded file', phone: 'Recorded by phone' }[p.kind]}</td>
                <td>{p.has_audio ? <audio key={`${p.id}-${p.updated_at}`} controls preload="none" src={`/api/prompts/${p.id}/audio?v=${new Date(p.updated_at).getTime()}`} /> : <span className="badge amber">No audio</span>}</td>
                <td className="mono">*77{p.id}</td>
                <td className="actions"><button className="btn ghost sm" onClick={() => setEditing(p)}>Edit</button><button className="btn ghost sm icon" onClick={() => setDel(p)}><Trash2 size={14} /></button></td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {editing && <PromptDrawer prompt={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={done} />}
      {uses && <Drawer title={uses.name} onClose={() => setUses(null)} footer={<><div className="spacer" /><button className="btn" onClick={() => setUses(null)}>Close</button></>}>
        <div className="section-title" style={{ marginTop: 0 }}>Used in {usesOf(uses).length} {usesOf(uses).length === 1 ? 'place' : 'places'}</div>
        <div className="order-list">{usesOf(uses).map((u, i) => (
          <a key={i} className="order-item" href={u.link} onClick={(e) => { e.preventDefault(); nav(u.link); }} style={{ color: 'inherit', textDecoration: 'none' }}>
            {u.kind === 'flow' ? <Workflow size={16} /> : <UsersRound size={16} />}
            <span className="n">{u.name} <span className="muted">· {u.where}</span></span>
            <span className="muted small">{u.kind === 'flow' ? 'Call flow' : 'Ring group'}</span>
          </a>
        ))}</div>
      </Drawer>}
      {del && <Confirm title={`Delete "${del.name}"?`} message={usesOf(del).length ? `It's used in ${usesOf(del).length} ${usesOf(del).length === 1 ? 'place' : 'places'}, which will play nothing in its place.` : "It isn't used anywhere."} onConfirm={async () => { await api.del(`/api/prompts/${del.id}`); setDel(null); reload(); reloadUsage(); dir.refresh(); }} onCancel={() => setDel(null)} />}
    </>
  );
}

function PromptDrawer({ prompt, onClose, onSaved }) {
  const [mode, setMode] = useState(prompt?.kind === 'upload' ? 'upload' : prompt?.kind === 'phone' ? 'phone' : 'tts');
  const [name, setName] = useState(prompt?.name || '');
  const [text, setText] = useState(prompt?.tts_text || '');
  const [voice, setVoice] = useState(prompt?.tts_voice || null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState(null);
  const toast = useToast();
  const save = async () => {
    setBusy(true); setErr('');
    try {
      let p = prompt;
      if (!p) p = await api.post('/api/prompts', { name, kind: mode, tts_text: mode === 'tts' ? text : null, tts_voice: mode === 'tts' ? voice : null });
      else p = await api.put(`/api/prompts/${p.id}`, { name, tts_voice: mode === 'tts' ? voice : undefined, tts_text: mode === 'tts' && (text !== prompt.tts_text || prompt.kind !== 'tts') ? text : undefined });
      if (mode === 'upload' && file) p = await api.upload(`/api/prompts/${p.id}/upload`, file);
      if (mode === 'phone') { setCreated(p); return; }
      toast('Prompt saved');
      onSaved(p);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Drawer title={prompt ? 'Edit Prompt' : 'New Prompt'} onClose={() => (created ? onSaved(created) : onClose())} footer={created ? <><div className="spacer" /><button className="btn primary" onClick={() => onSaved(created)}>Done</button></> : <><div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name || (mode === 'tts' && !text) || (mode === 'upload' && !file && !prompt)} onClick={save}>{busy ? 'Working…' : 'Save'}</button></>}>
      {err && <div className="alert error">{err}</div>}
      {created ? <div>
        <div className="alert info" style={{ display: 'block' }}>From any phone, dial <b className="mono" style={{ fontSize: 16 }}>*77{created.id}</b>. Speak after the tone, then press # (or hang up) when you're done.</div>
        <p className="muted small">The recording replaces this prompt's audio each time you dial it, so you can re-record any time.</p>
      </div> : <>
        <Field label="Name"><input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Main greeting" /></Field>
        <Field label="Audio source">
          <div className="seg">
            <button type="button" className={mode === 'tts' ? 'on' : ''} onClick={() => setMode('tts')}><Type size={13} style={{ verticalAlign: -2 }} /> Type text</button>
            <button type="button" className={mode === 'upload' ? 'on' : ''} onClick={() => setMode('upload')}><Upload size={13} style={{ verticalAlign: -2 }} /> Upload</button>
            <button type="button" className={mode === 'phone' ? 'on' : ''} onClick={() => setMode('phone')}><Mic size={13} style={{ verticalAlign: -2 }} /> Record by phone</button>
          </div>
        </Field>
        {mode === 'tts' && <>
          <Field label="Text to speak"><textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Thank you for calling. For sales, press 1. For service, press 2." /></Field>
          <Field label="Voice"><div className="row" style={{ alignItems: 'center' }}><VoiceSelect value={voice} allowDefault onChange={setVoice} /><PreviewButton text={text} voice={voice} /></div></Field>
        </>}
        {mode === 'upload' && <Field label="Audio file" hint="WAV, MP3, M4A or similar. Converted automatically."><input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files[0])} /></Field>}
        {mode === 'phone' && <p className="muted small">After saving you'll get a code to dial from any phone on the system.{prompt ? ` For this prompt: *77${prompt.id}.` : ''}</p>}
      </>}
    </Drawer>
  );
}

export { Switch, Play };
