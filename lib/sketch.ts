import { clamp, lerp } from './format';
import type { Leg, Plan, Point, Stroke } from './types';

/** Latest time any stroke reaches, i.e. where the plan stops. */
export function drawingEnd(strokes: Stroke[]) {
  return strokes.reduce((m, st) => st.reduce((mm, q) => Math.max(mm, q.t), m), 0);
}

/** Remove every point inside [ta, tb], splitting strokes that straddle the range. */
export function cutRange(strokes: Stroke[], ta: number, tb: number): Stroke[] {
  const out: Stroke[] = [];
  for (const st of strokes) {
    let run: Point[] = [];
    for (const q of st) {
      if (q.t >= ta - 1e-9 && q.t <= tb + 1e-9) {
        if (run.length) {
          out.push(run);
          run = [];
        }
      } else run.push(q);
    }
    if (run.length) out.push(run);
  }
  return out;
}

export interface PenOpts {
  /** Smoothing 0..1: how much of each new point is filtered out. */
  smooth: number;
  /** Time never runs backwards while the pen is down. */
  forwardOnly: boolean;
  /** Pixels per second, used to ignore sub-pixel motion. */
  pxOfT: (t: number) => number;
}

export type PenResult = Point | { update: true; p: number } | null;

/**
 * One place for pen input: smooth the price, keep time moving forward, ignore jitter.
 * `minT` is the lock boundary — the tip cannot be placed in the frozen past.
 */
export function penPoint(
  raw: Point,
  last: Point | undefined,
  minT: number | null,
  o: PenOpts,
): PenResult {
  let t = raw.t;
  const p = raw.p;
  if (minT != null && t < minT) t = minT;
  if (!last) return { t, p };
  const a = 1 - o.smooth;
  const ps = last.p + a * (p - last.p);
  // Vertical or backward motion moves the tip, never time.
  if (o.forwardOnly && t <= last.t + 1e-9) return { update: true, p: ps };
  // Sub-pixel forward motion: glide the tip instead of adding a point.
  if (Math.abs(o.pxOfT(t) - o.pxOfT(last.t)) < 2) return { update: true, p: ps };
  return { t, p: ps };
}

export function applyPen(pts: Point[], r: PenResult): boolean {
  if (!r) return false;
  if ('update' in r) {
    if (!pts.length) return false;
    pts[pts.length - 1].p = r.p;
    return true;
  }
  pts.push(r);
  return true;
}

/**
 * The turning points of the interpreted plan at or after the boundary, grouped by
 * contiguous segment. These are what the Adjust tool exposes as draggable handles.
 */
export function futureVertices(plan: Plan, Lb: number): Point[][] {
  const items: Leg[] = [...plan.legs, ...plan.flats].sort((a, b) => a.t0 - b.t0);
  const groups: Point[][] = [];
  let cur: Point[] | null = null;
  let seg = -1;
  for (const it of items) {
    if (it.t1 <= Lb + 1e-9) continue;
    if (it.seg !== seg) {
      cur = null;
      seg = it.seg;
    }
    if (!cur) {
      const t0 = Math.max(it.t0, Lb);
      const p0 =
        it.t0 < Lb ? lerp(it.p0, it.p1, (Lb - it.t0) / (it.t1 - it.t0 || 1e-9)) : it.p0;
      cur = [{ t: t0, p: p0 }];
      groups.push(cur);
    }
    cur.push({ t: it.t1, p: it.p1 });
  }
  return groups;
}

/** Flatten grouped vertices into the handle list, skipping the point pinned to the boundary. */
export function handlesOf(polys: Point[][], Lb: number) {
  const out: { gi: number; vi: number; t: number; p: number }[] = [];
  polys.forEach((poly, gi) =>
    poly.forEach((v, vi) => {
      if (v.t > Lb + 1e-6) out.push({ gi, vi, t: v.t, p: v.p });
    }),
  );
  return out;
}

/** Keep a dragged vertex between its neighbours so the plan stays single-valued in time. */
export function constrainVertexTime(
  poly: Point[],
  vi: number,
  t: number,
  Lb: number,
  horizonSec: number,
  minGap: number,
) {
  const prev = poly[vi - 1];
  const next = poly[vi + 1];
  const lo = (prev ? prev.t : Lb) + minGap;
  const hi = next ? next.t - minGap : horizonSec;
  return clamp(t, lo, Math.max(lo, hi));
}
