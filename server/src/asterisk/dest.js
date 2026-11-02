// Destinations are stored as {type, target} and compile to a single dialplan application.
export const digits = (s) => String(s ?? '').replace(/[^0-9]/g, '');
export const extSafe = (s) => String(s ?? '').replace(/[^0-9*#]/g, '');
export const idSafe = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '');

// Normalize a phone number the same way the dialplan does for inbound DIDs:
// digits only, and a leading 1 dropped from 11-digit NANP numbers.
export function normalizeNumber(n) {
  if (String(n).trim() === '*') return '*';
  let d = digits(n);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

export function gotoDest(dest) {
  const d = dest || { type: 'hangup' };
  switch (d.type) {
    case 'user':
    case 'group':
      return extSafe(d.target) ? `Goto(asterfi-ext,${extSafe(d.target)},1)` : 'Hangup()';
    case 'voicemail':
      return extSafe(d.target) ? `Goto(asterfi-vm,${extSafe(d.target)},1)` : 'Hangup()';
    case 'flow':
      return Number.isInteger(Number(d.target)) && d.target !== ''
        ? `Goto(asterfi-flow-${Number(d.target)},s,1)` : 'Hangup()';
    case 'external':
      return digits(d.target) ? `Goto(asterfi-outbound,${digits(d.target)},1)` : 'Hangup()';
    default:
      return 'Hangup()';
  }
}

// Escape a value placed inside a dialplan application argument.
export function dpEsc(s) {
  return String(s ?? '').replace(/[\\,|()"'$;\[\]{}\r\n]/g, ' ').trim();
}
