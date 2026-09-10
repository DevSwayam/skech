/**
 * Trace core: intent compiler and simulator. No DOM, no React — a pure port of the
 * `TraceCore` module from the original prototype so it can be unit-tested and reused.
 */
import { clamp, fmtPrice, fmtT, lerp, sgn } from './format';
import type {
  Column,
  EndReason,
  Fill,
  FlatInterval,
  GapRun,
  Leg,
  LogEntry,
  LogKind,
  Market,
  Overrides,
  Plan,
  Point,
  Position,
  Replan,
  RunResult,
  Scenario,
  Segment,
  SeriesPoint,
  SimEvent,
  SimStatus,
  Sizing,
  Stroke,
  Thresholds,
  TraceConfig,
  TurnName,
  QueueItem,
} from './types';

export { TURN_WORDS } from './format';

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ---------- synthetic market ----------

function shape(kind: Scenario, u: number, move: number) {
  switch (kind) {
    case 'up':
      return move * u;
    case 'down':
      return -move * u;
    case 'v':
      return u < 0.5 ? -move * (u / 0.5) : -move + 1.6 * move * ((u - 0.5) / 0.5);
    case 'spike':
      return u < 0.3 ? move * (u / 0.3) : u < 0.6 ? move * (1 - (u - 0.3) / 0.3) : 0;
    case 'chop':
      return (move / 2) * Math.sin(u * Math.PI * 6);
    default:
      return 0;
  }
}

export function generateMarket(cfg: TraceConfig): Market {
  const H = cfg.horizonSec;
  const N = Math.max(600, Math.min(7200, Math.round(H / 0.5)));
  const rng = mulberry32(cfg.seed * 7919 + 13);
  const vol = cfg.volPct / 100;
  const move = cfg.movePct / 100;
  const sStep = vol / Math.sqrt(N);
  const prices = new Array<number>(N + 1);
  let noise = 0;
  prices[0] = cfg.refPrice;
  for (let i = 1; i <= N; i++) {
    noise += sStep * gauss(rng);
    prices[i] = cfg.refPrice * Math.exp(shape(cfg.scenario, i / N, move) + noise);
  }
  const at = (t: number) => {
    const u = clamp(t / H, 0, 1) * N;
    const i = Math.floor(u);
    return i >= N ? prices[N] : lerp(prices[i], prices[i + 1], u - i);
  };
  return { N, prices, at };
}

// ---------- intent compiler ----------

/** Ramer–Douglas–Peucker on (t, p) points, with `tol` in dollars. */
export function rdp(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i];
    const b = pts[j];
    let maxd = 0;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const u = (pts[k].t - a.t) / (b.t - a.t || 1e-9);
      const d = Math.abs(pts[k].p - (a.p + (b.p - a.p) * u));
      if (d > maxd) {
        maxd = d;
        idx = k;
      }
    }
    if (maxd > tol) {
      keep[idx] = true;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Per-leg notional cap: fixed margin (L × M) or risk-at-stop, never above what margin allows. */
export function sizing(cfg: TraceConfig): Sizing {
  const L = cfg.leverage;
  const M = cfg.margin;
  const marginCap = L * M;
  if (cfg.sizing !== 'risk')
    return {
      mode: 'margin',
      cap: marginCap,
      marginCap,
      marginRequired: M,
      capped: false,
      stopFrac: null,
    };
  const stopFrac = cfg.stopPct / 100;
  const wanted = cfg.riskPerLeg / stopFrac;
  const cap = Math.min(wanted, marginCap);
  return {
    mode: 'risk',
    cap,
    wanted,
    marginCap,
    marginRequired: cap / L,
    capped: wanted > marginCap + 1e-9,
    stopFrac,
    plannedLoss: cap * stopFrac,
  };
}

/** Slope of a leg in percent per minute, with the word a trader would use. */
export function slopeTerm(rate: number) {
  const a = Math.abs(rate);
  return a >= 2 ? 'parabolic' : a >= 0.5 ? 'steep' : a >= 0.1 ? 'moderate' : 'shallow';
}

function annotate(legs: Leg[]) {
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  legs.forEach((l, i) => {
    l.movePct = (l.p1 / l.p0 - 1) * 100;
    l.minutes = Math.max((l.t1 - l.t0) / 60, 1e-6);
    l.rate = l.movePct / l.minutes;
    l.slope = slopeTerm(l.rate);
    // The turn at the end of this leg is a swing high (up then down) or a swing low.
    const next = legs[i + 1];
    if (next && Math.abs(next.t0 - l.t1) < 1e-6 && next.dir !== l.dir) {
      if (l.dir > 0) {
        l.turn = (lastHigh == null ? 'SH' : l.p1 > lastHigh ? 'HH' : 'LH') as TurnName;
        lastHigh = l.p1;
      } else {
        l.turn = (lastLow == null ? 'SL' : l.p1 < lastLow ? 'LL' : 'HL') as TurnName;
        lastLow = l.p1;
      }
    }
  });
  return legs;
}

/** Name the shape the legs spell out, in the words traders use. */
function readShape(legs: Leg[], ref: number): string[] {
  const out: string[] = [];
  if (!legs.length) return out;
  const dirs = legs.map((l) => l.dir);
  const close = (a: number, b: number) => Math.abs(a - b) / ref < 0.012;
  const covered = new Array(legs.length).fill(false);
  const span = (a: number, b: number) => `${fmtT(legs[a].t0)}–${fmtT(legs[b].t1)}`;
  const mark = (a: number, b: number) => {
    for (let k = a; k <= b; k++) covered[k] = true;
  };
  if (legs.length === 1)
    out.push(
      `Single ${legs[0].dir > 0 ? 'long' : 'short'} trend leg, ${legs[0].slope} (${legs[0].rate >= 0 ? '+' : ''}${legs[0].rate.toFixed(2)}% per minute).`,
    );
  if (legs.length === 2 && legs[1].reversal)
    out.push(
      dirs[0] < 0
        ? `V bottom at ${fmtT(legs[0].t1)}: short into the low, long out of it.`
        : `Inverted V (spike top) at ${fmtT(legs[0].t1)}: long into the high, short out of it.`,
    );
  // Largest patterns first, then smaller ones on legs not already explained.
  for (let i = 0; i + 5 < legs.length; i++) {
    const alt = [0, 1, 2, 3, 4].every(
      (k) => dirs[i + k] === -dirs[i + k + 1] && legs[i + k + 1].reversal,
    );
    if (!alt) continue;
    if (
      dirs[i] > 0 &&
      legs[i + 2].p1 > legs[i].p1 &&
      legs[i + 2].p1 > legs[i + 4].p1 &&
      close(legs[i].p1, legs[i + 4].p1)
    ) {
      out.push(
        `Head and shoulders top, ${span(i, i + 5)}: shoulder, higher head, lower shoulder. Neckline near ${fmtPrice((legs[i + 1].p1 + legs[i + 3].p1) / 2)}.`,
      );
      mark(i, i + 5);
    }
    if (
      dirs[i] < 0 &&
      legs[i + 2].p1 < legs[i].p1 &&
      legs[i + 2].p1 < legs[i + 4].p1 &&
      close(legs[i].p1, legs[i + 4].p1)
    ) {
      out.push(
        `Inverse head and shoulders, ${span(i, i + 5)}: a lower head between two shoulders. Neckline near ${fmtPrice((legs[i + 1].p1 + legs[i + 3].p1) / 2)}.`,
      );
      mark(i, i + 5);
    }
  }
  for (let i = 0; i + 3 < legs.length; i++) {
    if ([i, i + 1, i + 2, i + 3].some((k) => covered[k])) continue;
    const alt = [0, 1, 2].every((k) => dirs[i + k] === -dirs[i + k + 1] && legs[i + k + 1].reversal);
    if (!alt) continue;
    if (dirs[i] < 0 && close(legs[i].p1, legs[i + 2].p1)) {
      out.push(
        `W / double bottom, ${span(i, i + 3)}: two swing lows near ${fmtPrice((legs[i].p1 + legs[i + 2].p1) / 2)}. Trace trades all four legs; a discretionary trader usually only buys the second low.`,
      );
      mark(i, i + 3);
    }
    if (dirs[i] > 0 && close(legs[i].p1, legs[i + 2].p1)) {
      out.push(
        `M / double top, ${span(i, i + 3)}: two swing highs near ${fmtPrice((legs[i].p1 + legs[i + 2].p1) / 2)}. Trace trades all four legs; a discretionary trader usually only shorts the second high.`,
      );
      mark(i, i + 3);
    }
  }
  for (let i = 0; i + 2 < legs.length; i++) {
    if ([i, i + 1, i + 2].some((k) => covered[k])) continue;
    if (
      dirs[i] === dirs[i + 2] &&
      dirs[i + 1] === -dirs[i] &&
      legs[i + 1].reversal &&
      legs[i + 2].reversal &&
      Math.abs(legs[i + 1].movePct) < Math.abs(legs[i].movePct) * 0.5 &&
      Math.abs(legs[i + 1].movePct) < Math.abs(legs[i + 2].movePct) * 0.5
    ) {
      out.push(
        `${dirs[i] > 0 ? 'Bull' : 'Bear'} flag, ${span(i, i + 2)}: impulse, a ${legs[i + 1].slope} ${Math.abs(legs[i + 1].movePct).toFixed(1)}% pullback, then continuation.`,
      );
      mark(i, i + 2);
    }
  }
  const turns = legs.map((l) => l.turn).filter(Boolean) as TurnName[];
  const hh = turns.filter((t) => t === 'HH').length;
  const hl = turns.filter((t) => t === 'HL').length;
  const lh = turns.filter((t) => t === 'LH').length;
  const ll = turns.filter((t) => t === 'LL').length;
  const peaks = legs.filter((l) => ['SH', 'HH', 'LH'].includes(l.turn!)).map((l) => l.p1);
  const troughs = legs.filter((l) => ['SL', 'LL', 'HL'].includes(l.turn!)).map((l) => l.p1);
  if (turns.length >= 3 && hh + hl >= 2 && lh + ll === 0)
    out.push(
      `Uptrend structure: ${hh} higher high${hh === 1 ? '' : 's'} and ${hl} higher low${hl === 1 ? '' : 's'}, no lower ones. Traders buy the higher lows.`,
    );
  else if (turns.length >= 3 && lh + ll >= 2 && hh + hl === 0)
    out.push(
      `Downtrend structure: ${lh} lower high${lh === 1 ? '' : 's'} and ${ll} lower low${ll === 1 ? '' : 's'}, no higher ones. Traders sell the lower highs.`,
    );
  else if (
    turns.length >= 3 &&
    peaks.length >= 2 &&
    troughs.length >= 2 &&
    Math.max(...peaks) - Math.min(...peaks) < ref * 0.015 &&
    Math.max(...troughs) - Math.min(...troughs) < ref * 0.015
  )
    out.push(
      `Range / consolidation: swing highs near ${fmtPrice(peaks.reduce((a, b) => a + b) / peaks.length)} and lows near ${fmtPrice(troughs.reduce((a, b) => a + b) / troughs.length)}. Trading every swing in a range is what pays the fees.`,
    );
  else if (legs.length >= 3 && out.length === 0)
    out.push(
      `Zigzag of ${legs.length} legs with mixed structure (${
        [hh && `${hh} HH`, hl && `${hl} HL`, lh && `${lh} LH`, ll && `${ll} LL`]
          .filter(Boolean)
          .join(', ') || 'no repeated swings'
      }).`,
    );
  if (legs.length >= 3) {
    const steep = legs.filter((l) => l.slope === 'steep' || l.slope === 'parabolic').length;
    if (steep === legs.length)
      out.push('Every leg is steep or parabolic: the plan needs fast, precisely timed moves.');
    else if (steep === 0)
      out.push('All legs are moderate or shallow: small moves, so fees matter more than usual.');
  }
  return out;
}

export function fundingTimes(cfg: Pick<TraceConfig, 'fundingIntervalMin' | 'nextFundingMin' | 'horizonSec'>) {
  const out: number[] = [];
  const step = Math.max(60, (cfg.fundingIntervalMin || 60) * 60);
  for (let t = cfg.nextFundingMin * 60; t <= cfg.horizonSec && out.length < 500; t += step)
    out.push(t);
  return out;
}

type PartialLeg = Omit<
  Leg,
  'id' | 'reversal' | 'movePct' | 'minutes' | 'rate' | 'slope' | 'seg'
> & { seg?: number };

export function compile(strokes: Stroke[], cfg: TraceConfig, overrides?: Overrides): Plan {
  const ov: Overrides = overrides || { gaps: {}, flats: {} };
  const H = cfg.horizonSec;
  const K = cfg.columns;
  const colW = H / K;
  const ref = cfg.refPrice;
  const mn = new Array(K).fill(Infinity);
  const mx = new Array(K).fill(-Infinity);
  const hit = new Array(K).fill(false);
  const add = (c: number, p1: number, p2: number) => {
    if (c < 0 || c >= K) return;
    hit[c] = true;
    mn[c] = Math.min(mn[c], p1, p2);
    mx[c] = Math.max(mx[c], p1, p2);
  };
  for (const s of strokes) {
    if (!s.length) continue;
    if (s.length === 1) {
      add(Math.floor(s[0].t / colW), s[0].p, s[0].p);
      continue;
    }
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i];
      const b = s[i + 1];
      const tmin = Math.min(a.t, b.t);
      const tmax = Math.max(a.t, b.t);
      const c0 = clamp(Math.floor(tmin / colW), 0, K - 1);
      const c1 = clamp(Math.floor(Math.min(tmax, H - 1e-9) / colW), 0, K - 1);
      if (tmax - tmin < 1e-9) {
        add(c0, a.p, b.p);
        continue;
      }
      for (let c = c0; c <= c1; c++) {
        const ta = Math.max(tmin, c * colW);
        const tb = Math.min(tmax, (c + 1) * colW);
        const pa = a.p + (b.p - a.p) * ((ta - a.t) / (b.t - a.t));
        const pb = a.p + (b.p - a.p) * ((tb - a.t) / (b.t - a.t));
        add(c, pa, pb);
      }
    }
  }
  const cols: Column[] = [];
  for (let c = 0; c < K; c++)
    cols.push({
      c,
      t: (c + 0.5) * colW,
      p: hit[c] ? (mn[c] + mx[c]) / 2 : null,
      gap: !hit[c],
      bridged: false,
    });
  const anchored: boolean = hit[0];
  if (anchored) {
    // Art touching "now" is pinned to the live quote.
    cols[0].p = ref;
    cols[0].t = 0;
  }

  // gap runs
  const gaps: GapRun[] = [];
  let c = 0;
  while (c < K) {
    if (cols[c].gap) {
      let e = c;
      while (e < K && cols[e].gap) e++;
      const kind = c === 0 ? 'start' : e === K ? 'end' : 'mid';
      gaps.push({
        key: 'g' + c,
        startCol: c,
        endCol: e - 1,
        len: e - c,
        kind,
        t0: c * colW,
        t1: e * colW,
      });
      c = e;
    } else c++;
  }
  for (const g of gaps) {
    if (g.kind !== 'mid') {
      g.action = g.kind;
      continue;
    }
    g.default = g.len < cfg.gapMin ? 'bridge' : 'flat';
    g.action = cfg.mode === 'single' ? 'bridge' : ov.gaps[g.key] || g.default;
    if (g.action === 'bridge') {
      const pa = cols[g.startCol - 1];
      const pb = cols[g.endCol + 1];
      for (let k = g.startCol; k <= g.endCol; k++) {
        const u = (cols[k].t - pa.t) / (pb.t - pa.t);
        cols[k].p = lerp(pa.p!, pb.p!, u);
        cols[k].gap = false;
        cols[k].bridged = true;
      }
    }
  }
  // contiguous segments
  const segs: Segment[] = [];
  c = 0;
  while (c < K) {
    if (!cols[c].gap) {
      let e = c;
      while (e < K && !cols[e].gap) e++;
      const points = cols.slice(c, e).map((x) => ({ t: x.t, p: x.p! }));
      // Legs start and end on column boundaries so they meet gaps exactly; "now" stays at t = 0.
      if (!(c === 0 && anchored)) points[0] = { t: c * colW, p: points[0].p };
      points[points.length - 1] = { t: e * colW, p: points[points.length - 1].p };
      segs.push({ startCol: c, endCol: e - 1, points });
      c = e;
    } else c++;
  }

  const baseTol = (ref * cfg.tolPct) / 100;

  /** A sub-tolerance step shorter than gap_min is wobble at a turn, not a flat. */
  function absorbWobble(v0: Point[]): Point[] {
    let v = v0.slice();
    let changed = true;
    while (changed && v.length > 2) {
      changed = false;
      for (let i = 0; i < v.length - 1; i++) {
        const a = v[i];
        const b = v[i + 1];
        if (Math.abs(b.p - a.p) <= baseTol && b.t - a.t < cfg.gapMin * colW) {
          let drop: number;
          if (i === 0) drop = i + 1;
          else if (i + 1 === v.length - 1) drop = i;
          else {
            const mid = (v[i - 1].p + v[i + 2].p) / 2;
            drop = Math.abs(a.p - mid) >= Math.abs(b.p - mid) ? i + 1 : i;
          }
          v.splice(drop, 1);
          changed = true;
          break;
        }
      }
    }
    return v;
  }

  function legsFromVerts(vertsBySeg: Point[][]) {
    const legs: PartialLeg[] = [];
    const flats: PartialLeg[] = [];
    vertsBySeg.forEach((verts0, si) => {
      const verts = absorbWobble(verts0);
      const raw: PartialLeg[] = [];
      for (let i = 0; i < verts.length - 1; i++) {
        const dp = verts[i + 1].p - verts[i].p;
        raw.push({
          t0: verts[i].t,
          t1: verts[i + 1].t,
          p0: verts[i].p,
          p1: verts[i + 1].p,
          dir: Math.abs(dp) <= baseTol ? 0 : sgn(dp),
        } as PartialLeg);
      }
      for (let i = 0; i < raw.length; i++) {
        if (raw[i].dir === 0) {
          raw[i].key = 'f' + Math.round(raw[i].t0);
          raw[i].override = ov.flats[raw[i].key!] || cfg.flatDefault || 'flat';
          raw[i].holdable = i > 0 && raw[i - 1].dir !== 0;
          if (raw[i].override === 'hold' && raw[i].holdable) {
            raw[i].dir = raw[i - 1].dir;
            raw[i].held = true;
          }
        }
      }
      const merged: PartialLeg[] = [];
      for (const l of raw) {
        const last = merged[merged.length - 1];
        if (last && last.dir === l.dir && l.dir !== 0) {
          last.t1 = l.t1;
          last.p1 = l.p1;
          if (l.held) last.heldKey = l.key;
        } else merged.push({ ...l });
      }
      for (const l of merged) {
        l.seg = si;
        if (l.dir === 0) flats.push(l);
        else legs.push(l);
      }
    });
    return { legs, flats };
  }

  /** Collapse vertices to turning points: endpoints of same-direction runs. */
  function collapse(v0: Point[]): Point[] {
    const v = absorbWobble(v0);
    if (v.length < 3) return v;
    const out = [v[0]];
    for (let i = 1; i < v.length - 1; i++) {
      const d1 =
        Math.abs(v[i].p - out[out.length - 1].p) <= baseTol
          ? 0
          : sgn(v[i].p - out[out.length - 1].p);
      const d2 = Math.abs(v[i + 1].p - v[i].p) <= baseTol ? 0 : sgn(v[i + 1].p - v[i].p);
      if (d1 !== d2 || d1 === 0) out.push(v[i]);
    }
    out.push(v[v.length - 1]);
    return out;
  }

  // Vertices at the user's tolerance, then remove the smallest swings until the budget fits.
  const turnsAvailable = legsFromVerts(segs.map((seg) => rdp(seg.points, baseTol))).legs.length;
  const vertsBySeg = segs.map((seg) =>
    collapse(
      cfg.mode === 'single'
        ? [seg.points[0], seg.points[seg.points.length - 1]]
        : rdp(seg.points, baseTol),
    ),
  );
  let res = legsFromVerts(vertsBySeg);
  const legsAtBase = res.legs.length;
  let simplified = false;
  let droppedMaxPct = 0;
  const tol = baseTol;
  let guard = 0;
  while (res.legs.length > cfg.legBudget && guard++ < 500) {
    // Smallest swing anywhere: a directional step between consecutive turning points.
    let best: { si: number; i: number; amp: number } | null = null;
    vertsBySeg.forEach((v, si) => {
      for (let i = 0; i < v.length - 1; i++) {
        const amp = Math.abs(v[i + 1].p - v[i].p);
        if (amp <= baseTol) continue;
        if (!best || amp < best.amp) best = { si, i, amp };
      }
    });
    if (!best) break;
    const pick: { si: number; i: number; amp: number } = best;
    const v = vertsBySeg[pick.si];
    const i = pick.i;
    droppedMaxPct = Math.max(droppedMaxPct, (pick.amp / ref) * 100);
    simplified = true;
    if (v.length <= 2) v.splice(1, 1); // lone leg in its segment: the segment becomes flat
    else if (i === 0) v.splice(1, 1); // first swing: its end turn goes, it merges with the next
    else if (i === v.length - 2) v.splice(i, 1); // last swing: merges with the previous
    else v.splice(i, 2); // interior swing: both turns go, neighbours merge
    vertsBySeg[pick.si] = collapse(v);
    res = legsFromVerts(vertsBySeg);
  }
  const legs = res.legs as Leg[];
  const flats = res.flats as Leg[];
  legs.forEach((l, i) => {
    l.id = i + 1;
    l.reversal = i > 0 && Math.abs(legs[i - 1].t1 - l.t0) < 1e-6;
  });
  annotate(legs);
  const shapes = readShape(legs, ref);

  // flat intervals for display
  const flatIntervals: FlatInterval[] = [];
  for (const g of gaps) {
    if (g.kind === 'start')
      flatIntervals.push({ kind: 'start', t0: 0, t1: g.t1, key: g.key });
    else if (g.kind === 'end')
      flatIntervals.push({ kind: 'end', t0: g.t0, t1: H, key: g.key });
    else if (g.action === 'flat')
      flatIntervals.push({
        kind: 'gap',
        t0: g.t0,
        t1: g.t1,
        key: g.key,
        len: g.len,
        default: g.default,
      });
    else
      flatIntervals.push({
        kind: 'bridged',
        t0: g.t0,
        t1: g.t1,
        key: g.key,
        len: g.len,
        default: g.default,
      });
  }
  for (const f of flats)
    flatIntervals.push({
      kind: 'horizontal',
      t0: f.t0,
      t1: f.t1,
      key: f.key!,
      holdable: f.holdable,
      override: f.override,
      movePct: (f.p1 / f.p0 - 1) * 100,
    });
  flatIntervals.sort((a, b) => a.t0 - b.t0);

  // warnings and first-leg risk
  const warnings: string[] = [];
  const M = cfg.margin;
  const L = cfg.leverage;
  const f = cfg.feeRate;
  let first: Plan['first'] = null;
  if (!strokes.length)
    warnings.push(
      'Nothing drawn yet. A rising line plans a long, a falling line plans a short, a lifted pen plans no position.',
    );
  else if (!legs.length)
    warnings.push('No executable leg. The drawing has no direction after simplification.');
  if (legs.length) {
    const sz = sizing(cfg);
    const l = legs[0];
    const Q = sz.cap / l.p0;
    const d = l.dir;
    const B = M;
    const th = thresholds({ d, Q, P0: l.p0 }, B, cfg);
    const tpRaw = cfg.tpTarget > 0 ? (M + cfg.tpTarget - B + d * Q * l.p0) / (Q * (d - f)) : null;
    const planStopRaw =
      cfg.lossLimit > 0 ? (M - cfg.lossLimit - B + d * Q * l.p0) / (Q * (d - f)) : null;
    if (tpRaw != null && tpRaw <= 0)
      warnings.push(
        `Take profit +$${cfg.tpTarget} is unreachable on leg 1: a $${sz.cap.toFixed(0)} short can earn at most $${sz.cap.toFixed(0)} even if the price reaches zero. No take-profit order would be placed.`,
      );
    if (planStopRaw != null && planStopRaw <= 0 && sz.mode !== 'risk')
      warnings.push('The loss limit is larger than a long can lose; no stop would be placed.');
    if (sz.capped)
      warnings.push(
        `Risk $${cfg.riskPerLeg} with a ${cfg.stopPct}% stop asks for $${sz.wanted!.toFixed(0)} of exposure, more than ${L}× on $${M} allows. Capped at $${sz.cap.toFixed(0)}, so the planned loss per leg is $${sz.plannedLoss!.toFixed(2)}. Raise margin or leverage, or widen the stop.`,
      );
    first = { leg: l, Q, tp: th.tp, stop: th.stop, liq: th.liq, sizing: sz };
    if (cfg.lossLimit <= 0)
      warnings.push(
        'No loss limit. Real execution requires an explicit stop policy; the simulator will run without one.',
      );
    if (
      first.stop &&
      first.liq &&
      ((d > 0 && first.stop <= first.liq) || (d < 0 && first.stop >= first.liq))
    )
      warnings.push(
        'The stop sits beyond the liquidation estimate. Liquidation would come first. Lower the loss limit or the leverage.',
      );
    if (cfg.lossLimit <= 0 && sz.mode === 'risk') warnings.pop();
    if (cfg.lossLimit >= M)
      warnings.push(
        'Loss limit equals or exceeds margin. The venue liquidates before that loss is reached.',
      );
    if (cfg.mode === 'single' && turnsAvailable > 1)
      warnings.push(
        `SINGLE:Single trade reads only your start and end point: one ${legs[0].dir > 0 ? 'long' : 'short'}. The ${turnsAvailable - 1} turns in between are a forecast, not orders.`,
      );
    if (!anchored)
      warnings.push(
        `The drawing does not touch now. Leg 1 is a scheduled entry at ${fmtT(l.t0)}, filled at market, not at the drawn price.`,
      );
    if (simplified)
      warnings.push(
        `Your drawing has ${legsAtBase} legs; the budget is ${cfg.legBudget}. The ${legsAtBase - legs.length} smallest swing${legsAtBase - legs.length === 1 ? '' : 's'} (up to ${droppedMaxPct.toFixed(2)}%) were dropped; the largest ones are kept. The bold spine shows what will trade.`,
      );
  }
  const roundTrips = legs.length;
  const estFees = roundTrips * 2 * f * sizing(cfg).cap;
  const fundingEvents = fundingTimes(cfg).filter((t) =>
    legs.some((l) => t >= l.t0 && t <= l.t1),
  ).length;
  return {
    cols,
    gaps,
    segs,
    legs,
    flats,
    flatIntervals,
    warnings,
    tolUsed: tol,
    simplified,
    legsAtBase,
    turnsAvailable,
    anchored,
    first,
    roundTrips,
    estFees,
    fundingEvents,
    mode: cfg.mode,
    sizing: sizing(cfg),
    shapes,
  };
}

/** The sampled spine as a price function, for "if your path happens". */
export function spineAt(plan: Plan, cfg: TraceConfig) {
  const pts = plan.cols.filter((c) => !c.gap).map((c) => ({ t: c.t, p: c.p! }));
  if (!pts.length) return () => cfg.refPrice;
  return (t: number) => {
    if (t <= pts[0].t) return pts[0].p;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].p;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m].t <= t) lo = m;
      else hi = m;
    }
    return lerp(pts[lo].p, pts[hi].p, (t - pts[lo].t) / (pts[hi].t - pts[lo].t));
  };
}

// ---------- simulator ----------

export function thresholds(
  pos: { d: number; Q: number; P0: number },
  B: number,
  cfg: TraceConfig,
): Thresholds {
  const { d, Q, P0 } = pos;
  const M = cfg.margin;
  const f = cfg.feeRate;
  const mu = cfg.maintFrac;
  const tp = cfg.tpTarget > 0 ? (M + cfg.tpTarget - B + d * Q * P0) / (Q * (d - f)) : null;
  let stop = cfg.lossLimit > 0 ? (M - cfg.lossLimit - B + d * Q * P0) / (Q * (d - f)) : null;
  if (stop != null && stop <= 0) stop = null;
  const sz = sizing(cfg);
  if (sz.mode === 'risk') {
    const legStop = P0 * (1 - d * sz.stopFrac!);
    stop = stop == null ? legStop : d > 0 ? Math.max(stop, legStop) : Math.min(stop, legStop);
  }
  const liq = (B - d * Q * P0) / (Q * (mu - d));
  return {
    tp: tp !== null && tp > 0 ? tp : null,
    stop: stop !== null && stop > 0 ? stop : null,
    liq: liq > 0 ? liq : null,
  };
}

/**
 * Live simulator: steps forward in time and accepts a replan for anything past the
 * lock boundary. The same class backs both the live chart and the one-shot replay.
 */
export class LiveSim {
  cfg: TraceConfig;
  priceAt: (t: number) => number;
  live: boolean;
  H: number;
  N: number;
  dt: number;
  M: number;
  L: number;
  f: number;
  rule: string;
  outage: [number, number] | null;
  B: number;
  pos: Position | null;
  ended: boolean;
  endReason: EndReason | null;
  endT: number | null;
  status: SimStatus;
  fees = 0;
  funding = 0;
  minEq: number;
  maxLev = 0;
  log: LogEntry[] = [];
  fills: Fill[] = [];
  series: SeriesPoint[] = [];
  replans: Replan[] = [];
  step = 0;
  tPrev = 0;
  pPrev: number;
  pendingClose: { t: number; idx: number } | null = null;
  pendingEntry: { leg: Leg } | null = null;
  anchored: boolean;
  legs: Leg[];
  ev: SimEvent[] = [];
  evIdx = 0;
  commits = 0;

  constructor(plan: Plan, cfg: TraceConfig, priceAt: (t: number) => number, live = false) {
    this.cfg = cfg;
    this.priceAt = priceAt;
    this.live = live;
    this.H = cfg.horizonSec;
    this.N = Math.max(600, Math.min(7200, Math.round(this.H / 0.5)));
    this.dt = this.H / this.N;
    this.M = cfg.margin;
    this.L = cfg.leverage;
    this.f = cfg.feeRate;
    this.rule = cfg.entryRule || 'scheduled';
    this.outage = cfg.outageOn ? [cfg.outageFrom * 60, cfg.outageTo * 60] : null;
    this.B = this.M;
    this.pos = null;
    this.ended = !plan.legs.length && !live;
    this.endReason = this.ended ? 'no_legs' : null;
    this.endT = null;
    this.status = plan.legs.length ? 'AUTHORIZED' : live ? 'FLAT_WAITING' : 'CLOSED';
    this.minEq = this.M;
    this.pPrev = priceAt(0);
    this.anchored = plan.anchored;
    this.legs = plan.legs.slice();
    plan.legs.forEach((leg) => {
      this.ev.push({ t: leg.t0, type: 'open', leg });
      this.ev.push({ t: leg.t1, type: 'close', leg });
    });
    fundingTimes(cfg).forEach((t) => this.ev.push({ t, type: 'funding' }));
    this.sortEv(0);
  }

  get tNow() {
    return this.step * this.dt;
  }

  sortEv(from: number) {
    const order = { funding: 0, close: 1, open: 2 } as const;
    const tail = this.ev
      .slice(from)
      .sort((a, b) => a.t - b.t || order[a.type] - order[b.type]);
    this.ev = this.ev.slice(0, from).concat(tail);
  }

  say(t: number, kind: LogKind, text: string) {
    this.log.push({ t, kind, text });
  }

  inOutage(t: number) {
    return !!this.outage && t >= this.outage[0] && t < this.outage[1];
  }

  armed(leg: Leg, price: number) {
    const d = leg.dir;
    const lvl = leg.p0;
    return this.rule === 'limit'
      ? d > 0
        ? price <= lvl
        : price >= lvl
      : d > 0
        ? price >= lvl
        : price <= lvl;
  }

  open(t: number, p: number, leg: Leg) {
    const cap = sizing(this.cfg).cap;
    const cashBefore = this.B;
    const notional = Math.min(cap, this.L * this.B);
    if (notional < this.cfg.minNotional) {
      this.say(
        t,
        'skip',
        `Leg ${leg.id} skipped: allocatable equity too small ($${this.B.toFixed(2)}).`,
      );
      return;
    }
    const Q = notional / p;
    const fee = this.f * Q * p;
    this.B -= fee;
    this.fees += fee;
    this.pos = { d: leg.dir, Q, P0: p, t0: t, leg };
    this.status = 'OPEN';
    this.fills.push({
      t,
      side: leg.dir > 0 ? 'buy' : 'sell',
      action: 'open',
      Q,
      p,
      fee,
      B: this.B,
      cashBefore,
      cap,
      notional,
      capBinding: cap <= this.L * cashBefore + 1e-9,
      leg: leg.id,
    });
    this.say(
      t,
      'fill',
      `Leg ${leg.id}: ${leg.dir > 0 ? 'buy' : 'sell'} ${Q.toFixed(5)} at $${p.toFixed(0)} (notional $${notional.toFixed(2)}, fee $${fee.toFixed(3)}).`,
    );
  }

  close(t: number, p: number, why: string) {
    const { d, Q, P0, leg } = this.pos!;
    const gross = d * Q * (p - P0);
    const fee = this.f * Q * p;
    this.B += gross - fee;
    this.fees += fee;
    this.fills.push({
      t,
      side: d > 0 ? 'sell' : 'buy',
      action: 'close',
      Q,
      p,
      fee,
      B: this.B,
      why,
      gross,
      leg: leg.id,
    });
    this.say(
      t,
      'fill',
      `Leg ${leg.id} closed (${labelReasonLocal(why)}): ${d > 0 ? 'sell' : 'buy'} ${Q.toFixed(5)} at $${p.toFixed(0)}, gross ${gross >= 0 ? '+' : ''}$${gross.toFixed(2)}, fee $${fee.toFixed(3)}. Cash $${this.B.toFixed(2)}.`,
    );
    this.pos = null;
  }

  end(t: number, reason: EndReason) {
    this.ended = true;
    this.endReason = reason;
    this.endT = t;
    this.status = reason === 'liquidated' ? 'LIQUIDATED' : 'CLOSED';
    this.say(t, 'end', `Plan ended: ${labelReasonLocal(reason)}.`);
  }

  afterScheduledClose(t: number, idx: number) {
    const c = this.cfg;
    if (c.tpTarget > 0 && this.B >= this.M + c.tpTarget - 1e-9) {
      this.end(t, 'target_reached');
      return;
    }
    if (c.lossLimit > 0 && this.B <= this.M - c.lossLimit + 1e-9) {
      this.end(t, 'loss_limit');
      return;
    }
    const next = this.ev.slice(idx).find((e) => e.type === 'open');
    if (next) {
      this.status = 'FLAT_WAITING';
      if (next.t - t > 1e-6)
        this.say(t, 'state', `Flat and waiting; next entry scheduled at ${fmtT(next.t)}.`);
    } else if (this.live && t < this.H - 1e-6) {
      this.status = 'FLAT_WAITING';
      this.say(
        t,
        'state',
        'Flat with nothing queued. Redraw the future to trade again, or leave it flat until the horizon ends.',
      );
    } else this.end(t, 'time_exit');
  }

  stepTo(tTarget: number) {
    const N = this.N;
    const dt = this.dt;
    const cfg = this.cfg;
    while (this.step < N && this.step * dt < tTarget - 1e-9) {
      this.step++;
      const t = this.step * dt;
      const p = this.priceAt(t);
      if (this.pendingEntry && !this.pos && !this.ended) {
        const { leg } = this.pendingEntry;
        if (this.armed(leg, p)) {
          const u = (leg.p0 - this.pPrev) / (p - this.pPrev || 1e-9);
          const tf = u >= 0 && u <= 1 ? lerp(this.tPrev, t, u) : t;
          this.open(tf, leg.p0, leg);
          this.pendingEntry = null;
        }
      }
      if (this.pos && !this.ended) {
        const th = thresholds(this.pos, this.B, cfg);
        const d = this.pos.d;
        const pPrev = this.pPrev;
        const cands: { u: number; price: number; kind: EndReason }[] = [];
        const cross = (level: number | null, favorable: boolean) => {
          if (level == null) return null;
          const above = d > 0 ? favorable : !favorable;
          const from = above ? pPrev >= level : pPrev <= level;
          const to = above ? p >= level : p <= level;
          if (from) return { u: 0, price: p };
          if (to) return { u: (level - pPrev) / (p - pPrev), price: level };
          return null;
        };
        const cS = cross(th.stop, false);
        const cL = cross(th.liq, false);
        const cT = cross(th.tp, true);
        if (cL) cands.push({ ...cL, kind: 'liquidated' });
        if (cS) cands.push({ ...cS, kind: 'stopped' });
        if (cT) cands.push({ ...cT, kind: 'target_reached' });
        if (cands.length) {
          cands.sort((a, b) => a.u - b.u || (a.kind === 'liquidated' ? -1 : 1));
          const h = cands[0];
          const tH = lerp(this.tPrev, t, h.u);
          this.close(tH, h.price, h.kind);
          this.end(tH, h.kind);
        }
      }
      while (!this.ended && this.evIdx < this.ev.length && this.ev[this.evIdx].t <= t + 1e-9) {
        const e = this.ev[this.evIdx++];
        const pe = this.priceAt(e.t);
        if (e.type === 'funding') {
          if (this.pos) {
            const pay = this.pos.d * this.pos.Q * pe * cfg.fundingRateHr;
            this.B -= pay;
            this.funding += pay;
            this.say(
              e.t,
              'funding',
              `Funding settlement: ${pay >= 0 ? 'paid' : 'received'} $${Math.abs(pay).toFixed(4)}.`,
            );
          } else this.say(e.t, 'funding', 'Funding settlement while flat: nothing paid.');
        } else if (e.type === 'close') {
          if (!this.pos && this.pendingEntry && this.pendingEntry.leg === e.leg) {
            this.pendingEntry = null;
            this.say(
              e.t,
              'warn',
              `Leg ${e.leg!.id} entry expired unfilled: price never ${this.rule === 'limit' ? 'came back to' : 'broke through'} $${e.leg!.p0.toFixed(0)}. Leg skipped.`,
            );
            this.afterScheduledClose(e.t, this.evIdx);
            continue;
          }
          if (!this.pos) continue;
          if (this.inOutage(e.t)) {
            this.pendingClose = { t: this.outage![1], idx: this.evIdx };
            this.say(
              e.t,
              'warn',
              `Scheduled close missed (service outage). It will run late at ${fmtT(this.outage![1])}. Venue stop stays active.`,
            );
          } else {
            const nextOpenNow =
              this.ev[this.evIdx] &&
              this.ev[this.evIdx].type === 'open' &&
              Math.abs(this.ev[this.evIdx].t - e.t) < 1e-6;
            this.close(e.t, pe, e.forced ? 'redraw' : nextOpenNow ? 'reversal' : 'scheduled');
            this.afterScheduledClose(e.t, this.evIdx);
          }
        } else if (e.type === 'open') {
          if (this.pos) continue;
          if (this.inOutage(e.t)) {
            this.say(
              e.t,
              'warn',
              `Leg ${e.leg!.id} entry skipped: service outage. A missed entry does not catch up.`,
            );
            const later = this.ev.slice(this.evIdx).some((x) => x.type === 'open');
            if (!later && !this.live) this.end(e.t, 'time_exit');
            continue;
          }
          if (
            this.rule === 'scheduled' ||
            e.atMarket ||
            (e.leg!.t0 === 0 && this.anchored && e.leg!.id === 1)
          )
            this.open(e.t, pe, e.leg!);
          else if (this.armed(e.leg!, pe)) {
            this.say(
              e.t,
              'state',
              `Leg ${e.leg!.id}: the drawn ${this.rule === 'limit' ? 'limit' : 'breakout'} level $${e.leg!.p0.toFixed(0)} is already ${this.rule === 'limit' ? 'at or better than the market' : 'behind the market, so a stop there would trigger at once'}; filled at market $${pe.toFixed(0)}.`,
            );
            this.open(e.t, pe, e.leg!);
          } else {
            this.pendingEntry = { leg: e.leg! };
            this.status = 'ENTRY_PENDING';
            this.say(
              e.t,
              'state',
              `Leg ${e.leg!.id} armed: ${e.leg!.dir > 0 ? 'buy' : 'sell'} ${this.rule === 'limit' ? 'limit' : 'stop'} at $${e.leg!.p0.toFixed(0)}, expires ${fmtT(e.leg!.t1)} if untouched.`,
            );
          }
        }
      }
      if (this.pendingClose && this.pos && !this.ended && t >= this.pendingClose.t - 1e-9) {
        const pc = this.pendingClose;
        this.pendingClose = null;
        this.close(pc.t, this.priceAt(pc.t), 'late');
        this.afterScheduledClose(pc.t, pc.idx);
      }
      const eq = this.pos ? this.B + this.pos.d * this.pos.Q * (p - this.pos.P0) : this.B;
      const lev = this.pos && eq > 0 ? (this.pos.Q * p) / eq : 0;
      this.minEq = Math.min(this.minEq, eq);
      this.maxLev = Math.max(this.maxLev, lev);
      this.series.push({
        t,
        p,
        B: this.B,
        eq,
        lev,
        ink: clamp(eq / this.M, 0, 1),
        status: this.status,
        pos: this.pos
          ? {
              d: this.pos.d,
              Q: this.pos.Q,
              P0: this.pos.P0,
              th: thresholds(this.pos, this.B, cfg),
              leg: this.pos.leg.id,
            }
          : null,
      });
      this.tPrev = t;
      this.pPrev = p;
    }
    if (this.step >= N) {
      if (this.pos && !this.ended) {
        this.close(this.H, this.priceAt(this.H), 'scheduled');
        this.end(this.H, 'time_exit');
      }
      if (!this.ended) this.end(this.H, 'time_exit');
    }
    return this;
  }

  /** What is queued: unprocessed events, marked locked (inside the lock window) or editable. */
  queue(lockSec: number): QueueItem[] {
    const L = this.tNow + lockSec;
    return this.ev
      .slice(this.evIdx)
      .filter((e) => e.type !== 'funding')
      .map((e) => ({
        t: e.t,
        type: e.type as 'open' | 'close',
        leg: e.leg!,
        locked: e.t < L - 1e-9,
        forced: !!e.forced,
      }));
  }

  /**
   * Replace everything scheduled at or after the lock boundary with the new plan; the
   * position at the boundary decides what has to change.
   */
  replan(
    newPlan: { legs: Leg[]; anchored: boolean },
    lockSec: number,
    drawingEnd: number | null,
    commit?: boolean,
  ) {
    if (this.ended) return { changed: false, reason: 'ended' as const };
    if (commit) this.commits = (this.commits || 0) + 1;
    const now = this.tNow;
    const Lb = Math.min(this.H, now + lockSec);
    const endOf = (leg: Leg) =>
      drawingEnd == null ? leg.t1 : Math.min(leg.t1, Math.max(Lb, drawingEnd));
    // Position direction the queued (locked) events will leave us with at the boundary.
    let dirAtL = this.pos ? this.pos.d : 0;
    let legAtLold: Leg | null = this.pos ? this.pos.leg : null;
    const kept: SimEvent[] = [];
    const pending = this.ev.slice(this.evIdx);
    for (const e of pending) {
      if (e.type === 'funding' || e.t < Lb - 1e-9) {
        kept.push(e);
        if (e.type === 'close') {
          dirAtL = 0;
          legAtLold = null;
        }
        if (e.type === 'open') {
          dirAtL = e.leg!.dir;
          legAtLold = e.leg!;
        }
      }
    }
    if (this.pendingEntry) {
      this.say(
        now,
        'state',
        `Resting entry for leg ${this.pendingEntry.leg.id} cancelled by the redraw.`,
      );
      this.pendingEntry = null;
      if (this.status === 'ENTRY_PENDING') this.status = 'FLAT_WAITING';
    }
    const newLegs = newPlan.legs;
    let legAtL = newLegs.find((l) => l.t0 <= Lb + 1e-9 && l.t1 > Lb + 1e-9) || null;
    const added: SimEvent[] = [];
    // The drawing stops at or before the boundary: flat from here.
    if (legAtL && endOf(legAtL) <= Lb + 1e-9) legAtL = null;
    const wantDir = legAtL ? legAtL.dir : 0;
    const summary: string[] = [];
    if (dirAtL !== 0 && wantDir !== dirAtL) {
      added.push({
        t: Lb,
        type: 'close',
        leg: legAtLold || (this.pos ? this.pos.leg : undefined),
        forced: true,
      });
      summary.push(`close the ${dirAtL > 0 ? 'long' : 'short'} at ${fmtT(Lb)}`);
    }
    if (legAtL && wantDir !== dirAtL) {
      added.push({ t: Lb, type: 'open', leg: legAtL, atMarket: true });
      added.push({ t: endOf(legAtL), type: 'close', leg: legAtL });
      summary.push(
        `open ${legAtL.dir > 0 ? 'long' : 'short'} at ${fmtT(Lb)} until ${fmtT(endOf(legAtL))}`,
      );
    } else if (legAtL && wantDir === dirAtL) {
      added.push({ t: endOf(legAtL), type: 'close', leg: legAtL });
      if (this.pos && legAtLold === this.pos.leg) this.pos.leg = legAtL;
      summary.push(`keep the ${wantDir > 0 ? 'long' : 'short'} until ${fmtT(endOf(legAtL))}`);
    }
    for (const l of newLegs)
      if (l.t0 >= Lb - 1e-9 && endOf(l) > l.t0 + 1e-9) {
        added.push({ t: l.t0, type: 'open', leg: l });
        added.push({ t: endOf(l), type: 'close', leg: l });
      }
    const laterCount = newLegs.filter((l) => l.t0 >= Lb - 1e-9 && endOf(l) > l.t0 + 1e-9).length;
    if (laterCount) summary.push(`${laterCount} later leg${laterCount === 1 ? '' : 's'} queued`);
    if (!legAtL && dirAtL === 0 && !laterCount) summary.push('flat from the boundary on');
    this.ev = this.ev.slice(0, this.evIdx).concat(kept, added);
    this.sortEv(this.evIdx);
    this.legs = newLegs.slice();
    this.replans.push({
      t: now,
      lockSec,
      legs: newLegs.map((l) => ({ ...l })),
      anchored: newPlan.anchored,
      drawingEnd,
    });
    if (this.status === 'FLAT_WAITING' || this.status === 'AUTHORIZED') {
      const next = this.ev.slice(this.evIdx).find((e) => e.type === 'open');
      this.status = next ? 'FLAT_WAITING' : this.status;
    }
    const text = `Redrawn at ${fmtT(now)}; from ${fmtT(Lb)}: ${summary.join(', ') || 'no change'}.`;
    const last = this.log[this.log.length - 1];
    if (last && last.kind === 'replan' && Math.abs(last.t - now) < 1e-6) last.text = text;
    else this.say(now, 'replan', text);
    return { changed: true, text };
  }

  /**
   * Settings changed while running: risk and interpretation apply at once, margin is a
   * transfer, the market and time base stay as they were.
   */
  applyConfig(c: TraceConfig) {
    const o = this.cfg;
    const notes: string[] = [];
    const now = this.tNow;
    if (c.margin !== o.margin) {
      const d = c.margin - o.margin;
      this.B += d;
      this.M = c.margin;
      this.minEq = Math.min(this.minEq, this.B);
      notes.push(
        `margin ${d >= 0 ? 'added' : 'withdrawn'} $${Math.abs(d).toFixed(2)} as a transfer; the equity baseline is now $${c.margin}`,
      );
    }
    if (c.leverage !== o.leverage) {
      this.L = c.leverage;
      notes.push(`${c.leverage}× for legs opened from now`);
    }
    if (c.sizing !== o.sizing || c.riskPerLeg !== o.riskPerLeg || c.stopPct !== o.stopPct)
      notes.push(
        `sizing: ${c.sizing === 'risk' ? `risk $${c.riskPerLeg} at a ${c.stopPct}% stop` : 'fixed margin'} for new legs`,
      );
    if (c.feeRate !== o.feeRate) {
      this.f = c.feeRate;
      notes.push(`fee ${(c.feeRate * 100).toFixed(3)}% per side`);
    }
    if (c.entryRule !== o.entryRule) {
      this.rule = c.entryRule;
      notes.push(`entry rule ${c.entryRule}`);
    }
    if (c.tpTarget !== o.tpTarget)
      notes.push(c.tpTarget > 0 ? `take profit +$${c.tpTarget}` : 'take profit off');
    if (c.lossLimit !== o.lossLimit)
      notes.push(c.lossLimit > 0 ? `loss limit $${c.lossLimit}` : 'loss limit off');
    if (c.maintFrac !== o.maintFrac) notes.push(`maintenance ${(c.maintFrac * 100).toFixed(2)}%`);
    if (c.lockSec !== o.lockSec) notes.push(`lock window ${c.lockSec} s`);
    if (c.outageOn !== o.outageOn || c.outageFrom !== o.outageFrom || c.outageTo !== o.outageTo) {
      this.outage = c.outageOn ? [c.outageFrom * 60, c.outageTo * 60] : null;
      notes.push(
        c.outageOn ? `outage ${fmtT(c.outageFrom * 60)}–${fmtT(c.outageTo * 60)}` : 'outage off',
      );
    }
    if (
      c.fundingRateHr !== o.fundingRateHr ||
      c.nextFundingMin !== o.nextFundingMin ||
      c.fundingIntervalMin !== o.fundingIntervalMin
    ) {
      const keep = this.ev.slice(0, this.evIdx);
      const rest = this.ev.slice(this.evIdx).filter((e) => e.type !== 'funding');
      fundingTimes({ ...c, horizonSec: this.H })
        .filter((t) => t > now + 1e-9)
        .forEach((t) => rest.push({ t, type: 'funding' }));
      this.ev = keep.concat(rest);
      this.sortEv(this.evIdx);
      notes.push('funding schedule rebuilt');
    }
    this.cfg = {
      ...c,
      horizonSec: o.horizonSec,
      columns: o.columns,
      refPrice: o.refPrice,
      scenario: o.scenario,
      movePct: o.movePct,
      volPct: o.volPct,
      seed: o.seed,
    };
    if (notes.length) this.say(now, 'amend', `Settings changed live: ${notes.join('; ')}.`);
    return notes;
  }

  get net() {
    return this.B - this.M;
  }

  result(): RunResult {
    return {
      series: this.series,
      log: this.log,
      fills: this.fills,
      net: this.B - this.M,
      B: this.B,
      fees: this.fees,
      funding: this.funding,
      minEq: this.minEq,
      maxLev: this.maxLev,
      endReason: this.endReason,
      endT: this.endT == null ? this.H : this.endT,
      N: this.N,
      replans: this.replans,
      commits: this.commits || 0,
    };
  }
}

// Local copy so the class does not depend on the display-layer formatter module shape.
function labelReasonLocal(r: string) {
  return (
    (
      {
        target_reached: 'take profit reached',
        stopped: 'stop hit at the loss limit',
        loss_limit: 'loss limit reached at a close',
        liquidated: 'liquidated',
        time_exit: 'time exit',
        reversal: 'reversal',
        scheduled: 'scheduled close',
        late: 'late close after outage',
        redraw: 'closed by redraw',
        no_legs: 'no executable legs',
      } as Record<string, string>
    )[r] || r
  );
}

/** One-shot simulation; a list of recorded replans is replayed at the same times. */
export function simulate(
  plan: Plan,
  cfg: TraceConfig,
  priceAt: (t: number) => number,
  replans?: Replan[],
): RunResult {
  const s = new LiveSim(plan, cfg, priceAt, !!(replans && replans.length));
  for (const r of replans || []) {
    s.stepTo(r.t);
    s.replan({ legs: r.legs, anchored: r.anchored }, r.lockSec, r.drawingEnd);
  }
  s.stepTo(cfg.horizonSec);
  return s.result();
}

export function forecastError(plan: Plan, market: Market) {
  const cols = plan.cols.filter((c) => !c.gap && !c.bridged);
  if (!cols.length) return null;
  return (
    (10000 / cols.length) *
    cols.reduce((s, c) => s + Math.abs(Math.log(market.at(c.t) / c.p!)), 0)
  );
}
