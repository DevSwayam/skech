/**
 * The prototype's UI controller, ported to TypeScript with one substitution: the
 * synthetic market is replaced by the live BTC feed. Everything else — the three-column
 * layout, the configurator, the review/results/ledger panels, the canvas, the live
 * redraw tools, the exports — behaves as it did in the single-file original.
 *
 * Two consequences of a real feed, and they are the only behavioural departures:
 *   - Time is the wall clock at 1×. There is no playback speed and no seeking forward;
 *     the scrubber reviews what has already happened and "Live" returns to now.
 *   - A run cannot be replayed against the same prices, because there is no generator.
 *     Leverage comparison and exports replay against the *recorded* tape instead.
 */
import { CANDLE_MS, VENUES } from './feed';
import { FEED_LABEL, LiveFeed, type FeedState } from './live-feed';
import { clamp, fmtPrice, fmtT, fmtTSigned, fmtUSD, fmtUSD0, labelReason, lerp } from './format';
import { PATTERNS, PATTERN_SCALE } from './patterns';
import { guideHtml, mountCoachMarks } from './trace-guide';
import { GLOSS, mountPopovers } from './trace-info';
import {
  LiveSim,
  compile,
  forecastError,
  fundingTimes,
  simulate,
  sizing as sizingOf,
  TURN_WORDS,
} from './trace-core';
import type {
  Leg,
  Overrides,
  Plan,
  Point,
  RunResult,
  SeriesPoint,
  Stroke,
  Thresholds,
  TraceConfig,
} from './types';

type Phase = 'DRAFT' | 'REVIEWED' | 'RUN' | 'DONE';
type Tool = 'adjust' | 'draw' | 'erase' | 'pan';
type LiveEdit =
  | { mode: 'draw'; pts: Point[]; Lb: number | null }
  | { mode: 'erase'; tA: number; tB: number; Lb: number | null };
interface AdjustState {
  kind: 'vertex' | 'tp' | 'stop';
  polys?: Point[][];
  gi?: number;
  vi?: number;
  Lb?: number;
}

const NO_OVERRIDES = (): Overrides => ({ gaps: {}, flats: {} });

export function mountTrace(root: HTMLElement) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    root.ownerDocument.getElementById(id) as T;
  const esc = (s: unknown) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  const C = $<HTMLCanvasElement>('chart');
  let ctx = C.getContext('2d')!;
  const FONT = getComputedStyle(root).fontFamily || '"IBM Plex Sans", system-ui, sans-serif';
  const font = (spec: string) => `${spec} ${FONT}`;

  // ---------- state ----------
  const S = {
    cfg: null as unknown as TraceConfig,
    strokes: [] as Stroke[],
    overrides: NO_OVERRIDES(),
    phase: 'DRAFT' as Phase,
    plan: null as Plan | null,
    proj: null as RunResult | null,
    plan0: null as Plan | null,
    sim: null as LiveSim | null,
    res: null as RunResult | null,
    cmp: null as { L: number; r: RunResult }[] | null,
    /** Wall-clock seconds since the session started, clamped to the horizon. */
    nowT: 0,
    /** The moment being displayed. Equals nowT unless the scrubber is in the past. */
    playT: 0,
    reviewing: false,
    closeHot: false,
    running: false,
    drawing: null as Point[] | null,
    drag: null as 'tp' | 'stop' | null,
    dirty: false,
    resultsShown: false,
    yRange: 0.4,
    /** Price axis follows the data until you touch a price control. */
    yAuto: true,
    view: { t0: 0, t1: 900, pc: 0 },
    pan: null as { x: number; y: number; t0: number; t1: number; pc: number } | null,
    live: null as LiveEdit | null,
    adjust: null as AdjustState | null,
    tool: 'draw' as Tool,
    mode: 'live' as 'live' | 'plan',
    follow: true,
    refPrice: 0,
    pendingRestart: false,
    resumeAfterDraw: false,
  };

  // React invokes effects twice in development. Without a single signal covering every
  // listener, the torn-down instance keeps handling pointer events and writing panels.
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  /**
   * While the pointer is down the view is frozen. If the price axis kept re-fitting it
   * would chase the stroke being drawn and the price under the cursor would run away;
   * if the time window kept scrolling, the canvas would slide out from under the pen.
   */
  const dragging = () => !!(S.live || S.drawing || S.adjust || S.drag || S.pan);

  /** The traded asset, e.g. ZEC. Every label used to be hardcoded to BTC. */
  const base = () => feed.symbol.replace(/USDT$/, '');

  let feed = new LiveFeed(Date.now(), 'BTCUSDT');
  let unsubFeed = () => {};
  const priceAt = (t: number) => feed.tape.at(t);

  // ---------- config ----------
  function readCfg() {
    const n = (id: string) => parseFloat($<HTMLInputElement>(id).value);
    const ref = S.refPrice || feed.tape.last || 100_000;
    S.cfg = {
      horizonSec: clamp(Math.round(n('horizonN') * n('horizonU')), 10, 86400),
      columns: parseInt($<HTMLSelectElement>('columns').value, 10),
      entryRule: $<HTMLSelectElement>('entryRule').value as TraceConfig['entryRule'],
      fundingIntervalMin: Math.max(1, n('fundingInterval')),
      showSwings: $<HTMLInputElement>('showSwings').checked,
      gapMin: Math.max(1, Math.round(n('gapMin'))),
      tolPct: Math.max(0.001, n('tolPct')),
      legBudget: Math.round(n('legBudget')) > 0 ? Math.round(n('legBudget')) : Infinity,
      mode: $('modePath').getAttribute('aria-pressed') === 'true' ? 'path' : 'single',
      // Only a guard against dividing by zero. It used to floor at $1, which silently
      // broke every sub-dollar perp — and those are the liveliest ones, so the app
      // opened on one by default: the axis anchored at $1 while the market traded at
      // $0.13, and the view label read in the millions of percent.
      refPrice: Math.max(1e-9, ref),
      margin: Math.max(1, n('margin')),
      leverage: parseInt(
        root.querySelector<HTMLElement>('[data-lev][aria-pressed=true]')!.dataset.lev!,
        10,
      ),
      lossLimit: Math.max(0, n('lossLimit')),
      tpTarget: Math.max(0, n('tpTarget')),
      feeRate: Math.max(0, n('feeRate')) / 100,
      fundingRateHr: n('fundingRate') / 100,
      nextFundingMin: Math.max(0, n('nextFunding')),
      maintFrac: Math.max(0.0001, n('maintFrac')) / 100,
      minNotional: 10,
      // The market is real, so the generator's shape controls are gone; these stay only
      // because the engine's config type carries them.
      scenario: 'up',
      movePct: 0,
      volPct: 0,
      seed: 1,
      outageOn: $<HTMLInputElement>('outageOn').checked,
      outageFrom: Math.max(0, n('outageFrom')),
      outageTo: Math.max(0, n('outageTo')),
      lockSec: Math.max(0, n('lockSec')),
      penSmooth: n('penSmooth') / 100,
      forwardOnly: $<HTMLInputElement>('forwardOnly').checked,
      pauseWhileDrawing: $<HTMLInputElement>('pauseWhileDrawing').checked,
      sizing: $('sizeRisk').getAttribute('aria-pressed') === 'true' ? 'risk' : 'margin',
      riskPerLeg: Math.max(0.5, n('riskPerLeg')),
      stopPct: Math.max(0.1, n('stopPct')),
    };
    root.ownerDocument.body.classList.toggle('sizing-risk', S.cfg.sizing === 'risk');
    S.yRange = parseFloat($<HTMLInputElement>('yRange').value);
    $('yRangeVal').textContent = `±${S.yRange}%`;
    $('penSmoothVal').textContent = `${Math.round(S.cfg.penSmooth * 100)}%`;
    $('colWidthVal').textContent = `1 column = ${fmtDur(S.cfg.horizonSec / S.cfg.columns)}; gap_min = ${fmtDur((S.cfg.horizonSec / S.cfg.columns) * S.cfg.gapMin)}`;
    // The tolerance is the one setting that must be read in dollars to make sense here.
    $('tolVal').textContent = `±${fmtUSD((S.cfg.refPrice * S.cfg.tolPct) / 100)} of price`;
    $('refPriceVal').textContent = S.refPrice
      ? `${fmtPrice(S.refPrice)} at start`
      : feed.tape.last
        ? `${fmtPrice(feed.tape.last)} live`
        : 'waiting for the feed';
    if (S.view.t1 > S.cfg.horizonSec || S.view.t1 <= S.view.t0) resetView(false);
    const sz = sizingOf(S.cfg);
    $('notionalVal').textContent =
      sz.mode === 'risk'
        ? `${fmtUSD(sz.cap)}${sz.capped ? ' (capped)' : ''}`
        : fmtUSD0(sz.cap) + ` at ${S.cfg.leverage}×`;
    $('marginReqVal').textContent =
      sz.mode === 'risk' ? `${fmtUSD(sz.marginRequired)} of ${fmtUSD0(S.cfg.margin)}` : '—';
  }

  const fmtDur = (sec: number) =>
    sec < 60
      ? `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`
      : sec < 3600
        ? `${(sec / 60).toFixed(sec % 60 ? 1 : 0)} min`
        : `${(sec / 3600).toFixed(1)} h`;

  // ---------- view (zoom and pan are display only; orders never change) ----------
  function resetView(redraw = true) {
    S.view = { t0: 0, t1: S.cfg.horizonSec, pc: 0 };
    // Reset hands the price axis back to auto; it will refit to the data on the next frame.
    S.yAuto = true;
    setYRange(0.1);
    if (redraw) {
      updateViewLabel();
      draw();
    }
  }
  function setYRange(r: number) {
    const v = Math.round(clamp(r, 0.005, 30) * 1000) / 1000;
    if (Math.abs(v - S.yRange) < 1e-9) return;
    S.yRange = v;
    $<HTMLInputElement>('yRange').value = String(v);
    $('yRangeVal').textContent = `±${v}%`;
  }
  function zoomTime(factor: number, atT?: number) {
    const v = S.view;
    const H = S.cfg.horizonSec;
    const span = v.t1 - v.t0;
    const ns = clamp(span * factor, Math.max(10, H / 200), H - earliestT());
    const a = atT == null ? (v.t0 + v.t1) / 2 : atT;
    const frac = span > 0 ? (a - v.t0) / span : 0.5;
    let t0 = a - frac * ns;
    let t1 = t0 + ns;
    const floor = earliestT();
    if (t0 < floor) {
      t0 = floor;
      t1 = floor + ns;
    }
    if (t1 > H) {
      t1 = H;
      t0 = H - ns;
    }
    S.view.t0 = t0;
    S.view.t1 = t1;
    updateViewLabel();
    draw();
  }
  function panTime(dir: number) {
    const v = S.view;
    const H = S.cfg.horizonSec;
    const span = v.t1 - v.t0;
    S.view.t0 = clamp(v.t0 + span * 0.25 * dir, earliestT(), H - span);
    S.view.t1 = S.view.t0 + span;
    updateViewLabel();
    draw();
  }
  function zoomPrice(factor: number, atPct?: number) {
    S.yAuto = false;
    const old = S.yRange;
    setYRange(old * factor);
    if (atPct != null) S.view.pc = atPct - (atPct - S.view.pc) * (S.yRange / old);
    S.view.pc = clamp(S.view.pc, -95, 500);
    updateViewLabel();
    draw();
  }
  function panPrice(dir: number) {
    S.yAuto = false;
    S.view.pc = clamp(S.view.pc + dir * S.yRange * 0.25, -95, 500);
    updateViewLabel();
    draw();
  }
  function fitView() {
    S.yAuto = false;
    const pts = S.strokes.flat();
    if (!pts.length) {
      resetView();
      return;
    }
    let tmin = Infinity;
    let tmax = -Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of pts) {
      tmin = Math.min(tmin, q.t);
      tmax = Math.max(tmax, q.t);
      const pct = (q.p / S.cfg.refPrice - 1) * 100;
      lo = Math.min(lo, pct);
      hi = Math.max(hi, pct);
    }
    // Include the market that has printed so far, so Fit frames the whole picture.
    if (S.sim)
      for (const q of S.sim.series) {
        if (q.p <= 0 || q.t < tmin || q.t > tmax) continue;
        const pct = (q.p / S.cfg.refPrice - 1) * 100;
        lo = Math.min(lo, pct);
        hi = Math.max(hi, pct);
      }
    const padT = Math.max((tmax - tmin) * 0.08, S.cfg.horizonSec / 100);
    S.view.t0 = Math.max(0, tmin - padT);
    S.view.t1 = Math.min(S.cfg.horizonSec, tmax + padT);
    if (S.view.t1 - S.view.t0 < S.cfg.horizonSec / 200) {
      S.view.t0 = 0;
      S.view.t1 = S.cfg.horizonSec;
    }
    S.view.pc = (lo + hi) / 2;
    setYRange(Math.max(0.005, ((hi - lo) / 2) * 1.25));
    updateViewLabel();
    draw();
  }
  /**
   * Fit the price axis to what is actually on screen. BTC covers a few tenths of a
   * percent in half an hour and only a few dollars in the first seconds, so any fixed
   * range is either far too wide to read or too tight to hold the session. Easing
   * toward the target keeps a new tick from making the axis jump.
   */
  function autoFitPrice() {
    if (dragging()) return;
    const c = S.cfg;
    const { t0, t1 } = S.view;
    let lo = Infinity;
    let hi = -Infinity;
    const see = (v?: number | null) => {
      if (v == null || !Number.isFinite(v) || v <= 0) return;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    };
    if (S.sim) {
      const ser = S.sim.series;
      const n = clamp(
        Math.floor((S.playT / c.horizonSec) * S.sim.N),
        0,
        Math.max(0, ser.length - 1),
      );
      for (let i = 0; i <= n; i++) if (ser[i].t >= t0 && ser[i].t <= t1) see(ser[i].p);
    }
    for (const k of feed.tape.candles) {
      const t = (k.t + CANDLE_MS / 2 - feed.tape.t0Ms) / 1000;
      if (t < t0 || t > t1) continue;
      see(k.l);
      see(k.h);
    }
    for (const st of S.strokes) for (const q of st) if (q.t >= t0 && q.t <= t1) see(q.p);
    if (S.plan)
      for (const l of S.plan.legs)
        if (l.t1 >= t0 && l.t0 <= t1) {
          see(l.p0);
          see(l.p1);
        }
    see(feed.tape.last);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const mid = (lo + hi) / 2;
    // The floor is tied to the simplify tolerance, not to a fixed number of dollars.
    // Zooming tighter than the tolerance makes the chart unusable: a stroke spanning the
    // whole height would still be a smaller move than the threshold for counting as a
    // leg, so every drawing would read as flat and nothing could ever be traded.
    const tolUsd = (c.refPrice * c.tolPct) / 100;
    const half = Math.max(((hi - lo) / 2) * 1.35, tolUsd * 4, c.refPrice * 0.00005);
    S.view.pc = lerp(S.view.pc, (mid / c.refPrice - 1) * 100, 0.12);
    setYRange(lerp(S.yRange, (half / c.refPrice) * 100, 0.12));
    updateViewLabel();
  }

  function updateViewLabel() {
    const v = S.view;
    $('viewLabel').textContent = `View ${fmtTSigned(v.t0)}–${fmtTSigned(v.t1)} of ${fmtT(S.cfg.horizonSec)}, price ${v.pc >= 0 ? '+' : ''}${v.pc.toFixed(2)}% ± ${S.yRange}%. Zoom and pan change the view only; orders do not move.`;
  }

  // ---------- compile ----------
  function recompile() {
    readCfg();
    S.plan = compile(S.strokes, S.cfg, S.overrides);
    S.proj = simulate(S.plan, S.cfg, spineAt(S.plan));
    $('hint').style.display = S.strokes.length || S.sim ? 'none' : '';
    $('hint').textContent = !feed.tape.count
      ? `Loading the live ${base()} price…`
      : S.mode === 'live'
        ? 'Live chart. Draw ahead of the lock boundary to place an order: rising means long, falling means short, lifting the pen means flat.'
        : 'Draw your plan on a still chart. Rising means long, falling means short, lifting the pen means flat. When it looks right, tick the box at the bottom of Review and press Authorize and run.';
    $('modeHint').textContent =
      S.cfg.mode === 'path'
        ? 'Every turn becomes a scheduled leg; a lifted pen means flat.'
        : 'Only the start and end point trade; turns are a forecast.';
    $<HTMLInputElement>('scrub').max = String(S.cfg.horizonSec);
    if (!S.sim) $('scrubT').textContent = `0:00 / ${fmtT(S.cfg.horizonSec)}`;
    renderReview();
    updateLive();
    draw();
    setBadge();
    updateViewLabel();
  }

  /** The drawn spine as a price function, for the "if your path happens" projection. */
  function spineAt(plan: Plan) {
    const pts = plan.cols.filter((c) => !c.gap).map((c) => ({ t: c.t, p: c.p! }));
    if (!pts.length) return () => S.cfg.refPrice;
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

  function setPhase(p: Phase) {
    S.phase = p;
    $('stepDraw').className = p === 'DRAFT' ? 'on' : 'done';
    $('stepReview').className = p === 'REVIEWED' ? 'on' : p === 'RUN' || p === 'DONE' ? 'done' : '';
    $('stepRun').className = p === 'RUN' || p === 'DONE' ? 'on' : '';
    const locked = p === 'RUN' || p === 'DONE';
    root.ownerDocument.body.classList.toggle('locked', locked);
    C.classList.toggle('locked', locked);
    C.style.cursor = locked ? 'grab' : 'crosshair';
    $<HTMLButtonElement>('undo').disabled = p === 'DONE';
    $<HTMLButtonElement>('clear').disabled = p === 'DONE';
    $<HTMLSelectElement>('examples').disabled = p === 'DONE';
    $('restartNote').hidden = !(locked && S.pendingRestart);
    $('liveCfgNote').hidden = p !== 'RUN';
    $<HTMLButtonElement>('play').disabled = !locked;
    $<HTMLInputElement>('scrub').disabled = !locked;
    setBadge();
  }

  function setBadge() {
    const b = $('stateBadge');
    let text: string = S.phase;
    let cls = 'badge';
    if (S.phase === 'RUN' || S.phase === 'DONE') {
      const s = cur();
      let status = s.status;
      text = status;
      if (S.sim && S.sim.ended && S.playT >= (S.sim.endT ?? 0) - 1e-6) {
        status = S.sim.status;
        text = status;
      }
      if (status === 'OPEN' && s.pos) {
        text = s.pos.d > 0 ? 'OPEN long' : 'OPEN short';
        cls += s.pos.d > 0 ? ' open' : ' short';
      } else if (status === 'FLAT_WAITING' || status === 'ENTRY_PENDING') cls += ' wait';
      else if (status === 'CLOSED' || status === 'LIQUIDATED') cls += ' end';
      if (S.mode === 'live' && S.phase === 'RUN' && S.sim && !S.sim.ended) {
        text =
          status === 'OPEN' && s.pos
            ? `LIVE, ${s.pos.d > 0 ? 'long' : 'short'}`
            : `LIVE, ${status === 'FLAT_WAITING' || status === 'AUTHORIZED' ? 'flat' : status.toLowerCase().replace('_', ' ')}`;
        cls = 'badge is-live' + (status === 'OPEN' && s.pos && s.pos.d < 0 ? ' short' : '');
      }
    }
    b.textContent = text;
    b.className = cls;
    if (!$('fsHud').hidden) {
      $('fsBadge').textContent = text;
      $('fsBadge').className = cls;
    }
  }

  // ---------- review panel ----------
  function summary() {
    const c = S.cfg;
    const p = S.plan!;
    const out: string[] = [];
    if (!p.legs.length)
      return '<p>No executable leg yet. Draw a rising line for a long or a falling line for a short. Lift the pen where you want no position.</p>';
    const sz = p.sizing;
    out.push(
      `<p><b>${c.mode === 'path' ? 'Follow my path' : 'Single trade'}</b> on ${base()} perp over ${fmtT(c.horizonSec)}, ${fmtUSD0(c.margin)} isolated margin at ${c.leverage}× opening leverage. ${
        sz.mode === 'risk'
          ? `Sized by risk: up to ${fmtUSD(sz.cap)} of exposure per leg so that a ${c.stopPct}% adverse move loses about ${fmtUSD(sz.plannedLoss!)}, using ${fmtUSD(sz.marginRequired)} of margin`
          : `Sized by margin: up to ${fmtUSD0(sz.cap)} of exposure per leg (${c.leverage} × ${fmtUSD0(c.margin)})`
      }; quantity is set from a fresh quote at each entry. The drawing never sets the size.</p>`,
    );
    const legs = p.legs.map((l) => {
      const entry =
        l.t0 === 0 && p.anchored
          ? 'enter now at the live quote'
          : `scheduled entry at ${fmtT(l.t0)}, at market`;
      const how = l.reversal ? 'reverse: close the prior leg, confirm flat, then open' : entry;
      return `Leg ${l.id}: <b class="${l.dir > 0 ? 'long' : 'short'}">${l.dir > 0 ? 'long' : 'short'}</b> from ${fmtT(l.t0)} to ${fmtT(l.t1)} (${how}), drawn ${fmtPrice(l.p0)} to ${fmtPrice(l.p1)}.`;
    });
    out.push('<p>' + legs.join('<br>') + '</p>');
    const flats = p.flatIntervals
      .filter((f) => f.kind !== 'bridged')
      .map((f) => {
        if (f.kind === 'start') return `No position until the first entry at ${fmtT(f.t1)}.`;
        if (f.kind === 'end') return `Time exit at ${fmtT(f.t0)}; flat until the horizon ends.`;
        if (f.kind === 'gap')
          return `Flat from ${fmtT(f.t0)} to ${fmtT(f.t1)}: the drawing has a gap, so the position is closed, the plan waits, and the next stroke opens a new leg.`;
        return `Flat from ${fmtT(f.t0)} to ${fmtT(f.t1)}: the net move (${f.movePct! >= 0 ? '+' : ''}${f.movePct!.toFixed(3)}%) is inside the ${c.tolPct}% tolerance, so no direction.`;
      });
    if (flats.length) out.push('<p>' + flats.join('<br>') + '</p>');
    if (p.shapes?.length)
      out.push('<p><b>How a trader would read it:</b> ' + p.shapes.map(esc).join(' ') + '</p>');
    if (c.entryRule !== 'scheduled')
      out.push(
        `<p>Entry rule: each leg rests as a ${c.entryRule === 'limit' ? 'pullback limit at its drawn price and fills only if price comes back to it' : "breakout stop at its drawn price and fills only if price breaks through it in the leg's direction"}. An entry that is not touched before the leg's end time expires and the leg is skipped. Leg 1 starting at now still fills at market.</p>`,
      );
    const F = p.first!;
    const risk: string[] = [];
    if (F.stop)
      risk.push(
        `Plan loss limit ${fmtUSD0(c.lossLimit)}: leg 1 stop near ${fmtPrice(F.stop)} (${((F.stop / F.leg.p0 - 1) * 100).toFixed(2)}%).`,
      );
    if (F.tp)
      risk.push(
        `Take profit +${fmtUSD0(c.tpTarget)} (${((c.tpTarget / c.margin) * 100).toFixed(0)}% of margin): leg 1 trigger near ${fmtPrice(F.tp)} (${((F.tp / F.leg.p0 - 1) * 100).toFixed(2)}%). In path mode this is a whole-plan target, recalculated for each leg from carried cash.`,
      );
    if (F.liq)
      risk.push(
        `Liquidation estimate for leg 1 near ${fmtPrice(F.liq)} (${((F.liq / F.leg.p0 - 1) * 100).toFixed(1)}% move) at ${(c.maintFrac * 100).toFixed(2)}% maintenance. A teaching estimate, not a venue quote.`,
      );
    else
      risk.push('No positive liquidation price at this leverage in the frictionless model (1× long).');
    out.push('<p>' + risk.join('<br>') + '</p>');
    out.push(
      `<p>${p.roundTrips} round trip${p.roundTrips === 1 ? '' : 's'}, about ${fmtUSD(p.estFees)} in venue fees (${((p.estFees / c.margin) * 100).toFixed(2)}% of margin) at ${(c.feeRate * 100).toFixed(3)}% per side. ${p.fundingEvents} funding settlement${p.fundingEvents === 1 ? '' : 's'} fall inside open legs.</p>`,
    );
    return out.join('');
  }

  function sizingSection() {
    const c = S.cfg;
    const p = S.plan!;
    const sz = p.sizing;
    const L = c.leverage;
    const M = c.margin;
    const run = S.sim && (S.phase === 'RUN' || S.phase === 'DONE');
    const fills = (run ? S.sim!.result() : S.proj!).fills.filter((f) => f.action === 'open');
    let h = `<h3>How each leg is sized</h3><div class="summary">`;
    h += `<p>Size is a plan control, not something read from the stroke. Two numbers decide it, and the same rule applies to every leg.</p>`;
    if (sz.mode === 'margin') {
      h += `<p><b>Fixed margin.</b> You allocated ${fmtUSD0(M)} and chose ${L}×, so each leg may open up to <b>${fmtUSD0(sz.cap)}</b> of ${base()} (${L} × ${fmtUSD0(M)}). Quantity is fixed at entry from the live quote: at ${fmtPrice(c.refPrice)} that is ${(sz.cap / c.refPrice).toFixed(5)} ${base()}.</p>`;
      h += `<p>Raising leverage with the same margin buys more exposure and a larger gain or loss per percent of price move; it does not change the drawing or the stop. A 0.5% move on this leg — a move this market makes routinely — is worth about ${fmtUSD(sz.cap * 0.005)} either way.</p>`;
    } else {
      h += `<p><b>Risk at stop.</b> You said a leg may lose about ${fmtUSD(c.riskPerLeg)} if price moves ${c.stopPct}% against it. Exposure follows from that: ${fmtUSD(c.riskPerLeg)} ÷ ${c.stopPct}% = <b>${fmtUSD(sz.wanted!)}</b>${sz.capped ? `, more than ${L}× on ${fmtUSD0(M)} allows, so it is capped at <b>${fmtUSD(sz.cap)}</b> and the planned loss becomes ${fmtUSD(sz.plannedLoss!)}` : ''}. At ${L}× that ties up ${fmtUSD(sz.marginRequired)} of your ${fmtUSD0(M)}. Each leg also gets its own stop ${c.stopPct}% from its entry, in addition to the plan loss limit; whichever is nearer acts first.</p>`;
      h += `<p>In this mode leverage changes how much collateral the leg needs, not how much it can lose: the same ${fmtUSD(sz.cap)} of exposure needs ${fmtUSD(sz.cap)} at 1×, ${fmtUSD(sz.cap / 2)} at 2× and ${fmtUSD(sz.cap / 3)} at 3×.</p>`;
    }
    h += `<p>For every later leg the rule is <b>notional = min(cap, ${L} × cash)</b>. Profit never raises the cap; a loss shrinks what the next leg can afford. Fees are charged on each fill and reduce cash. The venue's minimum size and price precision round the quantity, and plans whose cash falls below the minimum notional skip the leg.</p>`;
    if (fills.length) {
      h += `<table class="sizing-table"><tr><th>Leg</th><th class="num">${run ? 'Entry fill' : 'Drawn entry'}</th><th class="num">Cash before</th><th class="num">Cap</th><th class="num">${L}× cash</th><th class="num">Notional</th><th class="num">Qty (${base()})</th></tr>`;
      for (const f of fills)
        h += `<tr><td>${f.leg}</td><td class="num">${fmtPrice(f.p)}</td><td class="num">${fmtUSD(f.cashBefore!)}</td><td class="num">${fmtUSD(f.cap!)}</td><td class="num">${fmtUSD(L * f.cashBefore!)}</td><td class="num"><b>${fmtUSD(f.notional!)}</b></td><td class="num">${f.Q.toFixed(5)}</td></tr>`;
      h += `</table><small>${run ? 'Actual fills from this run.' : 'Projected, assuming the market follows your drawing; real entries use the live quote.'} Notional is the smaller of the cap and ${L} × cash at that moment.</small>`;
    }
    return h + '</div>';
  }

  function renderReview() {
    const p = S.plan!;
    const c = S.cfg;
    const pr = S.proj!;
    let h = '';
    for (const w of p.warnings) {
      if (w.startsWith('SINGLE:'))
        h += `<div class="warn">${esc(w.slice(7))} <button class="btn small" data-switch="path">Follow my path instead</button></div>`;
      else
        h += `<div class="warn">${esc(w)}${p.simplified && w.startsWith('Your drawing has') ? ` <button class="btn small" data-raise="${p.legsAtBase}">Allow ${p.legsAtBase} legs</button>` : ''}</div>`;
    }
    // A drawing that has drifted behind the boundary produces legs that cannot be sent.
    // Without saying so, the app looks broken when it is refusing an impossible order.
    if (S.phase === 'RUN' && S.sim && !S.sim.ended && p.legs.length) {
      const Lb = boundary();
      const lastEnd = Math.max(...p.legs.map((l) => l.t1));
      if (lastEnd <= Lb + 1e-9)
        h += `<div class="warn">Your drawing is behind now. The last leg ends at ${fmtT(lastEnd)} but the lock boundary is already ${fmtT(Lb)}, so nothing could be queued — an order cannot be placed in the past. Draw to the right of the orange line. <button class="btn small" data-follow="1">Bring now into view</button></div>`;
    }
    // A tolerance that swallows the whole drawing is the one failure a live feed makes easy.
    if (S.strokes.length && !p.legs.length && p.flats.length)
      h += `<div class="warn">Every segment is inside the ${c.tolPct}% tolerance (±${fmtUSD((c.refPrice * c.tolPct) / 100)}), so the drawing has no direction. Lower the simplify tolerance, draw a steeper move, or pick a livelier market. <button class="btn small" data-tol="1">Halve the tolerance</button></div>`;
    h += `<h2>Plan summary</h2><div class="summary">${summary()}</div>`;
    if (p.legs.length) {
      h += `<h3>Interpreted legs</h3><table><tr><th>#</th><th>Side</th><th>From</th><th>To</th><th class="num">Move</th><th>Slope</th><th>Turn</th><th class="num">Notional</th></tr>`;
      for (const l of p.legs)
        h += `<tr><td>${l.id}</td><td class="${l.dir > 0 ? 'long' : 'short'}">${l.dir > 0 ? 'Long' : 'Short'}</td><td>${fmtT(l.t0)}</td><td>${fmtT(l.t1)}</td><td class="num">${l.movePct >= 0 ? '+' : ''}${l.movePct.toFixed(3)}%</td><td>${l.slope} <span class="swing">${l.rate >= 0 ? '+' : ''}${Math.abs(l.rate) >= 10 ? l.rate.toFixed(0) : l.rate.toFixed(3)}%/min</span></td><td>${l.turn ? `<span title="${TURN_WORDS[l.turn]}">${l.turn}</span>` : '<span class="swing">end</span>'}</td><td class="num">${fmtUSD0(p.sizing.cap)}</td></tr>`;
      h += `</table><small>Slope is percent per minute of the drawn leg. Turn names the swing at the leg's end: SH/SL first swing high/low, HH/HL higher high/low, LH/LL lower high/low.</small>`;
    }
    const fl = p.flatIntervals.filter((f) => f.kind !== 'start' && f.kind !== 'end');
    if (fl.length) {
      h += `<h3>Gaps and flat segments</h3><ul class="flat-list">`;
      for (const f of fl) {
        let label: string;
        let controls = '';
        if (f.kind === 'gap' || f.kind === 'bridged') {
          label = `${fmtT(f.t0)} to ${fmtT(f.t1)}, ${f.len} column${f.len === 1 ? '' : 's'}, ${f.default === 'bridge' ? 'a pen lift' : 'a gap'}`;
          if (c.mode === 'path')
            controls = `<span class="seg"><button data-gap="${f.key}" data-act="flat" aria-pressed="${f.kind === 'gap'}">Flat</button><button data-gap="${f.key}" data-act="bridge" aria-pressed="${f.kind === 'bridged'}">Bridge</button></span>`;
        } else {
          label = `${fmtT(f.t0)} to ${fmtT(f.t1)}, move ${f.movePct! >= 0 ? '+' : ''}${f.movePct!.toFixed(3)}% under tolerance`;
          controls = `<span class="seg"><button data-flat="${f.key}" data-act="flat" aria-pressed="${f.override !== 'hold'}">Flat</button><button data-flat="${f.key}" data-act="hold" aria-pressed="${f.override === 'hold'}" ${f.holdable ? '' : 'disabled title="No prior leg to hold"'}>Hold</button></span>`;
        }
        h += `<li><span>${label}</span>${controls}</li>`;
      }
      h += `</ul><small>Flat closes the position and reopens later (one extra round trip). Bridge or hold keeps the prior leg.</small>`;
    }
    if (p.legs.length) h += sizingSection();
    if (p.legs.length)
      h += `<div class="proj"><small>If the market follows your drawing exactly</small><b class="big" style="color:var(--${pr.net >= 0 ? 'long' : 'short'})">${fmtUSD(pr.net, true)}</b><small>net of ${fmtUSD(pr.fees)} fees and ${fmtUSD(pr.funding)} funding, ending by ${labelReason(pr.endReason)} at ${fmtT(pr.endT)}. A conditional scenario, not an expectation.</small></div>`;

    const locked = S.phase === 'RUN' || S.phase === 'DONE';
    if (S.mode === 'live')
      h += `<div class="authorize"><b>Live chart.</b> ${
        locked
          ? 'The market is moving. Anything drawn beyond the lock boundary is sent as an order' +
            (!$<HTMLInputElement>('armed').checked ? ' once you tick Armed' : '') +
            '; the past is frozen.'
          : `Press Start live chart. The clock runs from the first second against the real ${base()} feed, and a sketch made now becomes the opening proposal.`
      } <button id="toPlanFirst" class="btn small">Prefer to plan first?</button></div>`;
    else
      h += `<div class="authorize"><label class="check"><input id="ack" type="checkbox" ${S.phase === 'REVIEWED' || locked ? 'checked' : ''} ${locked ? 'disabled' : ''}> I have read the plan above</label>
      <div class="btns"><button id="authorize" class="btn primary" ${S.phase === 'REVIEWED' && p.legs.length && !locked ? '' : 'disabled'}>Authorize and run</button>${locked ? '<button id="backDraft" class="btn">Back to drawing</button>' : ''}</div>
      <small>Authorizing starts the clock against the live market from this moment on. The price is real, so the run cannot be repeated.</small></div>`;
    $('tab-review').innerHTML = h;

    const q = <T extends HTMLElement>(sel: string) => $('tab-review').querySelector<T>(sel);
    q<HTMLButtonElement>('#toPlanFirst')?.addEventListener('click', () => setMode('plan'));
    q<HTMLInputElement>('#ack')?.addEventListener('change', (e) => {
      setPhase((e.target as HTMLInputElement).checked ? 'REVIEWED' : 'DRAFT');
      renderReview();
    });
    q<HTMLButtonElement>('#authorize')?.addEventListener('click', authorize);
    q<HTMLButtonElement>('#backDraft')?.addEventListener('click', backToDraft);
    $('tab-review')
      .querySelectorAll<HTMLButtonElement>('[data-switch]')
      .forEach((b) => (b.onclick = () => $('modePath').click()));
    $('tab-review')
      .querySelectorAll<HTMLButtonElement>('[data-raise]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            $<HTMLInputElement>('legBudget').value = b.dataset.raise!;
            edited();
          }),
      );
    $('tab-review')
      .querySelectorAll<HTMLButtonElement>('[data-follow]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            if (!S.follow) $('vFollow').click();
            resetView();
          }),
      );
    $('tab-review')
      .querySelectorAll<HTMLButtonElement>('[data-tol]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const el = $<HTMLInputElement>('tolPct');
            el.value = String(Math.max(0.005, parseFloat(el.value) / 2));
            edited();
          }),
      );
    $('tab-review')
      .querySelectorAll<HTMLButtonElement>('[data-gap]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            S.overrides.gaps[b.dataset.gap!] = b.dataset.act as 'flat' | 'bridge';
            edited();
          }),
      );
    $('tab-review')
      .querySelectorAll<HTMLButtonElement>('[data-flat]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            S.overrides.flats[b.dataset.flat!] = b.dataset.act as 'flat' | 'hold';
            edited();
          }),
      );
  }

  function edited() {
    if (S.phase === 'REVIEWED') S.phase = 'DRAFT';
    setPhase('DRAFT');
    recompile();
  }

  // ---------- run ----------
  function beginRun() {
    // Starting before the first price would seed the simulator with at() === 0, which
    // bakes zeros into its series and draws the market as a spike off the bottom.
    if (!feed.tape.count) return;
    S.refPrice = feed.tape.last || S.refPrice;
    readCfg();
    S.plan = compile(S.strokes, S.cfg, S.overrides);
    S.plan0 = S.plan;
    S.sim = new LiveSim(S.plan, S.cfg, priceAt, true);
    S.res = null;
    S.cmp = null;
    S.live = null;
    S.adjust = null;
    S.reviewing = false;
    S.resultsShown = false;
    S.running = true;
    ledgerSig = '';
    S.sim.stepTo(S.nowT);
    $('runTools').hidden = false;
    $('flattenBtn').hidden = false;
    $('liveInfo').hidden = false;
    $('queue').hidden = false;
    $('armedWrap').hidden = false;
    setTool(S.plan.legs.length ? 'adjust' : 'draw');
    setPhase('RUN');
    renderReview();
    renderLedger();
    $('tab-results').innerHTML = '<p class="small">Running. Results appear when the plan ends.</p>';
    $('play').textContent = 'Live';
    showTab('review');
  }

  function authorize() {
    S.view = { t0: 0, t1: S.cfg.horizonSec, pc: 0 };
    unfollow();
    updateViewLabel();
    beginRun();
  }

  function startLive() {
    if (!feed.tape.count) return;
    S.pendingRestart = false;
    $('restartNote').hidden = true;
    S.follow = true;
    $('vFollow').setAttribute('aria-pressed', 'true');
    const span = Math.min(S.cfg?.horizonSec ?? 900, 180);
    S.view = { t0: 0, t1: span, pc: 0 };
    $('liveStart').hidden = true;
    $('liveStop').hidden = false;
    $('hint').style.display = 'none';
    beginRun();
    updateViewLabel();
  }

  function stopLive() {
    backToDraft();
    $('liveStart').hidden = S.mode !== 'live';
    $('liveStart').textContent = 'Start live chart';
    $('liveStop').hidden = true;
    $('armedWrap').hidden = true;
  }

  function setMode(m: 'live' | 'plan') {
    S.mode = m;
    $('modeLive').setAttribute('aria-pressed', String(m === 'live'));
    $('modePlanFirst').setAttribute('aria-pressed', String(m === 'plan'));
    $('planSteps').hidden = m === 'live';
    if (S.phase === 'RUN' || S.phase === 'DONE') backToDraft();
    S.view = { t0: 0, t1: S.cfg.horizonSec, pc: 0 };
    if (m === 'plan') unfollow();
    updateViewLabel();
    $('liveStart').hidden = m !== 'live';
    $('liveStart').textContent = 'Start live chart';
    $('liveStop').hidden = true;
    $('armedWrap').hidden = true;
    renderReview();
    draw();
  }

  function backToDraft() {
    S.running = false;
    S.sim = null;
    S.res = null;
    S.cmp = null;
    S.live = null;
    S.adjust = null;
    S.reviewing = false;
    S.playT = S.nowT;
    $('runTools').hidden = true;
    $('flattenBtn').hidden = true;
    $('liveInfo').hidden = true;
    $('queue').hidden = true;
    $('queue').innerHTML = '';
    setPhase('DRAFT');
    $('play').textContent = 'Live';
    $('scrubNote').textContent = '';
    recompile();
    $('tab-results').innerHTML = '<p class="small">Results appear after the run finishes.</p>';
    $('tab-ledger').innerHTML =
      '<p class="small">Fills and events appear here during the run.</p>';
    showTab('review');
  }

  /** Start a whole new session: a new recording of the live feed from t = 0. */
  function newSession(symbol?: string) {
    // A torn-down controller must never open a socket. React invokes effects twice in
    // development, so an async that was already in flight can land here after cleanup;
    // without this the orphan starts a feed nothing holds a reference to any more, and
    // it keeps writing the shared panels for the life of the page.
    if (ac.signal.aborted) return;
    const sym = symbol ?? feed.symbol;
    unsubFeed();
    feed.stop();
    feed = new LiveFeed(Date.now(), sym);
    unsubFeed = feed.onChange(onFeed);
    void feed.start();
    autoStarted = false;
    toleranceSet = false;
    showLiveliness();
    document.dispatchEvent(new CustomEvent('trace:symbol'));
    S.strokes = [];
    S.overrides = NO_OVERRIDES();
    S.refPrice = 0;
    S.nowT = 0;
    S.playT = 0;
    S.yAuto = true;
    $('patternNote').hidden = true;
    backToDraft();
  }

  function cur(): SeriesPoint {
    const fallback: SeriesPoint = {
      status: S.sim ? S.sim.status : 'AUTHORIZED',
      pos: null,
      eq: S.cfg.margin,
      B: S.cfg.margin,
      lev: 0,
      ink: 1,
      p: feed.tape.last || S.cfg.refPrice,
      t: 0,
    };
    if (!S.sim || !S.sim.series.length) return fallback;
    const i = clamp(
      Math.floor((S.playT / S.cfg.horizonSec) * S.sim.N),
      0,
      S.sim.series.length - 1,
    );
    return S.sim.series[i];
  }
  const simEndT = () => (S.sim && S.sim.ended ? (S.sim.endT ?? S.cfg.horizonSec) : S.cfg.horizonSec);

  // ---------- the clock ----------
  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!S.cfg) return;
    const H = S.cfg.horizonSec;
    const elapsed = elapsedNow();
    // Pausing while drawing holds the boundary still; the feed keeps recording either way.
    if (!S.resumeAfterDraw) S.nowT = elapsed;
    if (!S.running) {
      if (!S.reviewing) S.playT = S.nowT;
      return;
    }
    S.sim!.stepTo(S.nowT);
    if (!S.reviewing) S.playT = S.nowT;
    if (S.playT >= simEndT() - 1e-6 && !S.resultsShown) finish();
    tick();
  }

  function followNow() {
    if (!S.follow || !S.sim || dragging()) return;
    const H = S.cfg.horizonSec;
    const span = Math.min(S.view.t1 - S.view.t0, H - earliestT());
    // Anchoring at a fixed fraction keeps the frame full from the first second, because
    // the window can now reach back into the candles loaded before the session began.
    const t0 = clamp(S.playT - span * 0.4, earliestT(), H - span);
    S.view.t0 = t0;
    S.view.t1 = t0 + span;
  }

  function tick() {
    followNow();
    renderQueue();
    $<HTMLInputElement>('scrub').value = String(S.playT);
    $('scrubT').textContent = `${fmtT(S.playT)} / ${fmtT(S.cfg.horizonSec)}`;
    $('scrubNote').textContent = S.reviewing
      ? `Reviewing ${fmtT(S.playT)} — press Live to return to now (${fmtT(S.nowT)}).`
      : S.running
        ? 'Real time, 1×. Drag to review what already happened.'
        : '';
    updateLive();
    setBadge();
    draw();
    renderLedger();
  }

  function finish() {
    if (S.mode === 'live') {
      $('liveStop').hidden = true;
      $('liveStart').hidden = false;
      $('liveStart').textContent = 'New live chart';
    }
    S.resultsShown = true;
    S.running = false;
    S.sim!.stepTo(S.cfg.horizonSec);
    S.playT = simEndT();
    S.reviewing = false;
    S.res = S.sim!.result();
    // Replayed against the recorded tape: the same prices this run actually met.
    S.cmp = [1, 2, 3].map((L) => ({
      L,
      r: simulate(S.plan0!, { ...S.cfg, leverage: L }, priceAt, S.res!.replans),
    }));
    setPhase('DONE');
    $('runTools').hidden = true;
    $('flattenBtn').hidden = true;
    renderReview();
    renderResults();
    renderQueue();
    showTab('results');
  }

  // ---------- full screen ----------
  const fsHome = new Map<string, { parent: Node; next: Node | null }>();
  function enterFs() {
    const body = root.ownerDocument.body;
    if (body.classList.contains('fs')) return;
    body.classList.add('fs');
    const top = $('fsTop');
    const bottom = $('fsBottom');
    for (const id of ['runTools', 'flattenBtn', 'armedWrap', 'play']) {
      const el = $(id);
      fsHome.set(id, { parent: el.parentNode!, next: el.nextSibling });
      top.insertBefore(el, $('fsExit'));
    }
    for (const id of ['queue']) {
      const el = $(id);
      fsHome.set(id, { parent: el.parentNode!, next: el.nextSibling });
      bottom.appendChild(el);
    }
    const vc = root.querySelector('.viewctl')!;
    fsHome.set('viewctl', { parent: vc.parentNode!, next: vc.nextSibling });
    bottom.insertBefore(vc, bottom.firstChild);
    top.hidden = false;
    bottom.hidden = false;
    $('fsHud').hidden = false;
    root.ownerDocument.documentElement.requestFullscreen?.().catch(() => {});
    resize();
    updateLive();
  }
  function exitFs() {
    const body = root.ownerDocument.body;
    if (!body.classList.contains('fs')) return;
    body.classList.remove('fs');
    for (const [id, home] of fsHome) {
      const el = id === 'viewctl' ? root.querySelector('.viewctl')! : $(id);
      home.parent.insertBefore(el, home.next);
    }
    fsHome.clear();
    $('fsTop').hidden = true;
    $('fsBottom').hidden = true;
    $('fsHud').hidden = true;
    if (root.ownerDocument.fullscreenElement) root.ownerDocument.exitFullscreen?.().catch(() => {});
    resize();
    updateLive();
  }

  function updateLive() {
    const s = cur();
    const c = S.cfg;
    if (!$('fsHud').hidden) {
      const pnl = s.eq - c.margin;
      $('fsPrice').textContent = fmtPrice(s.p);
      $('fsPos').textContent = s.pos ? `${s.pos.d > 0 ? 'long' : 'short'} ${s.pos.Q.toFixed(5)}` : 'flat';
      $('fsPos').className = s.pos ? (s.pos.d > 0 ? 'pos' : 'neg') : '';
      $('fsEq').textContent = fmtUSD(s.eq);
      $('fsPnl').textContent = fmtUSD(pnl, true);
      $('fsPnl').className = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
      $('fsLev').textContent = s.pos ? `${s.lev.toFixed(2)}×` : '—';
      $('fsInk').textContent = `${Math.round(s.ink * 100)}%`;
      $('fsInkBar').style.width = `${s.ink * 100}%`;
      $('fsTime').textContent = `${fmtT(S.playT)} / ${fmtT(c.horizonSec)}`;
    }
    $('lvPrice').textContent = fmtPrice(s.p);
    $('lvPos').textContent = s.pos
      ? `${s.pos.d > 0 ? 'long' : 'short'} ${s.pos.Q.toFixed(5)} ${base()}`
      : 'flat';
    $('lvPos').className = s.pos ? (s.pos.d > 0 ? 'pos' : 'neg') : '';
    // The price this position has to reach just to have cost nothing. A long that is
    // up but still below this line is losing, which is otherwise a mystery.
    const beEl = $('lvBreakEven');
    if (s.pos) {
      const be = s.pos.P0 * (1 + (s.pos.d > 0 ? 1 : -1) * S.cfg.feeRate * 2);
      const away = ((be / s.p - 1) * 100) * (s.pos.d > 0 ? 1 : -1);
      beEl.textContent = `${fmtPrice(be)} (${away > 0 ? `${away.toFixed(3)}% away` : 'passed'})`;
      beEl.className = away > 0 ? 'neg' : 'pos';
    } else {
      beEl.textContent = '—';
      beEl.className = '';
    }
    $('lvEquity').textContent = fmtUSD(s.eq);
    const pnl = s.eq - c.margin;
    $('lvPnl').textContent = fmtUSD(pnl, true);
    $('lvPnl').className = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
    $('lvLev').textContent = s.pos ? `${s.lev.toFixed(2)}×` : '—';
    $('lvInk').textContent = `${Math.round(s.ink * 100)}%`;
    $('inkBar').style.width = `${s.ink * 100}%`;
  }

  function renderResults() {
    const r = S.res || S.sim!.result();
    const c = S.cfg;
    const err = forecastError(S.plan!, { N: 0, prices: [], at: priceAt });
    let h = `<h2>Actual result</h2><div class="proj"><small>Net P&amp;L from fills</small><b class="big" style="color:var(--${r.net >= 0 ? 'long' : 'short'})">${fmtUSD(r.net, true)}</b><small>Ended by ${labelReason(r.endReason)} at ${fmtT(r.endT)}, against the real ${base()} price.</small></div>`;
    h += `<div class="kv"><span>Venue fees paid</span><span>${fmtUSD(r.fees)}</span><span>Net funding paid</span><span>${fmtUSD(r.funding)}</span><span>Lowest equity</span><span>${fmtUSD(r.minEq)}</span><span>Highest effective leverage</span><span>${r.maxLev ? r.maxLev.toFixed(2) + '×' : '—'}</span><span>Fills</span><span>${r.fills.length}</span><span>Forecast error (non-cash)</span><span>${err == null ? '—' : Math.round(err).toLocaleString() + ' bps'}</span><span>Redraws during the run</span><span>${r.commits}${r.replans.length > r.commits ? ` (${r.replans.length} live updates)` : ''}</span></div>`;
    h += `<h3>Same drawing${r.replans.length ? ' and redraws' : ''}, same recorded prices, other leverage</h3><table><tr><th>Leverage</th><th class="num">Net</th><th class="num">Lowest equity</th><th>Ended by</th></tr>`;
    for (const { L, r: x } of S.cmp!)
      h += `<tr${L === c.leverage ? ' style="font-weight:600"' : ''}><td>${L}×</td><td class="num" style="color:var(--${x.net >= 0 ? 'long' : 'short'})">${fmtUSD(x.net, true)}</td><td class="num">${fmtUSD(x.minEq)}</td><td>${labelReason(x.endReason)} at ${fmtT(x.endT)}</td></tr>`;
    h += `</table><small>Leverage changed exposure, not the drawing. The price move is already multiplied by quantity; nothing multiplies it again.</small>`;
    h += `<div class="btns"><button id="rerun" class="btn primary">Run again on a new session</button><button id="back2" class="btn">Back to drawing</button></div>`;
    h += `<small>There is no seed to replay: the next run meets whatever the market does next.</small>`;
    h += `<div class="export"><h3>Export this run</h3><p class="small">The video replays your sketch, the market as it happened, every fill, and the equity and P&amp;L as time passes. Recorded in the browser; nothing is uploaded.</p>
      <div class="btns"><button id="exVideo" class="btn primary">Record video (12 s)</button><button id="exPng" class="btn">Save chart as PNG</button><button id="exJson" class="btn">Save plan and run as JSON</button></div>
      <div id="exStatus" class="status"></div><div id="exPreview"></div></div>`;
    $('tab-results').innerHTML = h;
    $('exVideo').onclick = exportVideo;
    $('exPng').onclick = exportPNG;
    $('exJson').onclick = exportJSON;
    $('rerun').onclick = () => newSession();
    $('back2').onclick = backToDraft;
  }

  let ledgerSig = '';
  function renderLedger() {
    if (!S.sim) return;
    const items = S.sim.log.filter((l) => l.t <= S.playT + 1e-6);
    const sig = items.length + ':' + (items.length ? items[items.length - 1].text.length : 0);
    if (sig === ledgerSig) return;
    ledgerSig = sig;
    $('tab-ledger').innerHTML = items.length
      ? `<h2>Fills and events</h2><div class="log">${items
          .map(
            (l) =>
              `<div><span>${fmtT(l.t)}</span><span${
                l.kind === 'warn'
                  ? ' style="color:var(--amber)"'
                  : l.kind === 'end'
                    ? ' style="font-weight:600"'
                    : l.kind === 'replan' || l.kind === 'amend'
                      ? ' style="color:var(--blue);font-weight:600"'
                      : ''
              }>${esc(l.text)}</span></div>`,
          )
          .join('')}</div>`
      : '<p class="small">No events yet.</p>';
  }

  let termsRendered = false;
  let guideRendered = false;
  function showTab(name: string) {
    if (name === 'terms' && !termsRendered) {
      termsRendered = true;
      $('tab-terms').innerHTML = `<h2>Terms traders use, and what they mean here</h2><p class="small">Each entry shows the shape and how Trace treats it. Vocabulary is the same on every chart; the execution rules are Trace's.</p><ul class="gloss">${GLOSS.map((g) => `<li><h4>${esc(g.title)}</h4>${g.svg()}<p>${esc(g.text)}</p></li>`).join('')}</ul>`;
    }
    if (name === 'guide' && !guideRendered) {
      guideRendered = true;
      $('tab-guide').innerHTML = guideHtml(base());
    }
    root
      .querySelectorAll<HTMLElement>('.tabs [role=tab]')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    root.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + name));
  }

  // ---------- canvas ----------
  let W = 1200;
  let HH = 560;
  let DPR = 1;
  const PAD = { l: 112, r: 168, t: 22, b: 32 };
  const narrow = () => W < 700;
  const plotW = () => W - PAD.l - PAD.r;
  const plotH = () => HH - PAD.t - PAD.b;
  const xOfT = (t: number) => PAD.l + ((t - S.view.t0) / (S.view.t1 - S.view.t0)) * plotW();
  const tOfX = (x: number) => S.view.t0 + ((x - PAD.l) / plotW()) * (S.view.t1 - S.view.t0);
  const yOfP = (p: number) =>
    PAD.t + plotH() / 2 - (((p / S.cfg.refPrice - 1) * 100 - S.view.pc) / S.yRange) * (plotH() / 2);
  const pOfY = (y: number) =>
    S.cfg.refPrice * (1 + (S.view.pc + ((PAD.t + plotH() / 2 - y) / (plotH() / 2)) * S.yRange) / 100);

  function resize() {
    const fs = root.ownerDocument.body.classList.contains('fs');
    const w = fs
      ? window.innerWidth
      : Math.max(320, C.parentElement!.getBoundingClientRect().width);
    const h = fs ? window.innerHeight : Math.round(clamp(w * 0.5, 300, 600));
    PAD.t = fs ? 100 : 22;
    PAD.b = fs ? 74 : 32;
    DPR = window.devicePixelRatio || 1;
    C.width = Math.round(w * DPR);
    C.height = Math.round(h * DPR);
    C.style.height = h + 'px';
    W = w;
    HH = h;
    PAD.r = w < 700 ? 96 : 168;
    PAD.l = w < 700 ? 66 : 112;
    draw();
  }

  let exporting = false;
  function draw() {
    if (!S.cfg || !S.plan) return;
    if (S.yAuto && !exporting) autoFitPrice();
    const c = S.cfg;
    const H = c.horizonSec;
    const p = S.plan;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, HH);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, HH);
    const x0 = PAD.l;
    const x1 = W - PAD.r;
    const y0 = PAD.t;
    const y1 = HH - PAD.b;
    ctx.font = font('12px');
    ctx.textBaseline = 'middle';

    // grid
    const vspan = S.view.t1 - S.view.t0;
    const tStep =
      [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find(
        (s) => plotW() / (vspan / s) >= 52,
      ) || 7200;
    for (let t = Math.ceil(S.view.t0 / tStep) * tStep; t <= S.view.t1 + 1e-6; t += tStep) {
      const x = xOfT(t);
      ctx.strokeStyle = Math.abs(t) < 1e-9 ? '#C8CED6' : '#E3E7EC';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.fillStyle = '#5E6774';
      ctx.textAlign = 'center';
      ctx.fillText(fmtTSigned(t), x, y1 + 14);
    }
    const steps = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 50];
    const pStep = steps.find((s) => (S.yRange * 2) / s <= 9) || 50;
    for (
      let k = Math.ceil((S.view.pc - S.yRange) / pStep);
      k <= Math.floor((S.view.pc + S.yRange) / pStep);
      k++
    ) {
      const pct = +(k * pStep).toFixed(4);
      const y = yOfP(c.refPrice * (1 + pct / 100));
      if (y < y0 || y > y1) continue;
      ctx.strokeStyle = k === 0 ? '#B7BFC8' : '#E3E7EC';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      const label = fmtPrice(c.refPrice * (1 + pct / 100));
      ctx.fillStyle = '#5E6774';
      ctx.textAlign = 'right';
      ctx.fillText(label, x0 - 8, y);
      if (!narrow()) {
        ctx.fillStyle = '#8B939E';
        const pctTxt =
          (pct > 0 ? '+' : '') + (Math.abs(pct) < 1 ? pct.toFixed(3).replace(/0+$/, '') : pct) + '%';
        ctx.fillText(pctTxt, x0 - 8 - ctx.measureText(label).width - 8, y);
      }
    }

    // flat bands
    for (const f of p.flatIntervals) {
      if (f.kind === 'bridged') continue;
      const xa = clamp(xOfT(f.t0), x0, x1);
      const xb = clamp(xOfT(f.t1), x0, x1);
      if (xb - xa < 1) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(xa, y0, xb - xa, y1 - y0);
      ctx.clip();
      ctx.fillStyle = 'rgba(154,163,174,.08)';
      ctx.fillRect(xa, y0, xb - xa, y1 - y0);
      ctx.strokeStyle = 'rgba(154,163,174,.45)';
      ctx.lineWidth = 1;
      for (let x = xa - (y1 - y0); x < xb; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x + (y1 - y0), y0);
        ctx.stroke();
      }
      ctx.restore();
      if (xb - xa > 34) {
        ctx.fillStyle = '#6B7480';
        ctx.textAlign = 'center';
        ctx.fillText(
          f.kind === 'start' ? 'no position yet' : f.kind === 'end' ? 'time exit' : 'flat',
          (xa + xb) / 2,
          y0 + 28,
        );
      }
    }

    // thresholds
    const s = cur();
    let th: Thresholds | null = null;
    let d = 0;
    if (s.pos) {
      th = s.pos.th;
      d = s.pos.d;
    } else if (p.first && !S.sim) {
      th = { tp: p.first.tp, stop: p.first.stop, liq: p.first.liq };
      d = p.first.leg.dir;
    }
    if (th) {
      if (th.liq) {
        const yl = clamp(yOfP(th.liq), y0, y1);
        ctx.fillStyle = 'rgba(198,65,44,.07)';
        if (d > 0) ctx.fillRect(x0, yl, x1 - x0, y1 - yl);
        else ctx.fillRect(x0, y0, x1 - x0, yl - y0);
      }
      const used: number[] = [];
      const line = (price: number | null, color: string, dash: number[], label: string) => {
        if (!price) return;
        const off = price > pOfY(y0) || price < pOfY(y1);
        let y = clamp(yOfP(price), y0 + 9, y1 - 9);
        while (used.some((u) => Math.abs(u - y) < 30)) y += price > pOfY(y0) ? 30 : -30;
        used.push(y);
        if (!off) {
          ctx.save();
          ctx.setLineDash(dash);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.fillStyle = color;
          ctx.beginPath();
          const yy = price > pOfY(y0) ? y0 + 2 : y1 - 2;
          const dir = price > pOfY(y0) ? -1 : 1;
          ctx.moveTo(x1 - 6, yy);
          ctx.lineTo(x1 - 12, yy - dir * 7);
          ctx.lineTo(x1, yy - dir * 7);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.font = font('600 12px');
        ctx.fillText(label, x1 + 6, y - 8);
        ctx.font = font('12px');
        ctx.fillText(
          fmtPrice(price) + (off ? (price > pOfY(y0) ? ' above' : ' below') : ''),
          x1 + 6,
          y + 8,
        );
      };
      // Break-even, drawn only while a position is open. Without it the most common
      // surprise in the whole app is a leg that is green on the chart and red in the
      // P&L: at 0.045% a side a round trip costs 0.09% of price, which on BTC is about
      // $70, and a move smaller than that is a loss no matter which way it went.
      const bePos = cur().pos;
      if (bePos) {
        const be = bePos.P0 * (1 + (bePos.d > 0 ? 1 : -1) * c.feeRate * 2);
        line(be, '#9A6200', [3, 3], narrow() ? 'Break-even' : 'Break-even after fees');
      }
      line(th.tp, '#1F8A5B', [6, 4], narrow() ? `TP +${fmtUSD0(c.tpTarget)}` : `Take profit +${fmtUSD0(c.tpTarget)}`);
      line(th.stop, '#C6412C', [6, 4], narrow() ? `Stop −${fmtUSD0(c.lossLimit)}` : `Stop, loss limit ${fmtUSD0(c.lossLimit)}`);
      line(th.liq, '#8E2A1B', [2, 4], narrow() ? 'Liq. est.' : 'Liquidation estimate');
    }

    // raw strokes
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.strokeStyle = '#7F8791';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const sketch = (st: Point[]) => {
      if (!st.length) return;
      ctx.beginPath();
      ctx.moveTo(xOfT(st[0].t), yOfP(st[0].p));
      if (st.length < 3) {
        for (const q of st) ctx.lineTo(xOfT(q.t), yOfP(q.p));
        if (st.length === 1) ctx.lineTo(xOfT(st[0].t) + 0.1, yOfP(st[0].p));
      } else {
        for (let i = 1; i < st.length - 1; i++) {
          const a = st[i];
          const b = st[i + 1];
          ctx.quadraticCurveTo(
            xOfT(a.t),
            yOfP(a.p),
            (xOfT(a.t) + xOfT(b.t)) / 2,
            (yOfP(a.p) + yOfP(b.p)) / 2,
          );
        }
        const l = st[st.length - 1];
        ctx.lineTo(xOfT(l.t), yOfP(l.p));
      }
      ctx.stroke();
    };
    for (const st of S.strokes) sketch(st);
    if (S.live && S.live.mode === 'draw') {
      ctx.save();
      ctx.strokeStyle = '#2E4FD8';
      ctx.lineWidth = 2.5;
      sketch(S.live.pts);
      ctx.restore();
    }

    // sampled path: thin, dashed where a pen lift was bridged
    const segs: { x: number; y: number; b: boolean }[][] = [];
    let run: { x: number; y: number; b: boolean }[] | null = null;
    for (const col of p.cols) {
      if (col.gap) {
        run = null;
        continue;
      }
      if (!run) {
        run = [];
        segs.push(run);
      }
      run.push({ x: xOfT(col.t), y: yOfP(col.p!), b: col.bridged });
    }
    for (const sg of segs)
      for (let i = 1; i < sg.length; i++) {
        ctx.save();
        ctx.strokeStyle = 'rgba(46,79,216,.38)';
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        if (sg[i].b || sg[i - 1].b) ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(sg[i - 1].x, sg[i - 1].y);
        ctx.lineTo(sg[i].x, sg[i].y);
        ctx.stroke();
        ctx.restore();
      }

    // The executable spine, lit by equity ink. Legs and flats are drawn differently on
    // purpose: a drawing that simplified to nothing but flats used to render as the same
    // thick blue line as a real plan, so "no trade" looked identical to a trade.
    const items = [...p.legs, ...p.flats].sort((a, b) => a.t0 - b.t0);
    const legLen = (it: Leg) =>
      Math.hypot(xOfT(it.t1) - xOfT(it.t0), yOfP(it.p1) - yOfP(it.p0));
    let budget =
      p.legs.reduce((a, l) => a + legLen(l), 0) * (S.sim ? s.ink : 1);

    for (const it of items) {
      const xa = xOfT(it.t0);
      const ya = yOfP(it.p0);
      const xb = xOfT(it.t1);
      const yb = yOfP(it.p1);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (it.dir === 0) {
        // A flat holds no position, so it is drawn as the flat hatching colour, dashed.
        ctx.strokeStyle = 'rgba(154,163,174,.85)';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(xa, ya);
        ctx.lineTo(xb, yb);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(46,79,216,.22)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(xa, ya);
        ctx.lineTo(xb, yb);
        ctx.stroke();
        if (budget > 0) {
          const len = legLen(it);
          const u = Math.min(1, budget / (len || 1e-9));
          budget -= len;
          ctx.strokeStyle = '#2E4FD8';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(xa, ya);
          ctx.lineTo(lerp(xa, xb, u), lerp(ya, yb, u));
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // leg markers
    for (const l of p.legs) {
      const x = xOfT(l.t0);
      const y = yOfP(l.p0);
      const col = l.dir > 0 ? '#1F8A5B' : '#C6412C';
      ctx.fillStyle = col;
      ctx.beginPath();
      if (l.dir > 0) {
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x - 7, y + 5);
        ctx.lineTo(x + 7, y + 5);
      } else {
        ctx.moveTo(x, y + 9);
        ctx.lineTo(x - 7, y - 5);
        ctx.lineTo(x + 7, y - 5);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = font('600 10px');
      ctx.fillText(String(l.id), x, y + (l.dir > 0 ? 1 : -1));
      const xe = xOfT(l.t1);
      const ye = yOfP(l.p1);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(xe, ye, 4, 0, Math.PI * 2);
      ctx.stroke();
      if (c.showSwings) {
        ctx.font = font('10px');
        ctx.fillStyle = '#5E6774';
        ctx.textAlign = 'center';
        if (l.turn) ctx.fillText(l.turn, xe, ye + (l.dir > 0 ? -12 : 16));
        const mx = (x + xe) / 2;
        const my = (y + ye) / 2;
        if (xe - x > 46) {
          ctx.fillStyle = col;
          ctx.fillText(
            `${l.slope} ${l.rate >= 0 ? '+' : ''}${Math.abs(l.rate) >= 10 ? l.rate.toFixed(0) : l.rate.toFixed(3)}%/min`,
            mx,
            my + (l.dir > 0 ? 14 : -10),
          );
        }
      }
    }
    ctx.font = font('12px');

    // History loaded before the session began, at negative t. Drawing it is what keeps
    // the frame full from the first second instead of a squiggle in the corner.
    const hist: { t: number; p: number }[] = [];
    for (const k of feed.tape.candles) {
      const tk = (k.t + CANDLE_MS / 2 - feed.tape.t0Ms) / 1000;
      if (tk >= 0) break;
      if (tk < S.view.t0 - 120 || tk > S.view.t1 + 120) continue;
      hist.push({ t: tk, p: k.c });
    }
    if (hist.length) {
      if (S.sim?.series.length) hist.push({ t: 0, p: S.sim.series[0].p });
      else if (feed.tape.last) hist.push({ t: 0, p: feed.tape.last });
    }
    if (hist.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#1B2431';
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(xOfT(hist[0].t), yOfP(hist[0].p));
      for (let i = 1; i < hist.length; i++) ctx.lineTo(xOfT(hist[i].t), yOfP(hist[i].p));
      ctx.stroke();
      ctx.restore();
    }

    // the market itself
    if (S.sim) {
      const ser = S.sim.series;
      const n = clamp(Math.floor((S.playT / H) * S.sim.N), 0, Math.max(0, ser.length - 1));
      if (ser.length) {
        ctx.strokeStyle = '#1B2431';
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(xOfT(ser[0].t), yOfP(ser[0].p));
        for (let i = 0; i <= n; i++) ctx.lineTo(xOfT(ser[i].t), yOfP(ser[i].p));
        ctx.stroke();
        let i = 0;
        while (i <= n) {
          if (!ser[i].pos) {
            i++;
            continue;
          }
          const dd = ser[i].pos!.d;
          ctx.strokeStyle = dd > 0 ? '#1F8A5B' : '#C6412C';
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.moveTo(xOfT(ser[i].t), yOfP(ser[i].p));
          let j = i;
          while (j + 1 <= n && ser[j + 1].pos && ser[j + 1].pos!.d === dd) {
            j++;
            ctx.lineTo(xOfT(ser[j].t), yOfP(ser[j].p));
          }
          ctx.stroke();
          i = j + 1;
        }
        for (const f of S.sim.fills) {
          if (f.t > S.playT + 1e-6) continue;
          const x = xOfT(f.t);
          const y = yOfP(f.p);
          ctx.fillStyle = f.side === 'buy' ? '#1F8A5B' : '#C6412C';
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.font = font('600 9px');
          ctx.fillText(f.side === 'buy' ? 'B' : 'S', x, y + 0.5);
        }
        ctx.font = font('12px');
        const xc = xOfT(S.playT);
        ctx.strokeStyle = '#1B2431';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xc, y0);
        ctx.lineTo(xc, y1);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // the three regions: executed past, locked queue window, editable future
      if (S.phase === 'RUN') {
        const tn = S.sim.tNow;
        const Lb = Math.min(H, tn + c.lockSec);
        const xa = clamp(xOfT(tn), x0, x1);
        const xb = clamp(xOfT(Lb), x0, x1);
        ctx.fillStyle = 'rgba(27,36,49,.045)';
        ctx.fillRect(x0, y0, xa - x0, y1 - y0);
        ctx.fillStyle = 'rgba(154,98,0,.16)';
        ctx.fillRect(xa, y0, xb - xa, y1 - y0);
        ctx.strokeStyle = '#9A6200';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xb, y0);
        ctx.lineTo(xb, y1);
        ctx.stroke();
        ctx.font = font('600 11px');
        if (xa - x0 > 70) {
          ctx.fillStyle = '#5E6774';
          ctx.textAlign = 'right';
          ctx.fillText('executed', xa - 6, y0 + 12);
        }
        ctx.fillStyle = '#9A6200';
        ctx.textAlign = 'left';
        const qLabel = `queued, locked ${c.lockSec} s`;
        if (ctx.measureText(qLabel).width < x1 - xb - 12) ctx.fillText(qLabel, xb + 6, y0 + 12);
        if (S.resumeAfterDraw) ctx.fillText('clock paused while you draw', xb + 6, y0 + 60);
        if (S.tool === 'adjust' && !S.sim.ended && !S.reviewing) drawHandles(x0, x1, y0, y1);
        ctx.fillStyle = '#2E4FD8';
        ctx.textAlign = 'left';
        const hint = S.reviewing
          ? 'reviewing the past: press Live to draw again'
          : S.tool === 'adjust'
            ? 'drag a handle to move a turn, or drag the target or stop line'
            : S.tool === 'erase'
              ? 'click the plan to cut it there, or drag a range'
              : S.tool === 'draw'
                ? 'sketch a new shape: it replaces the plan from where you start'
                : '';
        if (hint && ctx.measureText(hint).width < x1 - xb - 12) ctx.fillText(hint, xb + 6, y0 + 44);
        ctx.font = font('12px');
      }
    }
    ctx.restore();

    drawCloseButton();

    // Why nothing is trading, said on the chart. Both of these were previously only
    // explained in the ledger, so the visible result was a confident blue spine, an
    // empty order queue and no reason given.
    const armedOn = $<HTMLInputElement>('armed').checked;
    if (p.legs.length && S.phase !== 'RUN' && S.phase !== 'DONE') {
      notice(
        x0,
        y1,
        'This plan is not running yet, so nothing has been sent.',
        S.mode === 'live'
          ? 'Press “Start live chart” to run it against the market.'
          : 'Tick the box at the bottom of Review, then press “Authorize and run”.',
      );
    } else if (S.phase === 'RUN' && S.sim && !S.sim.ended && p.legs.length && !armedOn) {
      notice(
        x0,
        y1,
        'Not armed: this drawing will not be sent.',
        'Tick “Armed” above the chart to trade it.',
      );
    } else if (
      S.phase === 'RUN' &&
      S.sim &&
      !S.sim.ended &&
      armedOn &&
      p.legs.length &&
      !S.sim.queue(S.cfg.lockSec).length &&
      !cur().pos
    ) {
      notice(
        x0,
        y1,
        'Nothing queued: every leg you drew starts before now.',
        'Draw to the right of the dashed now line — the past is already settled.',
      );
    } else if (S.strokes.length && !p.legs.length) {
      ctx.fillStyle = '#9A6200';
      ctx.textAlign = 'left';
      ctx.font = font('600 12px');
      ctx.fillText(
        `No trade: every stretch you drew moves less than the ±${fmtUSD((c.refPrice * c.tolPct) / 100)} tolerance.`,
        x0 + 8,
        y1 - 26,
      );
      ctx.font = font('12px');
      ctx.fillText(
        'Draw a steeper move, or lower Simplify tolerance in the configurator.',
        x0 + 8,
        y1 - 10,
      );
    } else if (p.simplified && !S.sim) {
      ctx.fillStyle = '#9A6200';
      ctx.textAlign = 'left';
      ctx.font = font('600 12px');
      ctx.fillText(
        `Leg budget ${c.legBudget}: trading the ${p.legs.length} largest of ${p.legsAtBase} swings.`,
        x0 + 8,
        y1 - 26,
      );
      ctx.font = font('12px');
      ctx.fillText('Raise the budget in Review to trade them all.', x0 + 8, y1 - 10);
    }
    if (c.outageOn) {
      const xa = clamp(xOfT(c.outageFrom * 60), x0, x1);
      const xb = clamp(xOfT(c.outageTo * 60), x0, x1);
      ctx.fillStyle = 'rgba(154,98,0,.10)';
      ctx.fillRect(xa, y0, xb - xa, y1 - y0);
      ctx.fillStyle = '#9A6200';
      ctx.textAlign = 'center';
      ctx.fillText('service outage', (xa + xb) / 2, y1 - 10);
    }
    for (const t of fundingTimes(c)) {
      const x = xOfT(t);
      if (x < x0 || x > x1) continue;
      ctx.fillStyle = '#8B939E';
      ctx.textAlign = 'center';
      ctx.fillText('funding', x, y0 - 10);
      ctx.fillRect(x - 0.5, y0 - 4, 1, 4);
    }
  }

  // ---------- pointer input ----------
  const pt = (e: PointerEvent) => {
    const r = C.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inPlot = (q: { x: number; y: number }) =>
    q.x >= PAD.l && q.x <= W - PAD.r && q.y >= PAD.t && q.y <= HH - PAD.b;

  function lineHit(y: number) {
    const F = S.plan?.first;
    if (!F) return null;
    if (F.tp && Math.abs(yOfP(F.tp) - y) < 9) return 'tp' as const;
    if (F.stop && Math.abs(yOfP(F.stop) - y) < 9) return 'stop' as const;
    return null;
  }

  type PenResult = Point | { update: true; p: number };
  function penPoint(q: { x: number; y: number }, last?: Point, minT?: number | null): PenResult {
    let t = clamp(tOfX(q.x), 0, S.cfg.horizonSec);
    const p = clamp(pOfY(q.y), pOfY(HH - PAD.b), pOfY(PAD.t));
    if (!last) return { t: minT != null ? Math.max(minT, t) : t, p };
    if (minT != null && t < minT) t = minT;
    const a = 1 - S.cfg.penSmooth;
    const ps = last.p + a * (p - last.p);
    if (S.cfg.forwardOnly && t <= last.t + 1e-9) return { update: true, p: ps };
    if (Math.abs(xOfT(t) - xOfT(last.t)) < 2) return { update: true, p: ps };
    return { t, p: ps };
  }
  const applyPen = (pts: Point[], r: PenResult) => {
    if ('update' in r) {
      if (!pts.length) return false;
      pts[pts.length - 1].p = r.p;
      return true;
    }
    pts.push(r);
    return true;
  };

  /** Seconds since the session started, straight from the wall clock. */
  const elapsedNow = () => clamp((Date.now() - feed.tape.t0Ms) / 1000, 0, S.cfg.horizonSec);
  /** Earliest time we hold data for. History sits at negative t, before the session. */
  function earliestT() {
    const k = feed.tape.candles[0];
    return k ? Math.min(0, (k.t - feed.tape.t0Ms) / 1000) : 0;
  }
  /**
   * The lock boundary must come from the wall clock, not from the simulator's stepped
   * position. `sim.tNow` only advances inside the animation loop, and the browser
   * throttles that loop in a background or occluded tab — so a stroke drawn just after
   * coming back would be placed against a stale boundary, land in what is already the
   * past, and be silently dropped by the next replan.
   */
  const boundary = () =>
    Math.min(S.cfg.horizonSec, Math.max(S.sim?.tNow ?? 0, elapsedNow()) + S.cfg.lockSec);
  /** Bring the clock and the simulator up to date before an edit reads the boundary. */
  function syncClock() {
    if (!S.cfg) return;
    S.nowT = elapsedNow();
    if (S.sim && !S.sim.ended) S.sim.stepTo(S.nowT);
  }
  const drawingEnd = (strokes: Stroke[]) =>
    strokes.reduce((m, st) => st.reduce((mm, q) => Math.max(mm, q.t), m), 0);
  function cutRange(strokes: Stroke[], ta: number, tb: number): Stroke[] {
    const out: Stroke[] = [];
    for (const st of strokes) {
      let acc: Point[] = [];
      for (const q of st) {
        if (q.t >= ta - 1e-9 && q.t <= tb + 1e-9) {
          if (acc.length) {
            out.push(acc);
            acc = [];
          }
        } else acc.push(q);
      }
      if (acc.length) out.push(acc);
    }
    return out;
  }

  /**
   * Draws the close control. Deliberately loud: a filled disc in the short colour with a
   * white cross, a soft halo so it reads against both the price line and the hatching,
   * and on hover it grows and names itself so the one destructive click on the canvas is
   * never a guess.
   */
  function drawCloseButton() {
    const b = closeHit();
    if (!b) return;
    const hot = S.closeHot;
    const r = hot ? b.r + 3 : b.r;
    const pos = cur().pos!;
    ctx.save();

    ctx.shadowColor = 'rgba(15,23,42,.30)';
    ctx.shadowBlur = hot ? 12 : 7;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = hot ? '#A8341F' : '#C6412C';
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = hot ? 3.2 : 2.6;
    ctx.lineCap = 'round';
    const k = r * 0.42;
    ctx.beginPath();
    ctx.moveTo(b.x - k, b.y - k);
    ctx.lineTo(b.x + k, b.y + k);
    ctx.moveTo(b.x + k, b.y - k);
    ctx.lineTo(b.x - k, b.y + k);
    ctx.stroke();

    if (hot) {
      const label = `Close ${pos.d > 0 ? 'long' : 'short'} ${pos.Q.toFixed(5)} ${base()}`;
      ctx.font = font('600 12px');
      const tw = ctx.measureText(label).width;
      // Flip the tooltip to whichever side has room.
      const right = b.x + r + 8 + tw + 12 <= W - PAD.r;
      const lx = right ? b.x + r + 8 : b.x - r - 8 - tw - 12;
      const ly = b.y - 11;
      ctx.fillStyle = 'rgba(27,36,49,.94)';
      ctx.beginPath();
      ctx.roundRect(lx, ly, tw + 12, 22, 5);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 6, ly + 11);
    }
    ctx.restore();
  }

  /**
   * The on-chart close button: a target you can hit without aiming.
   *
   * Going flat used to live only in a text button in the toolbar, which is the wrong
   * place for the one action that is urgent. It sits at the lock boundary — the earliest
   * moment a close can actually take effect — at the price the position is carrying, and
   * it only exists while there is something to close.
   */
  /** A two-line note in the bottom-left of the plot, for states that need explaining. */
  function notice(x0: number, y1: number, head: string, sub: string) {
    ctx.save();
    ctx.fillStyle = '#9A6200';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font('600 12px');
    ctx.fillText(head, x0 + 8, y1 - 26);
    ctx.font = font('12px');
    ctx.fillText(sub, x0 + 8, y1 - 10);
    ctx.restore();
  }

  const toolCursor = (t: Tool) =>
    t === 'pan' || t === 'adjust' ? 'grab' : t === 'erase' ? 'col-resize' : 'crosshair';

  const CLOSE_R = 15;
  function closeHit(): { x: number; y: number; r: number } | null {
    if (S.phase !== 'RUN' || !S.sim || S.sim.ended || S.reviewing) return null;
    if (!cur().pos) return null;
    // Immediately to the *right* of the lock boundary: the first moment a close can take
    // effect, and on the empty side of the line rather than buried in the price history
    // and equity ink to its left. Only a *pointerdown* on the disc closes, so a stroke
    // dragged across it on the way somewhere else is unaffected.
    const x = clamp(xOfT(boundary()) + CLOSE_R + 6, PAD.l + CLOSE_R, W - PAD.r - CLOSE_R);
    const y = clamp(yOfP(cur().p), PAD.t + CLOSE_R, HH - PAD.b - CLOSE_R);
    return { x, y, r: CLOSE_R };
  }
  const overClose = (q: { x: number; y: number }) => {
    const b = closeHit();
    // A slightly generous radius: this is the button you press in a hurry.
    return !!b && Math.hypot(q.x - b.x, q.y - b.y) <= b.r + 4;
  };

  function closePosition() {
    if (!S.sim || S.sim.ended) return;
    S.strokes = cutRange(S.strokes, boundary(), S.cfg.horizonSec + 1);
    S.live = null;
    S.closeHot = false;
    liveCommit('Closed the position from the chart');
  }

  C.addEventListener('pointerdown', (e) => {
    // Closing beats every tool, including pan: a stroke that starts on the button is
    // never a drawing.
    if (overClose(pt(e))) {
      e.preventDefault();
      closePosition();
      return;
    }
    if (S.phase === 'RUN' && S.tool !== 'pan' && !S.sim!.ended && !S.reviewing) {
      const q = pt(e);
      if (!inPlot(q)) return;
      syncClock();
      C.setPointerCapture(e.pointerId);
      let paused = false;
      if (S.cfg.pauseWhileDrawing && S.running) {
        S.resumeAfterDraw = true;
        paused = true;
      }
      const Lb = boundary();
      const first = penPoint(q, undefined, Lb) as Point;
      if (S.tool === 'adjust') {
        const h = handleHit(q);
        if (!h) {
          S.pan = { x: q.x, y: q.y, t0: S.view.t0, t1: S.view.t1, pc: S.view.pc };
          C.style.cursor = 'grabbing';
          return;
        }
        beginAdjust(h, Lb);
        return;
      }
      S.live =
        S.tool === 'erase'
          ? { mode: 'erase', tA: first.t, tB: first.t, Lb: paused ? Lb : null }
          : { mode: 'draw', pts: [first], Lb: paused ? Lb : null };
      liveApply();
      return;
    }
    if (S.phase === 'RUN' || S.phase === 'DONE') {
      const q = pt(e);
      if (!inPlot(q)) return;
      S.pan = { x: q.x, y: q.y, t0: S.view.t0, t1: S.view.t1, pc: S.view.pc };
      C.setPointerCapture(e.pointerId);
      C.style.cursor = 'grabbing';
      return;
    }
    const q = pt(e);
    if (!inPlot(q)) return;
    const hit = lineHit(q.y);
    C.setPointerCapture(e.pointerId);
    if (hit) {
      S.drag = hit;
      C.style.cursor = 'ns-resize';
      return;
    }
    S.drawing = [
      {
        t: clamp(tOfX(q.x), 0, S.cfg.horizonSec),
        p: clamp(pOfY(q.y), pOfY(HH - PAD.b), pOfY(PAD.t)),
      },
    ];
    S.strokes.push(S.drawing);
    if (S.phase === 'REVIEWED') setPhase('DRAFT');
    S.dirty = true;
    schedule();
  }, sig);

  C.addEventListener('pointermove', (e) => {
    const q = pt(e);
    if (S.adjust) {
      moveAdjust(q);
      return;
    }
    if (S.live) {
      const Lb = S.live.Lb != null ? S.live.Lb : boundary();
      if (S.live.mode === 'erase')
        S.live.tB = Math.max(Lb, clamp(tOfX(q.x), 0, S.cfg.horizonSec));
      else applyPen(S.live.pts, penPoint(q, S.live.pts[S.live.pts.length - 1], Lb));
      liveApply();
      return;
    }
    if (S.pan) {
      unfollow();
      const span = S.pan.t1 - S.pan.t0;
      const dt = (-(q.x - S.pan.x) / plotW()) * span;
      const H = S.cfg.horizonSec;
      S.view.t0 = clamp(S.pan.t0 + dt, 0, H - span);
      S.view.t1 = S.view.t0 + span;
      S.view.pc = clamp(S.pan.pc + ((q.y - S.pan.y) / (plotH() / 2)) * S.yRange, -95, 500);
      updateViewLabel();
      draw();
      return;
    }
    if (S.drag) {
      const F = S.plan!.first!;
      const price = clamp(pOfY(q.y), pOfY(HH - PAD.b), pOfY(PAD.t));
      const gross = F.leg.dir * F.Q * (price - F.leg.p0);
      const notional = S.cfg.leverage * S.cfg.margin;
      const maxGain = F.leg.dir < 0 ? notional : 10 * S.cfg.margin;
      if (S.drag === 'tp')
        $<HTMLInputElement>('tpTarget').value = String(clamp(Math.round(gross * 2) / 2, 0, maxGain));
      else
        $<HTMLInputElement>('lossLimit').value = String(
          clamp(Math.round(-gross * 2) / 2, 0, S.cfg.margin),
        );
      if (S.phase === 'REVIEWED') setPhase('DRAFT');
      S.dirty = true;
      schedule();
      return;
    }
    if (S.drawing) {
      if (applyPen(S.drawing, penPoint(q, S.drawing[S.drawing.length - 1]))) {
        S.dirty = true;
        schedule();
      }
      return;
    }
    const hot = overClose(q);
    if (hot !== S.closeHot) {
      S.closeHot = hot;
      S.dirty = true;
      schedule();
    }
    if (hot) {
      C.style.cursor = 'pointer';
      return;
    }
    if (C.style.cursor === 'pointer') C.style.cursor = toolCursor(S.tool);
    if (S.phase !== 'RUN' && S.phase !== 'DONE')
      C.style.cursor = lineHit(q.y) ? 'ns-resize' : 'crosshair';
    else if (S.phase === 'RUN' && S.tool === 'adjust' && !S.pan && !S.reviewing) {
      const h = handleHit(q);
      C.style.cursor = h ? (h.kind === 'vertex' ? 'grab' : 'ns-resize') : 'default';
    }
  }, sig);

  const endPointer = () => {
    if (S.adjust) {
      endAdjust();
      return;
    }
    if (S.live) {
      liveApply(true);
      S.live = null;
      if (S.resumeAfterDraw) S.resumeAfterDraw = false;
      return;
    }
    if (S.pan) {
      S.pan = null;
      C.style.cursor = 'grab';
    }
    if (S.drag) {
      S.drag = null;
      C.style.cursor = 'crosshair';
    }
    if (S.drawing) S.drawing = null;
    S.dirty = true;
    schedule();
  };
  C.addEventListener('pointerup', endPointer, sig);
  C.addEventListener('pointercancel', endPointer, sig);

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!S.dirty) return;
      S.dirty = false;
      if (S.drawing || S.drag) {
        S.plan = compile(S.strokes, S.cfg, S.overrides);
        $('hint').style.display = S.strokes.length ? 'none' : '';
        draw();
      } else recompile();
    });
  }

  // ---------- live redraw during the run ----------
  function workingStrokes(final?: boolean): Stroke[] {
    const Lb = boundary();
    const H = S.cfg.horizonSec;
    if (!S.live) return S.strokes;
    if (S.live.mode === 'erase') {
      const a = Math.max(Lb, Math.min(S.live.tA, S.live.tB));
      let b = Math.max(S.live.tA, S.live.tB);
      if (final && b - a < H / 300) b = H + 1;
      return b > a ? cutRange(S.strokes, a, b) : S.strokes;
    }
    const pts = S.live.pts.filter((q) => q.t >= Lb - 1e-9);
    if (!pts.length) return S.strokes;
    return cutRange(S.strokes, pts[0].t, H + 1).concat([pts]);
  }
  let liveScheduled = false;
  function liveApply(commit?: boolean) {
    if (!S.sim || S.sim.ended) {
      if (commit) S.live = null;
      return;
    }
    const w = workingStrokes(commit);
    if (commit) S.strokes = w;
    const runIt = () => {
      liveScheduled = false;
      const strokes = commit ? S.strokes : workingStrokes(false);
      S.plan = compile(strokes, S.cfg, S.overrides);
      if (commit) {
        if ($<HTMLInputElement>('armed').checked)
          S.sim!.replan(S.plan, S.cfg.lockSec, drawingEnd(strokes), true);
        else
          S.sim!.say(
            S.sim!.tNow,
            'warn',
            'Drawing updated but the chart is not armed: nothing was sent. Tick Armed to trade it.',
          );
        S.proj = simulate(S.plan, S.cfg, spineAt(S.plan));
        renderReview();
        renderQueue();
        renderLedger();
      }
      draw();
    };
    if (commit) runIt();
    else if (!liveScheduled) {
      liveScheduled = true;
      requestAnimationFrame(runIt);
    }
  }

  /**
   * Wiring the tool buttons was lost in the port: setTool existed and beginRun called it
   * once, so Sketch looked active while Adjust, Erase and Pan did nothing at all.
   */
  const TOOL_BUTTONS: [string, Tool][] = [
    ['toolAdjust', 'adjust'],
    ['toolErase', 'erase'],
    ['toolDraw', 'draw'],
    ['toolPan', 'pan'],
  ];
  for (const [id, tool] of TOOL_BUTTONS)
    $(id).addEventListener('click', () => setTool(tool), sig);

  function setTool(t: Tool) {
    S.tool = t;
    (['adjust', 'draw', 'erase', 'pan'] as Tool[]).forEach((k) =>
      $('tool' + k[0].toUpperCase() + k.slice(1)).setAttribute('aria-pressed', String(k === t)),
    );
    C.style.cursor = toolCursor(t);
    draw();
  }

  // ---------- adjust ----------
  function futureVertices(plan: Plan, Lb: number) {
    const items: Leg[] = [...plan.legs, ...plan.flats].sort((a, b) => a.t0 - b.t0);
    const groups: Point[][] = [];
    let acc: Point[] | null = null;
    let seg = -1;
    for (const it of items) {
      if (it.t1 <= Lb + 1e-9) continue;
      if (it.seg !== seg) {
        acc = null;
        seg = it.seg;
      }
      if (!acc) {
        const t0 = Math.max(it.t0, Lb);
        const p0 =
          it.t0 < Lb ? lerp(it.p0, it.p1, (Lb - it.t0) / (it.t1 - it.t0 || 1e-9)) : it.p0;
        acc = [{ t: t0, p: p0 }];
        groups.push(acc);
      }
      acc.push({ t: it.t1, p: it.p1 });
    }
    return groups;
  }
  function handles() {
    if (!S.sim || S.sim.ended) return [] as { gi: number; vi: number; t: number; p: number }[];
    const Lb = boundary();
    const out: { gi: number; vi: number; t: number; p: number }[] = [];
    const polys = S.adjust?.polys ?? futureVertices(S.plan!, Lb);
    polys.forEach((poly, gi) =>
      poly.forEach((v, vi) => {
        if (v.t > Lb + 1e-6) out.push({ gi, vi, t: v.t, p: v.p });
      }),
    );
    return out;
  }
  function handleHit(q: { x: number; y: number }) {
    const s = cur();
    const th = s.pos ? s.pos.th : null;
    if (th?.tp && Math.abs(yOfP(th.tp) - q.y) < 9) return { kind: 'tp' as const };
    if (th?.stop && Math.abs(yOfP(th.stop) - q.y) < 9) return { kind: 'stop' as const };
    let best: { kind: 'vertex'; gi: number; vi: number; d: number } | null = null;
    for (const h of handles()) {
      const d = Math.hypot(xOfT(h.t) - q.x, yOfP(h.p) - q.y);
      if (d < 12 && (!best || d < best.d)) best = { kind: 'vertex', gi: h.gi, vi: h.vi, d };
    }
    return best;
  }
  function beginAdjust(h: { kind: 'tp' | 'stop' | 'vertex'; gi?: number; vi?: number }, Lb: number) {
    if (h.kind === 'tp' || h.kind === 'stop') {
      S.adjust = { kind: h.kind };
      C.style.cursor = 'ns-resize';
      return;
    }
    const polys = futureVertices(S.plan!, Lb);
    S.strokes = cutRange(S.strokes, Lb, S.cfg.horizonSec + 1).concat(polys);
    S.adjust = { kind: 'vertex', polys, gi: h.gi, vi: h.vi, Lb };
    C.style.cursor = 'grabbing';
  }
  function moveAdjust(q: { x: number; y: number }) {
    const a = S.adjust!;
    const c = S.cfg;
    if (a.kind === 'tp' || a.kind === 'stop') {
      const s = cur();
      if (!s.pos) return;
      const price = clamp(pOfY(q.y), pOfY(HH - PAD.b), pOfY(PAD.t));
      const gross = s.pos.d * s.pos.Q * (price - s.pos.P0) + (S.sim!.B - c.margin);
      if (a.kind === 'tp') {
        const v = Math.max(0.5, Math.round(gross * 2) / 2);
        S.sim!.cfg.tpTarget = v;
        $<HTMLInputElement>('tpTarget').value = String(v);
      } else {
        const v = clamp(Math.round(-gross * 2) / 2, 0.5, c.margin);
        S.sim!.cfg.lossLimit = v;
        $<HTMLInputElement>('lossLimit').value = String(v);
      }
      draw();
      return;
    }
    const poly = a.polys![a.gi!];
    const v = poly[a.vi!];
    const prev = poly[a.vi! - 1];
    const next = poly[a.vi! + 1];
    const colW = c.horizonSec / c.columns;
    let t = clamp(
      tOfX(q.x),
      (prev ? prev.t : a.Lb!) + colW,
      next ? next.t - colW : c.horizonSec,
    );
    if (!next) t = Math.max(t, (prev ? prev.t : a.Lb!) + colW);
    v.t = t;
    v.p = clamp(pOfY(q.y), pOfY(HH - PAD.b), pOfY(PAD.t));
    S.plan = compile(S.strokes, S.cfg, S.overrides);
    draw();
  }
  function endAdjust() {
    const a = S.adjust!;
    S.adjust = null;
    C.style.cursor = 'grab';
    if (a.kind === 'tp' || a.kind === 'stop') {
      readCfg();
      S.sim!.cfg.tpTarget = parseFloat($<HTMLInputElement>('tpTarget').value);
      S.sim!.cfg.lossLimit = parseFloat($<HTMLInputElement>('lossLimit').value);
      S.sim!.say(
        S.sim!.tNow,
        'amend',
        `${a.kind === 'tp' ? 'Take profit' : 'Loss limit'} moved to ${fmtUSD0(a.kind === 'tp' ? S.sim!.cfg.tpTarget : S.sim!.cfg.lossLimit)} while the position is open.`,
      );
      renderLedger();
      draw();
      return;
    }
    S.plan = compile(S.strokes, S.cfg, S.overrides);
    if ($<HTMLInputElement>('armed').checked)
      S.sim!.replan(S.plan, S.cfg.lockSec, drawingEnd(S.strokes), true);
    else S.sim!.say(S.sim!.tNow, 'warn', 'Adjusted but the chart is not armed: nothing was sent.');
    S.proj = simulate(S.plan, S.cfg, spineAt(S.plan));
    renderReview();
    renderQueue();
    renderLedger();
    draw();
  }
  function drawHandles(x0: number, x1: number, y0: number, y1: number) {
    for (const h of handles()) {
      const x = xOfT(h.t);
      const y = yOfP(h.p);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const active = S.adjust?.kind === 'vertex' && S.adjust.gi === h.gi && S.adjust.vi === h.vi;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#2E4FD8' : '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2E4FD8';
      ctx.stroke();
    }
  }

  function renderQueue() {
    const el = $('queue');
    if (!S.sim || el.hidden) return;
    const q = S.sim.queue(S.cfg.lockSec).slice(0, 8);
    el.innerHTML =
      `<span>Order queue${S.phase === 'RUN' ? ` (boundary ${fmtT(boundary())})` : ''}:</span>` +
      (q.length
        ? q
            .map(
              (e) =>
                `<span class="q${e.locked ? ' locked' : ''}${e.forced ? ' forced' : ''}" title="${e.locked ? 'Inside the lock window: already sent, cannot change' : 'Editable: redraw or erase to change'}">${fmtT(e.t)} ${e.type === 'open' ? (e.leg.dir > 0 ? 'buy to open' : 'sell to open') : 'close'} leg ${e.leg.id}${e.locked ? ' · locked' : ''}</span>`,
            )
            .join('')
        : `<span class="q">nothing queued${S.sim.ended ? ', plan ended' : ''}</span>`);
  }

  // ---------- controls ----------
  const RESTART_ONLY = new Set(['horizonN', 'horizonU', 'columns']);
  const INTERPRET = new Set(['gapMin', 'tolPct', 'legBudget', 'entryRule']);
  function liveConfigChange(id: string) {
    const runCfg = S.sim!.cfg;
    readCfg();
    if (RESTART_ONLY.has(id)) S.pendingRestart = true;
    S.cfg.horizonSec = runCfg.horizonSec;
    S.cfg.columns = runCfg.columns;
    S.cfg.refPrice = runCfg.refPrice;
    $<HTMLInputElement>('scrub').max = String(S.cfg.horizonSec);
    $('restartNote').hidden = !S.pendingRestart;
    if (!RESTART_ONLY.has(id)) {
      const before = JSON.stringify(S.plan!.legs.map((l) => [l.dir, l.t0, l.t1]));
      S.sim!.applyConfig(S.cfg);
      S.plan = compile(S.strokes, S.cfg, S.overrides);
      const after = JSON.stringify(S.plan.legs.map((l) => [l.dir, l.t0, l.t1]));
      if (
        (INTERPRET.has(id) || id === 'mode' || after !== before) &&
        $<HTMLInputElement>('armed').checked
      )
        S.sim!.replan(S.plan, S.cfg.lockSec, drawingEnd(S.strokes), true);
      S.proj = simulate(S.plan, S.cfg, spineAt(S.plan));
    }
    renderReview();
    renderQueue();
    renderLedger();
    updateLive();
    draw();
  }

  root.querySelectorAll<HTMLInputElement>('aside.config input, aside.config select').forEach((el) =>
    el.addEventListener(
      'input',
      () => {
      if (el.id === 'yRange') {
        S.yAuto = false;
        readCfg();
        updateViewLabel();
        draw();
        return;
      }
      if (el.id === 'tolPct') tolTouched = true;
      if (['showSwings', 'penSmooth', 'forwardOnly', 'pauseWhileDrawing'].includes(el.id)) {
        readCfg();
        draw();
        return;
      }
      if (S.phase === 'RUN' && S.sim) {
        liveConfigChange(el.id);
        return;
      }
      if (el.id === 'horizonN' || el.id === 'horizonU') {
        const oldH = S.cfg.horizonSec;
        const newH = clamp(
          Math.round(
            parseFloat($<HTMLInputElement>('horizonN').value) *
              parseFloat($<HTMLInputElement>('horizonU').value),
          ),
          10,
          86400,
        );
        if (!(newH > 0)) return;
        S.strokes.forEach((st) => st.forEach((q) => (q.t *= newH / oldH)));
        S.overrides = NO_OVERRIDES();
        S.view = { t0: 0, t1: newH, pc: S.view.pc };
      }
        edited();
      },
      sig,
    ),
  );

  const liveOrEdit = (id: string) => (S.phase === 'RUN' && S.sim ? liveConfigChange(id) : edited());
  root.querySelectorAll<HTMLButtonElement>('[data-lev]').forEach(
    (b) =>
      (b.onclick = () => {
        root
          .querySelectorAll<HTMLButtonElement>('[data-lev]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        liveOrEdit('leverage');
      }),
  );
  $('sizeMargin').onclick = () => {
    $('sizeMargin').setAttribute('aria-pressed', 'true');
    $('sizeRisk').setAttribute('aria-pressed', 'false');
    liveOrEdit('sizing');
  };
  $('sizeRisk').onclick = () => {
    $('sizeMargin').setAttribute('aria-pressed', 'false');
    $('sizeRisk').setAttribute('aria-pressed', 'true');
    liveOrEdit('sizing');
  };
  $('modePath').onclick = () => {
    $('modePath').setAttribute('aria-pressed', 'true');
    $('modeSingle').setAttribute('aria-pressed', 'false');
    liveOrEdit('mode');
  };
  $('modeSingle').onclick = () => {
    $('modePath').setAttribute('aria-pressed', 'false');
    $('modeSingle').setAttribute('aria-pressed', 'true');
    liveOrEdit('mode');
  };

  function liveCommit(note: string) {
    S.plan = compile(S.strokes, S.cfg, S.overrides);
    if ($<HTMLInputElement>('armed').checked)
      S.sim!.replan(S.plan, S.cfg.lockSec, drawingEnd(S.strokes), true);
    else
      S.sim!.say(
        S.sim!.tNow,
        'warn',
        `${note}, but the chart is not armed: nothing was sent.`,
      );
    S.proj = simulate(S.plan, S.cfg, spineAt(S.plan));
    renderReview();
    renderQueue();
    renderLedger();
    draw();
  }

  $('undo').onclick = () => {
    if (S.phase === 'RUN' && S.sim) {
      const Lb = boundary();
      for (let i = S.strokes.length - 1; i >= 0; i--) {
        if (S.strokes[i].some((q) => q.t >= Lb - 1e-9)) {
          S.strokes[i] = S.strokes[i].filter((q) => q.t < Lb - 1e-9);
          if (!S.strokes[i].length) S.strokes.splice(i, 1);
          liveCommit('Undo removed the last future stroke');
          return;
        }
      }
      return;
    }
    S.strokes.pop();
    edited();
  };
  $('clear').onclick = () => {
    if (S.phase === 'RUN' && S.sim) {
      S.strokes = cutRange(S.strokes, boundary(), S.cfg.horizonSec + 1);
      $('patternNote').hidden = true;
      liveCommit('Cleared the future');
      return;
    }
    S.strokes = [];
    S.overrides = NO_OVERRIDES();
    $('patternNote').hidden = true;
    edited();
  };

  function example(kind: string): Stroke[] {
    const P = PATTERNS[kind];
    if (!P) return [];
    const H = S.cfg.horizonSec;
    const R = S.cfg.refPrice;
    const note = $('patternNote');
    note.hidden = false;
    note.innerHTML = `<b>${esc(P.name)}.</b> ${esc(P.trader)} <b>How Trace reads it:</b> ${esc(P.how)}`;
    return P.pts().map((pts) =>
      pts.map(([u, m]) => ({ t: u * H, p: R * (1 + m * PATTERN_SCALE) })),
    );
  }
  $<HTMLSelectElement>('examples').onchange = (e) => {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    sel.value = '';
    if (!v) return;
    if (S.phase === 'RUN' && S.sim) {
      const Lb = boundary();
      const H = S.cfg.horizonSec;
      const pNow = feed.tape.at(S.sim.tNow) || S.cfg.refPrice;
      const ref = S.cfg.refPrice;
      const scale = (H - Lb) / H;
      const shifted = example(v).map((st) =>
        st.map((q) => ({ t: Lb + q.t * scale, p: (q.p / ref) * pNow })),
      );
      S.strokes = cutRange(S.strokes, Lb, H + 1).concat(shifted);
      liveCommit(`Loaded the ${v} pattern from the boundary`);
      return;
    }
    S.strokes = example(v);
    S.overrides = NO_OVERRIDES();
    edited();
  };

  $('vtIn').onclick = () => zoomTime(1 / 1.5);
  $('vtOut').onclick = () => zoomTime(1.5);
  $('vpIn').onclick = () => zoomPrice(1 / 1.5);
  $('vpOut').onclick = () => zoomPrice(1.5);
  $('vLeft').onclick = () => {
    unfollow();
    panTime(-1);
  };
  $('vRight').onclick = () => {
    unfollow();
    panTime(1);
  };
  $('vUp').onclick = () => panPrice(1);
  $('vDown').onclick = () => panPrice(-1);
  function unfollow() {
    S.follow = false;
    $('vFollow').setAttribute('aria-pressed', 'false');
  }
  $('vFit').onclick = () => {
    unfollow();
    fitView();
  };
  $('vReset').onclick = () => {
    unfollow();
    resetView();
  };
  $('vFollow').onclick = () => {
    S.follow = !S.follow;
    $('vFollow').setAttribute('aria-pressed', String(S.follow));
    if (S.follow) {
      followNow();
      updateViewLabel();
      draw();
    }
  };
  $('vFull').onclick = enterFs;
  $('fsExit').onclick = exitFs;
  C.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const q = pt(e as unknown as PointerEvent);
      const f = e.deltaY > 0 ? 1.25 : 1 / 1.25;
      if (e.shiftKey) zoomPrice(f, (pOfY(q.y) / S.cfg.refPrice - 1) * 100);
      else zoomTime(f, tOfX(q.x));
    },
    { passive: false, signal: ac.signal },
  );

  $('modeLive').onclick = () => setMode('live');
  $('modePlanFirst').onclick = () => setMode('plan');
  $('liveStart').onclick = () => {
    if (S.phase === 'DONE' || S.resultsShown) newSession();
    else startLive();
  };
  $('liveStop').onclick = stopLive;
  $('restartNow').onclick = () => newSession();

  // Real time only: "Live" re-attaches the view to now after reviewing the past.
  $('play').onclick = () => {
    if (!S.sim) return;
    S.reviewing = false;
    S.playT = S.nowT;
    tick();
  };
  $<HTMLInputElement>('scrub').addEventListener(
    'input',
    (e) => {
      if (!S.sim) return;
      const v = parseFloat((e.target as HTMLInputElement).value);
      S.playT = clamp(v, 0, S.nowT);
      S.reviewing = S.playT < S.nowT - 0.5;
      tick();
    },
    sig,
  );
  root
    .querySelectorAll<HTMLButtonElement>('.tabs [role=tab]')
    .forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));
  $('flattenBtn').onclick = () => {
    if (!S.sim || S.sim.ended) return;
    S.strokes = cutRange(S.strokes, boundary(), S.cfg.horizonSec + 1);
    S.live = null;
    liveCommit('Went flat from the boundary');
  };
  $<HTMLInputElement>('armed').onchange = () => {
    if (S.sim && S.phase === 'RUN' && $<HTMLInputElement>('armed').checked) {
      S.sim.replan(S.plan!, S.cfg.lockSec, drawingEnd(S.strokes), true);
      renderQueue();
      renderLedger();
      draw();
    }
    renderReview();
  };

  const onResize = () => resize();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') exitFs();
  };
  const onFsChange = () => {
    if (!root.ownerDocument.fullscreenElement) exitFs();
  };
  window.addEventListener('resize', onResize, sig);
  root.ownerDocument.addEventListener('keydown', onKeyDown, sig);
  root.ownerDocument.addEventListener('fullscreenchange', onFsChange, sig);

  // ---------- exports ----------
  function download(blob: Blob, name: string) {
    const a = root.ownerDocument.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    root.ownerDocument.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  function exportJSON() {
    const rr = S.sim ? S.res || S.sim.result() : null;
    const data = {
      exportedAt: new Date().toISOString(),
      spec: 'Trace v4.2 concept prototype, live perpetual feed',
      config: S.cfg,
      feed: { source: feed.snapshot.source, status: feed.snapshot.status, t0Ms: feed.tape.t0Ms },
      strokes: S.strokes,
      overrides: S.overrides,
      plan: {
        legs: S.plan!.legs,
        flatIntervals: S.plan!.flatIntervals,
        warnings: S.plan!.warnings,
        sizing: S.plan!.sizing,
      },
      market: { candles: feed.tape.candles },
      run: rr
        ? {
            net: rr.net,
            fees: rr.fees,
            funding: rr.funding,
            endReason: rr.endReason,
            endT: rr.endT,
            replans: rr.replans,
            fills: rr.fills,
            log: rr.log,
            equity: rr.series.filter((_, i) => i % 4 === 0).map((s) => [s.t, s.eq]),
          }
        : null,
    };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `trace-run-${stamp()}.json`);
  }
  function drawInto(target: HTMLCanvasElement, w: number, h: number) {
    const saved = {
      ctx,
      W,
      HH,
      DPR,
      l: PAD.l,
      r: PAD.r,
      t: PAD.t,
      b: PAD.b,
      view: { ...S.view },
      yRange: S.yRange,
    };
    exporting = true;
    ctx = target.getContext('2d')!;
    W = w;
    HH = h;
    DPR = 1;
    PAD.l = 112;
    PAD.r = 168;
    PAD.t = 22;
    PAD.b = 32;
    S.view = { t0: 0, t1: S.cfg.horizonSec, pc: 0 };
    try {
      draw();
    } finally {
      ctx = saved.ctx;
      W = saved.W;
      HH = saved.HH;
      DPR = saved.DPR;
      PAD.l = saved.l;
      PAD.r = saved.r;
      PAD.t = saved.t;
      PAD.b = saved.b;
      S.view = saved.view;
      S.yRange = saved.yRange;
      exporting = false;
    }
  }
  const chartBuf = root.ownerDocument.createElement('canvas');
  function composeFrame(target: HTMLCanvasElement, w: number, h: number) {
    const top = Math.round(h * 0.085);
    const bottom = Math.round(h * 0.2);
    const chartH = h - top - bottom;
    chartBuf.width = w;
    chartBuf.height = chartH;
    drawInto(chartBuf, w, chartH);
    const g = target.getContext('2d')!;
    const c = S.cfg;
    const s = cur();
    const pnl = s.eq - c.margin;
    const r = S.sim;
    const endT = r ? simEndT() : c.horizonSec;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(chartBuf, 0, top);
    const f = Math.round(h / 45);
    g.fillStyle = '#1B2431';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = font(`600 ${f * 1.15}px`);
    g.fillText('Trace — draw a trade', f, top / 2);
    const tw = g.measureText('Trace — draw a trade').width;
    g.font = font(`${f * 0.85}px`);
    g.fillStyle = '#5E6774';
    g.fillText(
      `${c.mode === 'path' ? 'Follow my path' : 'Single trade'}, ${fmtUSD0(c.margin)} margin at ${c.leverage}×, ${S.plan!.legs.length} leg${S.plan!.legs.length === 1 ? '' : 's'}, ${fmtT(S.playT)} of ${fmtT(c.horizonSec)}, live ${feed.symbol}`,
      f * 1.6 + tw,
      top / 2,
    );
    const y0 = top + chartH;
    const pad = f;
    const sparkW = Math.round(w * 0.42);
    const sparkX = pad;
    const sparkY = y0 + pad * 1.6;
    const sparkH = bottom - pad * 2.6;
    g.fillStyle = '#5E6774';
    g.font = font(`${f * 0.8}px`);
    g.fillText('Equity over time', sparkX, y0 + pad * 0.9);
    g.strokeStyle = '#E3E7EC';
    g.lineWidth = 1;
    g.strokeRect(sparkX, sparkY, sparkW, sparkH);
    if (r && r.series.length) {
      const ser = r.series;
      const n = clamp(Math.floor((S.playT / c.horizonSec) * r.N), 0, Math.max(0, ser.length - 1));
      let lo = c.margin;
      let hi = c.margin;
      for (const q of ser) {
        lo = Math.min(lo, q.eq);
        hi = Math.max(hi, q.eq);
      }
      const span = Math.max(hi - lo, c.margin * 0.1);
      lo -= span * 0.08;
      hi += span * 0.08;
      const yE = (e: number) => sparkY + sparkH - ((e - lo) / (hi - lo)) * sparkH;
      const xT = (t: number) => sparkX + (t / c.horizonSec) * sparkW;
      g.strokeStyle = '#B7BFC8';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(sparkX, yE(c.margin));
      g.lineTo(sparkX + sparkW, yE(c.margin));
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.moveTo(xT(0), yE(c.margin));
      for (let i = 0; i <= n; i++) g.lineTo(xT(ser[i].t), yE(ser[i].eq));
      g.strokeStyle = pnl >= 0 ? '#1F8A5B' : '#C6412C';
      g.lineWidth = 2.5;
      g.lineJoin = 'round';
      g.stroke();
      g.fillStyle = pnl >= 0 ? '#1F8A5B' : '#C6412C';
      g.beginPath();
      g.arc(xT(ser[n].t), yE(ser[n].eq), 4, 0, Math.PI * 2);
      g.fill();
    }
    const cols: [string, string][] = [
      ['Price', fmtPrice(s.p)],
      ['Position', s.pos ? `${s.pos.d > 0 ? 'long' : 'short'} ${s.pos.Q.toFixed(5)}` : 'flat'],
      ['Equity', fmtUSD(s.eq)],
      ['Net P&L', fmtUSD(pnl, true)],
      ['Effective leverage', s.pos ? `${s.lev.toFixed(2)}×` : '—'],
      ['Equity ink', `${Math.round(s.ink * 100)}%`],
    ];
    const cx0 = sparkX + sparkW + pad * 1.5;
    const cw = (w - cx0 - pad) / 3;
    cols.forEach(([k, v], i) => {
      const x = cx0 + (i % 3) * cw;
      const y = y0 + pad * 0.9 + Math.floor(i / 3) * (bottom / 2 - pad * 0.4);
      g.fillStyle = '#5E6774';
      g.font = font(`${f * 0.8}px`);
      g.fillText(k, x, y);
      g.fillStyle =
        k === 'Net P&L' ? (pnl > 0 ? '#1F8A5B' : pnl < 0 ? '#C6412C' : '#1B2431') : '#1B2431';
      g.font = font(`600 ${f * 1.15}px`);
      g.fillText(v, x, y + f * 1.25);
    });
    const ibX = cx0 + 2 * cw;
    const ibY = y0 + pad * 0.9 + (bottom / 2 - pad * 0.4) + f * 2.1;
    g.fillStyle = 'rgba(46,79,216,.22)';
    g.fillRect(ibX, ibY, cw - pad, f * 0.5);
    g.fillStyle = '#2E4FD8';
    g.fillRect(ibX, ibY, (cw - pad) * s.ink, f * 0.5);
    if (r && r.ended && S.playT >= endT - 1e-6) {
      g.fillStyle = '#1B2431';
      g.font = font(`600 ${f * 0.9}px`);
      g.textAlign = 'right';
      g.fillText(`Plan ended: ${labelReason(r.endReason)} at ${fmtT(endT)}`, w - pad, top / 2);
      g.textAlign = 'left';
    }
  }
  function exportPNG() {
    const oc = root.ownerDocument.createElement('canvas');
    oc.width = 1600;
    oc.height = 900;
    const savedT = S.playT;
    S.playT = simEndT();
    composeFrame(oc, 1600, 900);
    S.playT = savedT;
    oc.toBlob((b) => b && download(b, `trace-chart-${stamp()}.png`), 'image/png');
  }
  let recording = false;
  function exportVideo() {
    if (!S.sim || recording) return;
    const st = $('exStatus');
    const prev = $('exPreview');
    if (!('captureStream' in HTMLCanvasElement.prototype) || !window.MediaRecorder) {
      st.textContent =
        'This browser cannot record canvas video. Use Chrome, Edge or Firefox, or save a PNG instead.';
      return;
    }
    const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
      (m) => MediaRecorder.isTypeSupported(m),
    );
    if (!mime) {
      st.textContent = 'No supported video format in this browser. Save a PNG instead.';
      return;
    }
    const w = 1280;
    const h = 720;
    const oc = root.ownerDocument.createElement('canvas');
    oc.width = w;
    oc.height = h;
    prev.innerHTML = '';
    prev.appendChild(oc);
    const stream = oc.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const savedT = S.playT;
    const dur = 12;
    const hold = 1.5;
    const endT = simEndT();
    let t0: number | null = null;
    recording = true;
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      recording = false;
      S.playT = savedT;
      tick();
      st.textContent = `Saved trace-replay-${ext}: ${(blob.size / 1e6).toFixed(1)} MB, ${dur} s. Your download should start now.`;
      download(blob, `trace-replay-${stamp()}.${ext}`);
    };
    st.textContent = 'Recording the replay in real time. Keep this tab visible until it finishes.';
    rec.start(250);
    const frame = (ts: number) => {
      if (t0 == null) t0 = ts;
      const el = (ts - t0) / 1000;
      S.playT = Math.min(endT, (el / dur) * endT);
      composeFrame(oc, w, h);
      if (el < dur + hold) requestAnimationFrame(frame);
      else rec.stop();
    };
    requestAnimationFrame(frame);
  }

  // ---------- market picker ----------
  interface MarketRow {
    symbol: string;
    label: string;
    last: number;
    change24hPct: number;
    turnover24h: number;
    fundingRatePct: number;
    livelinessPct: number;
  }
  let markets: MarketRow[] = [];
  /** Once you pick a market yourself, the boot default stops overriding it. */
  let marketChosen = false;
  /** Once you edit the tolerance yourself, the market no longer sets it. */
  let tolTouched = false;
  let toleranceSet = false;

  /**
   * How big a drawn move has to be before it counts as a leg.
   *
   * Anchored to what the market covers in a few *minutes*, not in a day. A day-scale
   * tolerance is far too coarse for hand-drawn turns: on a perp ranging 13% daily it
   * came out at $3, which quietly absorbed every wiggle of a zigzag and collapsed it
   * into one straight leg. A deliberate turn is a small fraction of recent range;
   * anything below that is pen jitter.
   */
  function applyMarketTolerance() {
    if (tolTouched) return;
    const price = feed.tape.last || S.refPrice;
    const range = feed.tape.recentRange(3);
    if (!price || !(range > 0)) return;
    const tol = clamp((range / price) * 100 * 0.05, 0.001, 1);
    $<HTMLInputElement>('tolPct').value = String(Math.round(tol * 1000) / 1000);
    readCfg();
    renderReview();
    draw();
  }

  function showLiveliness() {
    const m = markets.find((x) => x.symbol === feed.symbol);
    $('marketLively').textContent = m
      ? `${m.livelinessPct.toFixed(2)}% range today · $${Math.round(m.turnover24h / 1e6)}M turnover · funding ${m.fundingRatePct.toFixed(4)}%`
      : '—';
    $('hdrSym').textContent = m ? m.label : feed.symbol;
  }

  async function loadMarkets() {
    try {
      const res = await fetch('/api/markets', { cache: 'no-store', signal: ac.signal });
      const j = (await res.json()) as { markets?: MarketRow[] };
      if (ac.signal.aborted || !j.markets?.length) return;
      markets = j.markets;
      const sel = $<HTMLSelectElement>('marketPick');
      sel.innerHTML = markets
        .map(
          (m) =>
            `<option value="${esc(m.symbol)}">${esc(m.label)} · ${m.change24hPct >= 0 ? '+' : ''}${m.change24hPct.toFixed(1)}% 24h</option>`,
        )
        .join('');
      const top = markets[0].symbol;
      // Open on the liveliest liquid market rather than the boot default: a chart of
      // something that barely moves is not worth drawing on. BTC stays in the list.
      const target = marketChosen ? feed.symbol : top;
      sel.value = markets.some((m) => m.symbol === target) ? target : top;
      showLiveliness();
      if (!marketChosen && target !== feed.symbol && !S.strokes.length && S.phase !== 'DONE')
        newSession(target);
      else applyMarketTolerance();
    } catch {
      // keep the single default option
    }
  }

  $<HTMLSelectElement>('marketPick').addEventListener(
    'change',
    (e) => {
      marketChosen = true;
      newSession((e.target as HTMLSelectElement).value);
    },
    sig,
  );

  // ---------- feed wiring ----------
  function onFeed(s: FeedState) {
    const label = FEED_LABEL[s.status];
    for (const [pill, text] of [
      [$('feedStatus'), $('feedStatusLabel')],
      [$('hdrFeed'), $('hdrFeedLabel')],
    ] as const) {
      pill.className = `feed-pill ${s.status}`;
      text.textContent = label;
    }
    $('feedSource').textContent = s.source
      ? `${VENUES[s.source].label} · ${s.symbol}`
      : s.status === 'demo'
        ? 'synthetic fallback'
        : '—';
    $('feedPrice').textContent = s.price ? fmtPrice(s.price) : '—';
    $('feedTicks').textContent = String(s.ticks);
    if (s.historyLoaded && !toleranceSet && feed.tape.candles.length) {
      toleranceSet = true;
      applyMarketTolerance();
    }
    $('hdrPrice').textContent = s.price
      ? s.price.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : '—';
    const chg = $('hdrChg');
    if (s.change24h == null) chg.textContent = '';
    else {
      chg.textContent = `${s.change24h >= 0 ? '+' : ''}${s.change24h.toFixed(2)}% 24h`;
      chg.className = `chg ${s.change24h >= 0 ? 'pos' : 'neg'}`;
    }
    // The first quote anchors the drawing's price scale for the whole session.
    if (!S.refPrice && s.price) {
      S.refPrice = s.price;
      recompile();
      maybeAutoStart();
    } else if (!S.sim) {
      $('refPriceVal').textContent = S.refPrice
        ? `${fmtPrice(S.refPrice)} at start`
        : `${fmtPrice(s.price)} live`;
    }
  }

  // ---------- boot ----------
  let autoStarted = false;
  /** The live chart starts itself, but only once there is a price to start against. */
  function maybeAutoStart() {
    if (autoStarted || S.mode !== 'live' || S.phase !== 'DRAFT' || !feed.tape.count) return;
    autoStarted = true;
    startLive();
  }

  // A development-only window onto the compiled plan. The spine is the end of a long
  // pipeline (sample → rdp → absorbWobble → collapse → leg budget) and when a drawing
  // does not trade, the only way to find out which stage ate it is to read the stages.
  if (process.env.NODE_ENV === 'development')
    (window as unknown as { __trace: unknown }).__trace = {
      plan: () => S.plan,
      strokes: () => S.strokes,
      cfg: () => S.cfg,
      feed: () => feed,
      state: () => S,
    };

  const teardownPopovers = mountPopovers(root);
  void loadMarkets();
  unsubFeed = feed.onChange(onFeed);
  void feed.start();
  readCfg();
  S.view = { t0: 0, t1: S.cfg.horizonSec, pc: 0 };
  recompile();
  resize();
  setPhase('DRAFT');
  updateViewLabel();
  $('planSteps').hidden = true;
  $('liveStart').hidden = false;
  raf = requestAnimationFrame(loop);
  // The feed normally starts the clock as soon as the first price lands; this is only a
  // backstop for the case where every source is unreachable.
  const bootTimer = setTimeout(maybeAutoStart, 12000);
  const teardownCoach = mountCoachMarks(() => showTab('guide'), base);

  return () => {
    clearTimeout(bootTimer);
    cancelAnimationFrame(raf);
    ac.abort();
    teardownPopovers();
    teardownCoach();
    unsubFeed();
    feed.stop();
  };
}
