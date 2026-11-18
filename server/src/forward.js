// Call forwarding, stored in Asterisk's database: CFNUM/<ext> is the number, CF/<ext> is set while forwarding is on,
// and CFGRP/<ext> is set when ring group and queue calls forward too (otherwise those skip the user while forwarding).
const clean = (n) => String(n || '').replace(/[^0-9*#+]/g, '').slice(0, 32);

async function dbGet(ami, family, key) {
  const r = await ami.action({ Action: 'DBGet', Family: family, Key: key }).catch(() => null);
  return r?.events?.[0]?.Val || '';
}

export async function getForward(ami, ext) {
  const [number, active, groups] = await Promise.all([dbGet(ami, 'CFNUM', ext), dbGet(ami, 'CF', ext), dbGet(ami, 'CFGRP', ext)]);
  return { number: number || active, on: !!active, groups: groups === '1' };
}

// number: new forward number (optional); on: true/false to switch forwarding (optional);
// groups: true/false to forward group and queue calls too (optional).
export async function setForward(ami, ext, { number, on, groups }) {
  if (groups !== undefined) {
    await ami.action(groups ? { Action: 'DBPut', Family: 'CFGRP', Key: ext, Val: '1' } : { Action: 'DBDel', Family: 'CFGRP', Key: ext }).catch(() => null);
  }
  if (number !== undefined) {
    const n = clean(number);
    await ami.action(n ? { Action: 'DBPut', Family: 'CFNUM', Key: ext, Val: n } : { Action: 'DBDel', Family: 'CFNUM', Key: ext });
  }
  const cur = await getForward(ami, ext);
  const want = on === undefined ? cur.on : on;
  if (want && cur.number) await ami.action({ Action: 'DBPut', Family: 'CF', Key: ext, Val: cur.number });
  else await ami.action({ Action: 'DBDel', Family: 'CF', Key: ext }).catch(() => null);
  return getForward(ami, ext);
}
