// Orthogonal wire routing for the call-flow designer.
// All wires are routed together on a grid: blocks are obstacles, and a wire pays a heavy
// penalty for running along a cell another wire already runs along in the same direction
// (crossing at right angles is cheap). Fewer bends are preferred.

const G = 10;            // grid cell size (px)
const PAD = 12;          // clearance around blocks
const STUB = 20;         // straight run out of / into a handle
const TURN = 6;          // cost of a bend
const PARALLEL = 60;     // cost of sharing a cell with a wire going the same way
const CROSS = 2;         // cost of crossing another wire
const MARGIN = 160;      // free space around the drawing for detours
const MERGE = 4;         // cells before a shared input where wires may join
const MAX_CELLS = 400000;

// dirs: 0 right, 1 left, 2 down, 3 up
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const H = 1, V = 2;

class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

/**
 * @param rects  [{x, y, w, h}] block rectangles (absolute)
 * @param wires  [{id, sx, sy, tx, ty}] source handle (right side) and target handle (left side)
 * @returns Map id -> [[x,y], ...] polyline, or missing when no route was found
 */
export function routeWires(rects, wires) {
  const out = new Map();
  if (!wires.length) return out;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) { minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); }
  for (const w of wires) { minX = Math.min(minX, w.sx, w.tx); minY = Math.min(minY, w.sy, w.ty); maxX = Math.max(maxX, w.sx, w.tx); maxY = Math.max(maxY, w.sy, w.ty); }
  const ox = Math.floor((minX - MARGIN) / G) * G, oy = Math.floor((minY - MARGIN) / G) * G;
  const cols = Math.ceil((maxX + MARGIN - ox) / G) + 1, rows = Math.ceil((maxY + MARGIN - oy) / G) + 1;
  if (cols * rows > MAX_CELLS) return out;

  const blocked = new Uint8Array(cols * rows);
  for (const r of rects) {
    const c0 = Math.max(0, Math.floor((r.x - PAD - ox) / G)), c1 = Math.min(cols - 1, Math.ceil((r.x + r.w + PAD - ox) / G));
    const r0 = Math.max(0, Math.floor((r.y - PAD - oy) / G)), r1 = Math.min(rows - 1, Math.ceil((r.y + r.h + PAD - oy) / G));
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) blocked[y * cols + x] = 1;
  }
  const used = new Uint8Array(cols * rows); // H/V bits of wires already routed
  const owner = new Int32Array(cols * rows).fill(-1); // which target the wire in this cell goes to
  const targets = new Map();
  const cell = (px, py) => [Math.round((px - ox) / G), Math.round((py - oy) / G)];

  // Short wires first: they have the fewest alternatives.
  const order = [...wires].sort((a, b) => (Math.abs(a.tx - a.sx) + Math.abs(a.ty - a.sy)) - (Math.abs(b.tx - b.sx) + Math.abs(b.ty - b.sy)));
  for (const w of order) {
    const [sc, sr] = cell(w.sx + STUB, w.sy);
    const [ec, er] = cell(w.tx - STUB, w.ty);
    const tk = `${w.tx},${w.ty}`;
    if (!targets.has(tk)) targets.set(tk, targets.size);
    const group = targets.get(tk); // wires into the same input may merge
    const path = search(sc, sr, ec, er, group);
    if (!path) continue;
    // Mark occupancy so later wires avoid running alongside this one.
    for (let i = 1; i < path.length; i++) {
      const [ac, ar] = path[i - 1], [bc, br] = path[i];
      const bit = ar === br ? H : V;
      used[ar * cols + ac] |= bit; used[br * cols + bc] |= bit;
      owner[ar * cols + ac] = group; owner[br * cols + bc] = group;
    }
    // Grid cells -> points, keeping the handle rows exact so wires leave/enter straight.
    const pts = path.map(([c, r]) => [ox + c * G, oy + r * G]);
    const startRow = pts[0][1], endRow = pts[pts.length - 1][1];
    for (let i = 0; i < pts.length && pts[i][1] === startRow; i++) pts[i][1] = w.sy;
    for (let i = pts.length - 1; i >= 0 && pts[i][1] === endRow; i--) pts[i][1] = w.ty;
    out.set(w.id, simplify([[w.sx, w.sy], ...pts, [w.tx, w.ty]]));
  }
  return out;

  function search(sc, sr, ec, er, group) {
    if (sc < 0 || sr < 0 || ec < 0 || er < 0 || sc >= cols || ec >= cols || sr >= rows || er >= rows) return null;
    const N = cols * rows;
    const best = new Float64Array(N * 4).fill(Infinity);
    const prev = new Int32Array(N * 4).fill(-1);
    const heap = new Heap();
    const h = (c, r) => Math.abs(c - ec) + Math.abs(r - er);
    const s0 = (sr * cols + sc) * 4 + 0; // leave heading right
    best[s0] = 0;
    heap.push([h(sc, sr), 0, sc, sr, 0]);
    let goal = -1, steps = 0;
    while (heap.size && steps++ < 200000) {
      const [, g, c, r, d] = heap.pop();
      const k = (r * cols + c) * 4 + d;
      if (g > best[k]) continue;
      if (c === ec && r === er && d === 0) { goal = k; break; }
      for (let nd = 0; nd < 4; nd++) {
        if ((d === 0 && nd === 1) || (d === 1 && nd === 0) || (d === 2 && nd === 3) || (d === 3 && nd === 2)) continue;
        const nc = c + DX[nd], nr = r + DY[nd];
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        const isEnd = nc === ec && nr === er;
        if (blocked[ni] && !isEnd) continue;
        const bit = nd < 2 ? H : V;
        let cost = 1 + (nd !== d ? TURN : 0);
        // Wires into the same input may merge, but only on the final approach to it.
        const merging = owner[ni] === group && Math.abs(nc - ec) + Math.abs(nr - er) <= MERGE;
        if (!merging) { if (used[ni] & bit) cost += PARALLEL; else if (used[ni]) cost += CROSS; }
        const ng = g + cost;
        const nk = ni * 4 + nd;
        if (ng < best[nk]) { best[nk] = ng; prev[nk] = k; heap.push([ng + h(nc, nr), ng, nc, nr, nd]); }
      }
    }
    if (goal < 0) return null;
    const cells = [];
    for (let k = goal; k >= 0; k = prev[k]) { const i = k >> 2; cells.push([i % cols, Math.floor(i / cols)]); }
    return cells.reverse();
  }
}

// Drop points that sit on a straight line between their neighbours.
function simplify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [out[out.length - 1], pts[i], pts[i + 1]];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Schematic decorations for routed wires:
//  - hops: where a horizontal run crosses another wire's vertical run, the horizontal wire jumps it
//  - dots: where a wire joins another wire headed to the same input, a junction dot
const HOP = 5;           // hop radius
const CLEAR = 10;        // keep hops away from bends and ends

const segmentsOf = (pts) => pts.slice(1).map((b, i) => ({ i, a: pts[i], b }));
const onSegment = ([x, y], { a, b }) =>
  (a[0] === b[0] && x === a[0] && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1]))
  || (a[1] === b[1] && y === a[1] && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]));

/**
 * @param routes Map id -> points (from routeWires)
 * @param wires  [{id, tx, ty}]
 * @returns Map id -> { pts, hops: {segmentIndex: [x...]}, dots: [[x, y]] }
 */
export function decorate(routes, wires) {
  const target = new Map(wires.map((w) => [w.id, `${w.tx},${w.ty}`]));
  const ids = [...routes.keys()];
  const out = new Map(ids.map((id) => [id, { pts: routes.get(id), hops: {}, dots: [] }]));

  // Junctions: walk each wire from its source to the first grid point that lies on another
  // wire going to the same input (but not the input itself).
  const dotKeys = new Set();
  const byTarget = new Map();
  for (const id of ids) { const k = target.get(id); if (!byTarget.has(k)) byTarget.set(k, []); byTarget.get(k).push(id); }
  for (const [k, group] of byTarget) {
    if (group.length < 2) continue;
    const [tx, ty] = k.split(',').map(Number);
    for (const id of group) {
      const others = group.filter((o) => o !== id).flatMap((o) => segmentsOf(routes.get(o)));
      let hit = null;
      for (const { a, b } of segmentsOf(routes.get(id))) {
        const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        for (let t = 0; t <= n && !hit; t += 2) {
          const p = [a[0] + Math.sign(b[0] - a[0]) * t, a[1] + Math.sign(b[1] - a[1]) * t];
          if (Math.abs(p[0] - tx) + Math.abs(p[1] - ty) < 4) break; // meeting only at the input itself
          // A junction is where this wire joins another and continues along it, not a mere crossing.
          const ahead = [p[0] + Math.sign(b[0] - a[0]) * 2, p[1] + Math.sign(b[1] - a[1]) * 2];
          const nextSeg = (p[0] === b[0] && p[1] === b[1]) ? null : ahead;
          if (others.some((sg) => onSegment(p, sg) && (!nextSeg || onSegment(nextSeg, sg)))) hit = p;
          else if (p[0] === b[0] && p[1] === b[1] && others.some((sg) => onSegment(p, sg) && sg.a[0] !== sg.b[0] && a[1] === b[1])) hit = null;
        }
        if (hit) break;
      }
      const key = hit && `${hit[0]},${hit[1]}`;
      if (hit && !dotKeys.has(key)) { dotKeys.add(key); out.get(group[0]).dots.push(hit); }
    }
  }

  // Hops: horizontal runs jump over other wires' vertical runs.
  const all = ids.map((id) => ({ id, segs: segmentsOf(routes.get(id)) }));
  for (const { id, segs } of all) {
    for (const s of segs) {
      if (s.a[1] !== s.b[1]) continue;
      const y = s.a[1], x1 = Math.min(s.a[0], s.b[0]), x2 = Math.max(s.a[0], s.b[0]);
      const xs = [];
      for (const o of all) {
        if (o.id === id) continue;
        for (const v of o.segs) {
          if (v.a[0] !== v.b[0]) continue;
          const x = v.a[0], y1 = Math.min(v.a[1], v.b[1]), y2 = Math.max(v.a[1], v.b[1]);
          if (x > x1 + CLEAR && x < x2 - CLEAR && y > y1 + 2 && y < y2 - 2 && !dotKeys.has(`${x},${y}`)) xs.push(x);
        }
      }
      if (xs.length) out.get(id).hops[s.i] = [...new Set(xs)].sort((p, q) => p - q);
    }
  }
  return out;
}

// SVG path with rounded corners and hops (half-loops) on horizontal runs.
export function pathFromPoints(pts, radius = 8, hops = {}) {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  let cur = pts[0];
  const n = pts.length;
  for (let i = 1; i < n; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i];
    // Where this straight run ends: before the next bend's curve, or at the final point.
    let end = [x, y], corner = null;
    if (i < n - 1) {
      const [nx, ny] = pts[i + 1];
      const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
      end = [x - Math.sign(x - px) * r, y - Math.sign(y - py) * r];
      corner = { q: [x, y], b: [x + Math.sign(nx - x) * r, y + Math.sign(ny - y) * r] };
    }
    if (py === y && hops[i - 1]?.length) {
      const dir = Math.sign(x - px) || 1;
      const list = [...hops[i - 1]].sort((a, b) => dir * (a - b));
      for (const h of list) {
        if ((h - cur[0]) * dir <= HOP || (end[0] - h) * dir <= HOP) continue;
        d += ` L ${h - dir * HOP} ${y} A ${HOP} ${HOP} 0 0 ${dir > 0 ? 1 : 0} ${h + dir * HOP} ${y}`;
        cur = [h + dir * HOP, y];
      }
    }
    d += ` L ${end[0]} ${end[1]}`;
    if (corner) { d += ` Q ${corner.q[0]} ${corner.q[1]} ${corner.b[0]} ${corner.b[1]}`; cur = corner.b; } else cur = end;
  }
  return d;
}
