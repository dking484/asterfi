// Checks GitHub for a newer AsterFi release. The check is a single HTTPS request to api.github.com,
// made at most every 6 hours ("Check now" in Settings > System forces one).
import { asterfiVersion } from './system.js';

const REPO = process.env.ASTERFI_UPDATE_REPO || 'dking484/asterfi';
const EVERY_MS = 6 * 60 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000; // "Check now" can't hammer GitHub (60 unauthenticated requests an hour)

// "v0.10.2" -> [0, 10, 2]; anything after the numbers (e.g. "-beta") is ignored.
const parts = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
export function isNewer(latest, current) {
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let last = null; // { checkedAt, latest, url, publishedAt, notes, error }
let inFlight = null;

async function fetchLatest() {
  const current = await asterfiVersion();
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `AsterFi/${current}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return { checkedAt: new Date(), latest: null, error: null };
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const j = await r.json();
    return { checkedAt: new Date(), latest: j.tag_name, name: j.name, url: j.html_url, publishedAt: j.published_at, notes: String(j.body || '').slice(0, 4000), error: null };
  } catch (e) {
    return { ...(last || {}), checkedAt: new Date(), error: `Couldn't reach GitHub: ${e.name === 'TimeoutError' ? 'timed out' : e.message}` };
  }
}

export async function updateStatus({ force = false } = {}) {
  const age = last ? Date.now() - new Date(last.checkedAt).getTime() : Infinity;
  if (age > (force ? MIN_GAP_MS : EVERY_MS)) {
    inFlight ||= fetchLatest().then((r) => { last = r; }).finally(() => { inFlight = null; });
    await inFlight;
  }
  const current = await asterfiVersion();
  return {
    repo: REPO, current, ...(last || { checkedAt: null, latest: null }),
    available: !!(last?.latest && isNewer(last.latest, current)),
  };
}
