/**
 * Info popovers: one annotated mini-chart per configurator item. A direct port of the
 * prototype's third script — the SVG mini-chart DSL and every entry — with the
 * synthetic-market entries reworded for the live feed and the four generator controls
 * (scenario, move, noise, seed) dropped along with the controls themselves.
 */

export const C = {
  ink: '#1B2431',
  muted: '#5E6774',
  grid: '#E3E7EC',
  graphite: '#7F8791',
  blue: '#2E4FD8',
  blueSoft: 'rgba(46,79,216,.35)',
  long: '#1F8A5B',
  short: '#C6412C',
  flat: '#9AA3AE',
  amber: '#9A6200',
  band: 'rgba(46,79,216,.10)',
} as const;

type Pt = [number, number];

interface TextOpts {
  color?: string;
  size?: number;
  bold?: boolean;
  anchor?: 'start' | 'middle' | 'end';
}
interface PathOpts {
  color?: string;
  width?: number;
  dash?: string;
  alpha?: number;
}
interface HLineOpts {
  color?: string;
  dash?: string;
  label?: string;
  left?: boolean;
  below?: boolean;
}
interface BandOpts {
  color?: string;
  solid?: string;
  alpha?: number;
  label?: string;
  textColor?: string;
}
interface DotOpts {
  color?: string;
  shape?: 'up' | 'down' | 'x';
  label?: string;
  dx?: number;
  dy?: number;
}
interface ArrowOpts {
  color?: string;
  label?: string;
  lx?: number;
  ly?: number;
  anchor?: 'start' | 'middle' | 'end';
}
interface VLineOpts {
  color?: string;
  dash?: string;
  label?: string;
}
interface BarOpts {
  color?: string;
  alpha?: number;
  label?: string;
}

export interface ChartApi {
  grid(): ChartApi;
  path(pts: Pt[], o?: PathOpts): ChartApi;
  hline(v: number, o?: HLineOpts): ChartApi;
  band(u0: number, u1: number, o?: BandOpts): ChartApi;
  dot(u: number, v: number, o?: DotOpts): ChartApi;
  arrow(u0: number, v0: number, u1: number, v1: number, o?: ArrowOpts): ChartApi;
  dbl(u0: number, u1: number, v: number, o?: ArrowOpts & { label?: string }): ChartApi;
  vline(u: number, o?: VLineOpts): ChartApi;
  text(u: number, v: number, s: string, o?: TextOpts): ChartApi;
  bar(u0: number, u1: number, v0: number, v1: number, o?: BarOpts): ChartApi;
}

/** mini-chart DSL: u (time) and v (price level) in [0,1]; v = .5 is the reference price */
export function chart(build: (api: ChartApi) => void) {
  const W = 320;
  const H = 168;
  const x0 = 14;
  const x1 = 306;
  const y0 = 14;
  const y1 = 150;
  const X = (u: number) => x0 + u * (x1 - x0);
  const Y = (v: number) => y1 - v * (y1 - y0);
  const out: string[] = [];
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = (x: number, y: number, s: string, o: TextOpts = {}) =>
    out.push(
      `<text x="${x}" y="${y}" fill="${o.color || C.muted}" font-size="${o.size || 11.5}" font-weight="${o.bold ? 600 : 400}" text-anchor="${o.anchor || 'start'}" font-family="IBM Plex Sans, system-ui, sans-serif">${esc(s)}</text>`,
    );
  const api: ChartApi = {
    grid() {
      for (let v = 0; v <= 1; v += 0.25)
        out.push(
          `<line x1="${x0}" y1="${Y(v)}" x2="${x1}" y2="${Y(v)}" stroke="${v === 0.5 ? '#B7BFC8' : C.grid}" stroke-width="1"/>`,
        );
      out.push(`<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="#B7BFC8"/>`);
      text(x0 + 2, Y(0.5) - 3, 'now', { size: 9 });
      return api;
    },
    path(pts, o = {}) {
      out.push(
        `<polyline points="${pts.map(([u, v]) => `${X(u)},${Y(v)}`).join(' ')}" fill="none" stroke="${o.color || C.blue}" stroke-width="${o.width || 3}" stroke-linecap="round" stroke-linejoin="round" ${o.dash ? `stroke-dasharray="${o.dash}"` : ''} ${o.alpha ? `opacity="${o.alpha}"` : ''}/>`,
      );
      return api;
    },
    hline(v, o = {}) {
      out.push(
        `<line x1="${x0}" y1="${Y(v)}" x2="${x1}" y2="${Y(v)}" stroke="${o.color || C.ink}" stroke-width="1.5" stroke-dasharray="${o.dash || '6 4'}"/>`,
      );
      if (o.label)
        text(o.left ? x0 + 3 : x1 - 2, Y(v) + (o.below ? 13 : -4), o.label, {
          color: o.color,
          anchor: o.left ? 'start' : 'end',
          bold: true,
        });
      return api;
    },
    band(u0, u1, o = {}) {
      const id = 'h' + Math.random().toString(36).slice(2, 7);
      out.push(
        `<defs><pattern id="${id}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${o.color || C.flat}" stroke-width="1"/></pattern></defs><rect x="${X(u0)}" y="${y0}" width="${X(u1) - X(u0)}" height="${y1 - y0}" fill="${o.solid || `url(#${id})`}" opacity="${o.alpha || 0.6}"/>`,
      );
      if (o.label)
        text((X(u0) + X(u1)) / 2, y0 + 11, o.label, {
          anchor: 'middle',
          color: o.textColor || C.muted,
        });
      return api;
    },
    dot(u, v, o = {}) {
      const x = X(u);
      const y = Y(v);
      const c = o.color || C.ink;
      if (o.shape === 'up')
        out.push(`<polygon points="${x},${y - 7} ${x - 6},${y + 4} ${x + 6},${y + 4}" fill="${c}"/>`);
      else if (o.shape === 'down')
        out.push(`<polygon points="${x},${y + 7} ${x - 6},${y - 4} ${x + 6},${y - 4}" fill="${c}"/>`);
      else if (o.shape === 'x')
        out.push(
          `<line x1="${x - 5}" y1="${y - 5}" x2="${x + 5}" y2="${y + 5}" stroke="${c}" stroke-width="2.5"/><line x1="${x - 5}" y1="${y + 5}" x2="${x + 5}" y2="${y - 5}" stroke="${c}" stroke-width="2.5"/>`,
        );
      else out.push(`<circle cx="${x}" cy="${y}" r="4.5" fill="${c}"/>`);
      if (o.label) text(x + (o.dx ?? 8), y + (o.dy ?? 4), o.label, { color: c, bold: true });
      return api;
    },
    arrow(u0, v0, u1, v1, o = {}) {
      const ax = X(u0);
      const ay = Y(v0);
      const bx = X(u1);
      const by = Y(v1);
      const c = o.color || C.short;
      const ang = Math.atan2(by - ay, bx - ax);
      const hx = bx - 9 * Math.cos(ang);
      const hy = by - 9 * Math.sin(ang);
      out.push(
        `<line x1="${ax}" y1="${ay}" x2="${hx}" y2="${hy}" stroke="${c}" stroke-width="2"/><polygon points="${bx},${by} ${hx - 5 * Math.sin(ang)},${hy + 5 * Math.cos(ang)} ${hx + 5 * Math.sin(ang)},${hy - 5 * Math.cos(ang)}" fill="${c}"/>`,
      );
      if (o.label)
        text(
          o.lx != null ? X(o.lx) : (ax + bx) / 2 + 6,
          o.ly != null ? Y(o.ly) : (ay + by) / 2,
          o.label,
          { color: c, bold: true, anchor: o.anchor },
        );
      return api;
    },
    dbl(u0, u1, v, o = {}) {
      api.arrow(u0 + 0.02, v, u1, v, o);
      api.arrow(u1 - 0.02, v, u0, v, o);
      if (o.label)
        text((X(u0) + X(u1)) / 2, Y(v) - 6, o.label, {
          color: o.color || C.short,
          bold: true,
          anchor: 'middle',
        });
      return api;
    },
    vline(u, o = {}) {
      out.push(
        `<line x1="${X(u)}" y1="${y0}" x2="${X(u)}" y2="${y1}" stroke="${o.color || C.muted}" stroke-width="1" stroke-dasharray="${o.dash || '3 3'}"/>`,
      );
      if (o.label) text(X(u), y0 + 10, o.label, { anchor: 'middle', color: o.color || C.muted });
      return api;
    },
    text(u, v, s, o = {}) {
      text(X(u), Y(v), s, o);
      return api;
    },
    bar(u0, u1, v0, v1, o = {}) {
      out.push(
        `<rect x="${X(u0)}" y="${Y(v1)}" width="${X(u1) - X(u0)}" height="${Y(v0) - Y(v1)}" fill="${o.color || C.blue}" opacity="${o.alpha || 1}" rx="3"/>`,
      );
      if (o.label) text(X(u1) + 6, (Y(v0) + Y(v1)) / 2 + 4, o.label, { color: C.ink, bold: true });
      return api;
    },
  };
  build(api);
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${out.join('')}</svg>`;
}

const zig: Pt[] = [
  [0, 0.5], [0.08, 0.42], [0.16, 0.6], [0.24, 0.38], [0.33, 0.68], [0.42, 0.3],
  [0.5, 0.62], [0.58, 0.45], [0.66, 0.58], [0.75, 0.35], [0.83, 0.7], [0.92, 0.52], [1, 0.6],
];
const wobble = (a: Pt, b: Pt, n = 24, amp = 0.03, f = 40): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + amp * Math.sin(u * f)];
  });
const legLong = (ch: ChartApi) =>
  ch
    .grid()
    .dot(0.1, 0.5, { color: C.long, shape: 'up' })
    .path([[0.1, 0.5], [0.3, 0.58], [0.45, 0.55], [0.6, 0.8]]);

export interface InfoEntry {
  title: string;
  text: string;
  svg: () => string;
}

export const INFO: Record<string, InfoEntry> = {
  secCanvas: {
    title: 'Canvas and interpretation',
    text: 'How your strokes are turned into orders: 64 time columns, gaps, simplification and the leg budget. Nothing here changes money directly; it changes which legs the plan contains.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(zig, { color: C.graphite, width: 1.5 })
          .path([[0, 0.5], [0.33, 0.68], [0.42, 0.3], [0.83, 0.7], [1, 0.6]])
          .dot(0, 0.5, { color: C.long, shape: 'up', label: 'long' })
          .dot(0.33, 0.68, { color: C.short, shape: 'down', label: 'short' })
          .dot(0.42, 0.3, { color: C.long, shape: 'up', label: 'long' })
          .dot(0.83, 0.7, { color: C.short, shape: 'down', label: 'short' }),
      ),
  },
  secPlan: {
    title: 'Plan controls',
    text: 'How much you risk and when the plan ends: margin, leverage, a whole-plan loss limit and an optional take profit. These set the stop and target orders for each leg.',
    svg: () =>
      chart((ch) =>
        legLong(ch)
          .hline(0.8, { color: C.long, label: 'take profit ends the plan' })
          .hline(0.25, { color: C.short, label: 'loss limit ends the plan', below: true }),
      ),
  },
  secCosts: {
    title: 'Venue costs',
    text: "What the exchange charges: a fee on every fill, funding every hour a position is open, and the maintenance margin that decides where liquidation sits. All are estimates from the venue's public schedule.",
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0.1, 0.5], [0.6, 0.68]])
          .dot(0.1, 0.5, { color: C.long, label: 'buy  fee $0.135' })
          .dot(0.6, 0.68, { color: C.short, label: 'sell  fee $0.135', dx: -96, dy: -8 })
          .vline(0.35, { label: 'funding' }),
      ),
  },
  secMarket: {
    title: 'Live market',
    text: 'The real BTC/USD price. One-minute candles give the history and a live trade stream drives the chart from there. Nothing is generated, so nothing is repeatable: the same drawing run twice meets two different markets. History and the live socket always come from the same venue, because BTC-USD and BTCUSDT differ by a few dollars.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(wobble([0, 0.5], [0.5, 0.44], 24, 0.05, 60), { color: C.ink, width: 1.6 })
          .vline(0.5, { label: 'now' })
          .band(0.5, 1, { solid: '#000', alpha: 0.03, label: 'not yet known' })
          .text(0.03, 0.9, 'real candles, then live trades', { color: C.ink, bold: true }),
      ),
  },
  horizonN: {
    title: 'Horizon',
    text: "The time span of the canvas. Every leg is scheduled inside it and the drawing's end is the time exit. Changing the horizon stretches your plan in time; it never changes quantities or leverage.",
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.5], [0.3, 0.38], [0.6, 0.72], [1, 0.62]])
          .dbl(0, 1, 0.12, { label: 'plan duration', color: C.ink })
          .vline(1, { label: 'time exit' }),
      ),
  },
  columns: {
    title: 'Time columns',
    text: 'How finely time is sampled when reading the drawing: the canvas is cut into this many columns and each column becomes one point of the sampled path. More columns keep narrower features but make gap_min (measured in columns) shorter in seconds; fewer columns smooth the drawing.',
    svg: () =>
      chart((ch) => {
        ch.grid();
        for (let i = 0; i <= 8; i++) ch.vline(i / 8, { color: '#DCE1E7', dash: '2 2' });
        ch.path(wobble([0, 0.45], [1, 0.7], 40, 0.04, 50), { color: C.graphite, width: 1.5 });
        ch.path(
          Array.from({ length: 9 }, (_, i): Pt => {
            const u = i / 8;
            return [u, 0.45 + 0.25 * u + 0.04 * Math.sin(u * 50)];
          }),
        );
        ch.text(0.03, 0.92, 'one sampled point per column', { color: C.blue, bold: true });
      }),
  },
  lockSec: {
    title: 'Adjusting a running plan',
    text: 'While the plan runs, the future turning points of your plan are handles: drag one to move a turn in time or price. The green take-profit and red stop lines can be dragged while a position is open. Erase cuts the plan where you click, which closes the position there. Sketch draws a new shape that replaces the plan from where you start. Untouched, the plan simply runs. Everything before the boundary (now plus the lock window) is already sent and cannot change.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0, 0.45, { solid: '#1B2431', alpha: 0.05, label: 'executed' })
          .band(0.45, 0.55, { solid: '#9A6200', alpha: 0.18, label: 'locked', textColor: C.amber })
          .path([[0, 0.5], [0.45, 0.62]], { color: C.ink, width: 2 })
          .path([[0.45, 0.62], [0.55, 0.64]])
          .path([[0.55, 0.64], [0.8, 0.8], [1, 0.7]], { dash: '6 4' })
          .text(0.58, 0.3, 'editable: redraw or erase', { color: C.blue, bold: true })
          .vline(0.55, { color: C.amber, dash: '1 0' }),
      ),
  },
  entryRule: {
    title: 'Entry rule for each leg',
    text: "How a leg gets in. Scheduled: buy or sell at market when its time comes. Pullback limit: rest a limit at the drawn price and fill only if price comes back to it. Breakout stop: rest a stop at the drawn price and fill only if price breaks through it in the leg's direction. Resting entries that are not touched by the leg's end time expire and the leg is skipped.",
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.62, { color: C.blue, label: 'drawn entry level', left: true })
          .path([[0.05, 0.4], [0.3, 0.55], [0.45, 0.5], [0.6, 0.62], [0.8, 0.8]], {
            color: C.ink,
            width: 2,
          })
          .dot(0.6, 0.62, { color: C.long, shape: 'up', label: 'breakout stop fills here' })
          .dot(0.3, 0.55, { color: C.muted, label: 'scheduled: fills at its time', dy: 16, dx: -30 }),
      ),
  },
  fundingInterval: {
    title: 'Settlement interval',
    text: 'How often funding settles once the first settlement has passed. Hyperliquid settles hourly; other venues use 8 hours. Only settlements inside the horizon while a position is open cost anything.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .vline(0.2, { label: 'funding' })
          .vline(0.6, { label: 'funding' })
          .dbl(0.2, 0.6, 0.3, { color: C.ink, label: 'interval' })
          .path([[0, 0.5], [1, 0.6]], { color: C.long, width: 3 }),
      ),
  },
  swings: {
    title: 'Swing and slope labels',
    text: 'Trader vocabulary drawn on your legs. Each turn is named by its relation to the previous swing of the same kind: HH higher high, LH lower high, HL higher low, LL lower low (SH/SL for the first). Each leg shows its slope in percent per minute with a word: shallow, moderate, steep, parabolic.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.45], [0.2, 0.65], [0.35, 0.55], [0.55, 0.8], [0.7, 0.68], [0.9, 0.9]])
          .dot(0.2, 0.65, { color: C.short, shape: 'down', label: 'SH', dy: -10, dx: -8 })
          .dot(0.35, 0.55, { color: C.long, shape: 'up', label: 'HL', dy: 18, dx: -8 })
          .dot(0.55, 0.8, { color: C.short, shape: 'down', label: 'HH', dy: -10, dx: -8 })
          .dot(0.7, 0.68, { color: C.long, shape: 'up', label: 'HL', dy: 18, dx: -8 })
          .text(0.05, 0.2, 'higher highs and higher lows: uptrend structure', {
            color: C.ink,
            bold: true,
          }),
      ),
  },
  penSmooth: {
    title: 'Pen smoothing',
    text: 'How much the pen filters hand jitter. Each new point moves only part of the way toward the pointer, so the stroke is a clean curve instead of a saw-tooth. Higher values feel more like a marker; 0 is raw pointer input. Sampling and simplification see the smoothed line.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(wobble([0, 0.45], [1, 0.7], 40, 0.035, 60), { color: C.graphite, width: 1.5 })
          .path([[0, 0.45], [1, 0.7]], { color: C.blue })
          .text(0.04, 0.9, 'grey: raw pointer, blue: smoothed', { color: C.ink, bold: true }),
      ),
  },
  pen: {
    title: 'Forward-only pen',
    text: 'While the pen is down, time only moves forward. When your hand moves up, down or slightly left, the tip of the stroke follows your pointer instead of the line running backwards, so you can steepen or correct the current point freely. Turn it off to draw loops and backward strokes as art.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.4], [0.3, 0.6], [0.28, 0.3], [0.32, 0.75], [0.6, 0.55], [1, 0.7]], {
            color: C.graphite,
            width: 1.5,
          })
          .path([[0, 0.4], [0.3, 0.6], [0.6, 0.55], [1, 0.7]], { color: C.blue })
          .text(0.04, 0.9, 'grey: backward drift becomes spikes', { color: C.graphite, bold: true })
          .text(0.04, 0.82, 'blue: forward-only keeps one price per moment', {
            color: C.blue,
            bold: true,
          }),
      ),
  },
  pauseDraw: {
    title: 'Pause the clock while redrawing live',
    text: 'Off by default: the market keeps moving while you draw, and the lock boundary slides forward under your pen, so the start of a slow stroke can fall into the frozen past. That is what redrawing against a live market feels like. Turn this on to stop the clock while the pen is down and resume on release — the feed keeps recording either way, so nothing is missed.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0.4, 0.48, { solid: '#9A6200', alpha: 0.18, label: 'lock' })
          .vline(0.4, { label: 'now (paused)' })
          .path([[0, 0.5], [0.4, 0.62]], { color: C.ink, width: 2 })
          .path([[0.48, 0.62], [0.75, 0.45], [1, 0.7]], { color: C.blue })
          .text(0.5, 0.9, 'your redraw, applied from the boundary', { color: C.blue, bold: true }),
      ),
  },
  chartMode: {
    title: 'Live chart or plan first',
    text: 'Live chart: the clock runs from the first second against the real feed, and anything you draw beyond the lock boundary is sent as an order while Armed is ticked. Plan first: draw the whole plan on a still canvas, review it, then start the run and watch it execute. Same simulator, same rules; only the order of events differs.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0, 0.35, { solid: '#000', alpha: 0.05, label: 'executed' })
          .vline(0.35, { label: 'now' })
          .band(0.35, 0.42, { solid: '#9A6200', alpha: 0.18 })
          .path(wobble([0, 0.5], [0.35, 0.58], 20, 0.03, 40), { color: C.ink, width: 2 })
          .path([[0.42, 0.58], [0.7, 0.8], [1, 0.7]])
          .text(0.45, 0.92, 'your order, drawn ahead of now', { color: C.blue, bold: true }),
      ),
  },
  refPrice: {
    title: 'Reference price',
    text: 'The live BTC quote at the moment the chart started. Art that touches "now" is pinned here, drawn prices are read relative to it, and the simplify tolerance is a percentage of it. It is taken from the feed rather than typed, and entries always fill at a fresh quote, never at the drawn price.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(wobble([0, 0.5], [1, 0.7], 30, 0.02, 30), { color: C.graphite, width: 1.5 })
          .dot(0, 0.5, { color: C.blue, label: 'now: the live quote' })
          .hline(0.5, { color: C.muted, dash: '2 3' }),
      ),
  },
  gapMin: {
    title: 'Minimum gap',
    text: 'A pen lift shorter than this many columns is bridged (dashed) and ignored. A longer gap means no position: the plan closes at the gap start, waits, and re-enters at the next stroke. Each real gap costs one extra round trip.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0.55, 0.78, { label: 'flat: position closed' })
          .path([[0, 0.5], [0.3, 0.66]])
          .path([[0.3, 0.66], [0.36, 0.64]], { dash: '4 4', width: 2 })
          .path([[0.36, 0.64], [0.55, 0.55]])
          .path([[0.78, 0.45], [1, 0.7]])
          .arrow(0.2, 0.88, 0.32, 0.7, { label: 'short lift: bridged', lx: 0.02, ly: 0.93, color: C.blue })
          .dot(0.55, 0.55, { color: C.short, shape: 'x' })
          .dot(0.78, 0.45, { color: C.long, shape: 'up' }),
      ),
  },
  tolPct: {
    title: 'Simplify tolerance',
    text: 'Moves smaller than this are wobble and are absorbed into the leg around them. A turn larger than this becomes its own leg. It is also the flat threshold: a segment whose net move sits inside it holds no position. On live BTC this has to be small — a few hundredths of a percent — because the real market only travels a few tenths of a percent in half an hour. Set it too high and the whole drawing reads as flat; the dollar value under the field is what it currently means.',
    svg: () =>
      chart((ch) => {
        ch.grid();
        ch.path(wobble([0, 0.45], [0.55, 0.68], 30, 0.025, 45), { color: C.graphite, width: 1.5 });
        ch.path([[0, 0.45], [0.55, 0.68]], { color: C.band, width: 16 });
        ch.path([[0, 0.45], [0.55, 0.68]]);
        ch.path([[0.55, 0.68], [0.75, 0.3], [1, 0.55]], { color: C.graphite, width: 1.5 });
        ch.path([[0.55, 0.68], [0.75, 0.3], [1, 0.55]]);
        ch.text(0.05, 0.8, 'wobble inside the band: absorbed', { color: C.blue, bold: true });
        ch.arrow(0.9, 0.18, 0.76, 0.28, { label: 'bigger than tolerance: a leg', lx: 0.42, ly: 0.1 });
      }),
  },
  legBudget: {
    title: 'Leg budget',
    text: 'Caps how many legs a plan may contain. If your drawing has more turns, the smallest swings are dropped and only the largest trade. Set 0 for no cap. Each leg is a round trip, so more legs means more fees and more timing risk.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(zig, { color: C.blueSoft, width: 1.5 })
          .path([[0, 0.5], [0.42, 0.3], [0.83, 0.7], [1, 0.6]])
          .text(0.04, 0.9, 'thin: what you drew', { color: C.muted })
          .text(0.04, 0.82, 'bold: the largest swings that trade', { color: C.blue, bold: true }),
      ),
  },
  yRange: {
    title: 'Price axis range',
    text: 'Zoom of the price axis, as a percentage either side of the reference price. Display only: legs, stops and targets are stored in price and time, so zooming never changes an order. Real BTC covers a few tenths of a percent in half an hour, so a small range here is what makes the price action legible.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.5], [0.4, 0.62], [0.7, 0.42], [1, 0.66]])
          .dbl(0.03, 0.03, 0.5, { color: C.ink })
          .text(0.06, 0.95, '±0.2%  …  ±5%: same orders', { color: C.ink, bold: true }),
      ),
  },
  margin: {
    title: 'Allocated margin',
    text: 'Collateral set aside for this plan, isolated from the rest of the account. Losses and fees come out of it; the equity ink shows equity ÷ margin. Notional per leg is leverage × margin.',
    svg: () =>
      chart((ch) =>
        ch
          .bar(0.05, 0.95, 0.62, 0.78, { color: C.blueSoft })
          .bar(0.05, 0.68, 0.62, 0.78, { label: '' })
          .text(0.05, 0.85, '$100 margin', { color: C.ink, bold: true })
          .text(0.05, 0.5, 'equity $70 after a −10% move at 3×: 70% ink left', {
            color: C.blue,
            bold: true,
          })
          .text(0.05, 0.3, 'quantity does not change when equity falls', { color: C.muted }),
      ),
  },
  leverage: {
    title: 'Opening leverage',
    text: 'Multiplies exposure, not accuracy. Same drawing, same +5% move: 1× earns $5, 2× earns $10, 3× earns $15, and loses the same way. Higher leverage puts the liquidation estimate closer to your entry.',
    svg: () =>
      chart((ch) => {
        ch.bar(0.05, 0.25, 0.7, 0.82, { label: '1×  +$5 or −$5' });
        ch.bar(0.05, 0.45, 0.45, 0.57, { label: '2×  +$10 or −$10' });
        ch.bar(0.05, 0.65, 0.2, 0.32, { label: '3×  +$15 or −$15' });
        ch.text(0.05, 0.92, 'P&L for a 5% price move on $100 margin', { color: C.muted });
      }),
  },
  sizing: {
    title: 'Sizing mode',
    text: 'How the amount of each leg is decided. Fixed margin: exposure = leverage × margin, the same for every leg. Risk at stop: you state how much a leg may lose at its stop, and exposure follows (loss ÷ stop distance), with leverage only deciding how much collateral that ties up. Never read from the stroke.',
    svg: () =>
      chart((ch) => {
        ch.text(0.03, 0.93, 'Fixed margin', { color: C.ink, bold: true });
        ch.bar(0.03, 0.3, 0.68, 0.82, { color: C.blueSoft });
        ch.text(0.03, 0.58, '$100 × 3 = $300 exposure', { color: C.blue, bold: true });
        ch.text(0.55, 0.93, 'Risk at stop', { color: C.ink, bold: true });
        ch.bar(0.55, 0.82, 0.68, 0.82, { color: C.blueSoft });
        ch.text(0.55, 0.58, '$10 loss ÷ 5% = $200 exposure', { color: C.blue, bold: true });
        ch.text(0.55, 0.46, 'needs $67 margin at 3×', { color: C.muted });
        ch.text(0.03, 0.2, 'quantity = exposure ÷ live entry price, fixed at entry', {
          color: C.ink,
        });
      }),
  },
  riskPerLeg: {
    title: 'Planned loss per leg',
    text: 'In risk-at-stop mode: the dollar loss you accept if a leg is stopped out at its stop distance. Exposure is derived from it: $10 with a 5% stop means $200 of BTC. It is a plan, not a guarantee: gaps and slow fills can lose more.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.22, { color: C.short, label: 'leg stop, 5% below entry', below: true, left: true })
          .dot(0.1, 0.62, { color: C.long, shape: 'up', label: 'entry' })
          .path([[0.1, 0.62], [0.4, 0.7], [0.65, 0.22]], { color: C.ink, width: 2 })
          .dot(0.65, 0.22, { color: C.short, shape: 'x' })
          .arrow(0.2, 0.6, 0.2, 0.25, { label: '−$10 planned', lx: 0.23, ly: 0.42 }),
      ),
  },
  stopPct: {
    title: 'Stop distance from entry',
    text: 'In risk-at-stop mode: how far price may move against a leg before it is closed, as a percent of the entry price. Together with the planned loss it sets exposure: a tighter stop means a bigger position for the same dollar risk, and a higher chance of being stopped by noise.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .dot(0.08, 0.55, { color: C.long, shape: 'up', label: 'entry' })
          .hline(0.4, { color: C.short, label: '2% stop: $500 exposure', below: true, left: true })
          .hline(0.18, { color: '#8E2A1B', label: '5% stop: $200 exposure', below: true, left: true })
          .text(0.4, 0.9, 'same $10 planned loss', { color: C.ink, bold: true }),
      ),
  },
  notional: {
    title: 'Notional per leg',
    text: 'Exposure of each leg: leverage × margin, sized from a fresh quote at entry. $100 at 3× is $300, which is about 0.004 BTC at $77,000. Profits do not raise this cap; losses can shrink the next leg.',
    svg: () =>
      chart((ch) =>
        ch
          .bar(0.05, 0.35, 0.55, 0.75, { color: C.blueSoft, label: '$100 margin' })
          .arrow(0.42, 0.65, 0.58, 0.65, { color: C.ink, label: '× 3' })
          .bar(0.62, 0.95, 0.45, 0.85, { label: '' })
          .text(0.62, 0.35, '$300 notional', { color: C.blue, bold: true }),
      ),
  },
  lossLimit: {
    title: 'Plan loss limit',
    text: 'The most the whole plan may lose. It places a stop for the open leg; when price reaches it, the leg is closed and the plan ends. It is also checked at every scheduled close. Note what it costs in price terms: $30 against $300 of exposure is a 10% BTC move, which will not happen inside half an hour, so a limit that large is effectively no stop at all. The chart shows you where the line actually sits.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.18, { color: C.short, label: 'stop line', below: true, left: true })
          .dot(0.08, 0.7, { color: C.long, shape: 'up', label: 'long' })
          .path([[0.08, 0.7], [0.3, 0.76], [0.45, 0.58], [0.62, 0.18]], { color: C.ink, width: 2 })
          .dot(0.62, 0.18, { color: C.short, shape: 'x' })
          .arrow(0.2, 0.66, 0.2, 0.21, { label: '−$30', lx: 0.23, ly: 0.42 })
          .text(0.66, 0.5, 'price reaches it:', { color: C.short, bold: true })
          .text(0.66, 0.4, 'closed at −$30,', { color: C.short, bold: true })
          .text(0.66, 0.3, 'plan ends', { color: C.short, bold: true }),
      ),
  },
  tpTarget: {
    title: 'Take profit',
    text: 'A profit that ends the plan. In path mode it is a whole-plan target: realized P&L from earlier legs and fees count, and the trigger price is recomputed for each leg. A short can never earn more than its notional, so larger targets are flagged as unreachable.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.82, { color: C.long, label: 'take profit line', left: true })
          .dot(0.08, 0.3, { color: C.long, shape: 'up', label: 'long' })
          .path([[0.08, 0.3], [0.3, 0.44], [0.45, 0.38], [0.62, 0.82]], { color: C.ink, width: 2 })
          .dot(0.62, 0.82, { color: C.long })
          .arrow(0.2, 0.36, 0.2, 0.79, { color: C.long, label: '+$20', lx: 0.23, ly: 0.58 })
          .text(0.66, 0.66, 'price reaches it:', { color: C.long, bold: true })
          .text(0.66, 0.56, 'closed at +$20,', { color: C.long, bold: true })
          .text(0.66, 0.46, 'plan ends', { color: C.long, bold: true }),
      ),
  },
  feeRate: {
    title: 'Taker fee per side',
    text: 'Charged on every fill as fee × notional. Open plus close is one round trip: at 0.045% and $300 notional that is $0.27, about 0.27% of a $100 margin, so a leg must move roughly 0.09% just to break even. On a market that travels 0.3% in half an hour, that is a real share of the move.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0.1, 0.5], [0.7, 0.66]], { color: C.ink, width: 2 })
          .dot(0.1, 0.5, { color: C.long, label: 'buy: $0.135', dy: 18, dx: -10 })
          .dot(0.7, 0.66, { color: C.short, label: 'sell: $0.135', dy: -10, dx: -80 })
          .text(0.1, 0.2, 'round trip $0.27 = 0.27% of $100 margin', { color: C.ink, bold: true }),
      ),
  },
  fundingRate: {
    title: 'Funding rate per hour',
    text: 'A cash flow between longs and shorts, settled hourly while a position is open: size × price × rate. With a positive rate, longs pay and shorts receive. A plan that is flat at settlement pays nothing.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .vline(0.5, { label: 'funding settles' })
          .path([[0.1, 0.5], [0.9, 0.6]], { color: C.long, width: 3 })
          .dot(0.1, 0.5, { color: C.long, shape: 'up' })
          .arrow(0.5, 0.45, 0.5, 0.3, {
            label: 'long pays size × price × rate',
            lx: 0.04,
            ly: 0.2,
          }),
      ),
  },
  nextFunding: {
    title: 'Next settlement in',
    text: 'Where the first funding settlement falls inside the canvas; the next ones follow every interval. If you want to avoid one, lift the pen around it: a gap means you are flat when it settles.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .vline(0.45, { label: 'funding' })
          .band(0.38, 0.55, { label: '' })
          .path([[0, 0.5], [0.38, 0.64]])
          .path([[0.55, 0.5], [1, 0.7]])
          .text(0.4, 0.25, 'flat here: nothing paid', { color: C.muted, bold: true }),
      ),
  },
  maintFrac: {
    title: 'Maintenance margin',
    text: "The venue liquidates when equity falls to this fraction of the position's notional, which happens before equity reaches zero. Used here as a constant to draw the liquidation estimate; real venues use tiers that change with size.",
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.2, { color: '#8E2A1B', dash: '2 4', label: 'maintenance', below: true })
          .path([[0.05, 0.85], [0.3, 0.7], [0.5, 0.5], [0.72, 0.2]], { color: C.ink, width: 2 })
          .dot(0.72, 0.2, { color: '#8E2A1B', shape: 'x' })
          .text(0.05, 0.93, 'equity of the position', { color: C.ink, bold: true })
          .text(0.6, 0.12, 'liquidated before equity hits $0', {
            color: '#8E2A1B',
            bold: true,
            anchor: 'start',
          }),
      ),
  },
  outage: {
    title: 'Execution-service outage',
    text: 'Pretends the scheduler goes down for a while. Scheduled entries inside the window are skipped and never catch up; scheduled closes run late, at the window end; venue-native stop, take profit and liquidation keep working because they live on the exchange. The price feed is unaffected — this simulates your side failing, not the market.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0.4, 0.7, { solid: '#9A6200', alpha: 0.12, label: 'outage', textColor: C.amber })
          .hline(0.25, { color: C.short, label: 'stop still active', below: true })
          .path([[0.05, 0.5], [0.5, 0.66]], { color: C.long, width: 3 })
          .dot(0.5, 0.66, { color: C.amber, shape: 'x' })
          .arrow(0.52, 0.8, 0.7, 0.8, { color: C.amber, label: 'close runs late', lx: 0.72, ly: 0.82 })
          .dot(0.6, 0.45, { color: C.amber, shape: 'up', label: 'entry skipped', dy: 16, dx: -30 }),
      ),
  },
  mode: {
    title: 'Follow my path or Single trade',
    text: 'Follow my path turns every turn into a scheduled leg and every gap into a flat. Single trade reads only your start and end point: one long or short, and the turns in between are just your forecast.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(zig.slice(0, 7), { color: C.graphite, width: 1.5 })
          .path([[0, 0.5], [0.16, 0.6], [0.24, 0.38], [0.33, 0.68], [0.42, 0.3], [0.5, 0.62]])
          .text(0.02, 0.9, 'path: each turn trades', { color: C.blue, bold: true })
          .path(zig.slice(6), { color: C.graphite, width: 1.5 })
          .path([[0.5, 0.62], [1, 0.6]], { color: C.blue })
          .text(0.55, 0.9, 'single: start to end only', { color: C.blue, bold: true }),
      ),
  },
};

export const GLOSS: InfoEntry[] = [
  {
    title: 'Long and short',
    text: 'Long: you profit if price rises. Short: you profit if price falls. On a perpetual you can open either at any time. In Trace a rising stroke is long, a falling stroke is short, and the number on the marker is the leg.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0.05, 0.45], [0.45, 0.75]], { color: C.long })
          .dot(0.05, 0.45, { color: C.long, shape: 'up', label: 'long' })
          .path([[0.55, 0.75], [0.95, 0.4]], { color: C.short })
          .dot(0.55, 0.75, { color: C.short, shape: 'down', label: 'short' }),
      ),
  },
  {
    title: 'Swing high and swing low',
    text: 'A swing high is a turn from rising to falling; a swing low is a turn from falling to rising. Every reversal in your drawing is one of these, and every one is a close plus a new open.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0.05, 0.4], [0.35, 0.75], [0.65, 0.35], [0.95, 0.7]])
          .dot(0.35, 0.75, { color: C.short, shape: 'down', label: 'swing high', dy: -10, dx: -30 })
          .dot(0.65, 0.35, { color: C.long, shape: 'up', label: 'swing low', dy: 18, dx: -28 }),
      ),
  },
  {
    title: 'Higher high, higher low (HH, HL)',
    text: 'Uptrend structure: each swing high is above the previous one and each swing low is above the previous one. Trace labels turns HH and HL when it sees this.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.4], [0.2, 0.6], [0.35, 0.5], [0.55, 0.75], [0.7, 0.62], [0.9, 0.9]])
          .dot(0.2, 0.6, { color: C.short, shape: 'down', label: 'SH', dy: -10, dx: -8 })
          .dot(0.35, 0.5, { color: C.long, shape: 'up', label: 'HL', dy: 18, dx: -8 })
          .dot(0.55, 0.75, { color: C.short, shape: 'down', label: 'HH', dy: -10, dx: -8 })
          .dot(0.7, 0.62, { color: C.long, shape: 'up', label: 'HL', dy: 18, dx: -8 }),
      ),
  },
  {
    title: 'Lower high, lower low (LH, LL)',
    text: 'Downtrend structure: rallies fail below the previous high and drops make new lows. Labels LH and LL.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.8], [0.2, 0.55], [0.35, 0.68], [0.55, 0.4], [0.7, 0.52], [0.9, 0.2]])
          .dot(0.2, 0.55, { color: C.long, shape: 'up', label: 'SL', dy: 18, dx: -8 })
          .dot(0.35, 0.68, { color: C.short, shape: 'down', label: 'LH', dy: -10, dx: -8 })
          .dot(0.55, 0.4, { color: C.long, shape: 'up', label: 'LL', dy: 18, dx: -8 })
          .dot(0.7, 0.52, { color: C.short, shape: 'down', label: 'LH', dy: -10, dx: -8 }),
      ),
  },
  {
    title: 'Slope, momentum, rate of change',
    text: 'How fast price moves: percent per minute in Trace. Shallow under 0.1%/min, moderate to 0.5, steep to 2, parabolic beyond. On real BTC almost every drawn leg is shallow, which is worth knowing: shallow moves have to clear the fees before they earn anything.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.5], [1, 0.58]], { color: C.graphite })
          .path([[0, 0.5], [1, 0.8]], { color: C.blue })
          .path([[0, 0.5], [0.5, 0.98]], { color: C.short })
          .text(0.72, 0.53, 'shallow', { color: C.graphite, bold: true })
          .text(0.72, 0.74, 'steep', { color: C.blue, bold: true })
          .text(0.28, 0.9, 'parabolic', { color: C.short, bold: true }),
      ),
  },
  {
    title: 'V and inverted V',
    text: 'Sharp reversals. A V is a fast drop that reverses at once; an inverted V (spike) is the mirror. In path mode both are two legs meeting at the turn.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0.02, 0.8], [0.25, 0.3], [0.48, 0.82]])
          .path([[0.52, 0.3], [0.75, 0.8], [0.98, 0.28]])
          .text(0.18, 0.18, 'V', { color: C.ink, bold: true })
          .text(0.72, 0.9, 'inverted V', { color: C.ink, bold: true }),
      ),
  },
  {
    title: 'W and M (double bottom, double top)',
    text: 'Price tests a level twice. W: two lows, bullish. M: two highs, bearish. The middle peak or trough is the neckline traders wait for. Trace trades every leg; a discretionary trader usually trades only the second test.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0.02, 0.8], [0.14, 0.3], [0.25, 0.58], [0.36, 0.32], [0.48, 0.85]])
          .path([[0.52, 0.2], [0.64, 0.75], [0.75, 0.45], [0.86, 0.73], [0.98, 0.15]])
          .text(0.22, 0.1, 'W', { color: C.ink, bold: true })
          .text(0.72, 0.92, 'M', { color: C.ink, bold: true }),
      ),
  },
  {
    title: 'Head and shoulders',
    text: 'Three peaks with the middle one highest; the line under the two troughs is the neckline. A top pattern; its inverse is a bottom. Trace reads six legs and names the neckline.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.3], [0.15, 0.6], [0.3, 0.42], [0.5, 0.88], [0.7, 0.42], [0.85, 0.6], [1, 0.25]])
          .hline(0.42, { color: C.short, label: 'neckline', below: true })
          .text(0.4, 0.96, 'head', { color: C.ink, bold: true })
          .text(0.07, 0.7, 'shoulder', { color: C.muted })
          .text(0.77, 0.7, 'shoulder', { color: C.muted }),
      ),
  },
  {
    title: 'Range, consolidation, chop',
    text: 'No trend: price oscillates between support and resistance. Trading every swing in a range is what pays the fees. In Trace a horizontal segment or a lifted pen is flat: no position.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.7, { color: C.muted, label: 'resistance' })
          .hline(0.35, { color: C.muted, label: 'support', below: true })
          .path(
            Array.from({ length: 41 }, (_, i): Pt => {
              const u = i / 40;
              return [u, 0.525 + 0.17 * Math.sin(u * Math.PI * 5)];
            }),
            { color: C.ink, width: 2 },
          ),
      ),
  },
  {
    title: 'Breakout and false breakout',
    text: 'Price leaves a range decisively. A false breakout pokes through and falls back inside. The breakout stop entry rule in Trace fills only if price actually crosses the drawn level.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.6, { color: C.muted, label: 'range top' })
          .path([[0, 0.45], [0.15, 0.58], [0.3, 0.45], [0.45, 0.58], [0.55, 0.5], [0.65, 0.62], [1, 0.92]], {
            color: C.ink,
            width: 2,
          })
          .dot(0.65, 0.62, { color: C.long, shape: 'up', label: 'breakout' }),
      ),
  },
  {
    title: 'Pullback and retest',
    text: 'After a move, price comes back part of the way (pullback) or returns to the level it broke (retest) before continuing. The pullback limit entry rule rests an order at the drawn price and waits.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.6, { color: C.muted, label: 'old resistance, new support', below: true })
          .path([[0, 0.3], [0.4, 0.8], [0.6, 0.6], [1, 0.95]], { color: C.ink, width: 2 })
          .dot(0.6, 0.6, { color: C.long, shape: 'up', label: 'retest entry', dy: 18, dx: -30 }),
      ),
  },
  {
    title: 'Flag (bull, bear)',
    text: 'A sharp impulse (the pole) followed by a gentle drift against it (the flag), then continuation. In path mode the flag is a shallow leg; if it is under your tolerance it becomes a flat instead.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.2], [0.3, 0.78], [0.6, 0.66], [1, 0.98]])
          .text(0.05, 0.55, 'pole', { color: C.muted })
          .text(0.4, 0.85, 'flag', { color: C.muted }),
      ),
  },
  {
    title: 'Stop loss and take profit',
    text: 'Stop loss: an exit that limits the loss if price goes against you. Take profit: an exit that locks in a gain. In Trace the plan loss limit sets the stop and the take profit is a whole-plan target; both are reduce-only orders that end the plan.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.82, { color: C.long, label: 'take profit', left: true })
          .hline(0.22, { color: C.short, label: 'stop loss', below: true, left: true })
          .dot(0.1, 0.5, { color: C.long, shape: 'up', label: 'entry' })
          .path([[0.1, 0.5], [0.5, 0.65], [0.8, 0.82]], { color: C.ink, width: 2 }),
      ),
  },
  {
    title: 'Market, limit and stop orders',
    text: 'Market: fill now at the best available price. Limit: fill only at your price or better (used for pullbacks). Stop: becomes a market order once price crosses a level (used for breakouts and for stop losses). A limit touch does not guarantee a fill; a stop trigger does not guarantee the stop price.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.5], [0.3, 0.6], [0.5, 0.45], [0.75, 0.78], [1, 0.7]], { color: C.ink, width: 2 })
          .dot(0.3, 0.6, { color: C.muted, label: 'market: now' })
          .hline(0.45, { color: C.long, label: 'buy limit below', below: true, left: true })
          .hline(0.72, { color: C.blue, label: 'buy stop above', left: true }),
      ),
  },
  {
    title: 'Reduce-only',
    text: 'An order flagged so it can only shrink a position, never flip it. Trace closes legs and places stops and targets reduce-only, so a stale exit can never accidentally open the opposite trade.',
    svg: () =>
      chart((ch) =>
        ch
          .bar(0.05, 0.55, 0.5, 0.7, { color: C.blueSoft, label: 'position' })
          .arrow(0.55, 0.6, 0.32, 0.6, { color: C.short, label: 'reduce-only close', lx: 0.58, ly: 0.4 })
          .text(0.05, 0.25, 'can shrink, cannot flip', { color: C.ink, bold: true }),
      ),
  },
  {
    title: 'Notional, margin and leverage',
    text: 'Notional is the size of the position in dollars; margin is the collateral you put up; leverage is notional ÷ margin. $100 at 3× controls $300 of BTC. The price move is applied to notional, so 1% on $300 is $3, or 3% of margin.',
    svg: () =>
      chart((ch) =>
        ch
          .bar(0.05, 0.3, 0.55, 0.75, { color: C.blueSoft, label: '$100 margin' })
          .bar(0.05, 0.8, 0.2, 0.4, { label: '$300 notional at 3×' }),
      ),
  },
  {
    title: 'Effective leverage',
    text: 'Notional ÷ current equity. It starts at your opening leverage and rises as a position loses, because notional stays the same while equity shrinks. At 3× a 10% adverse move takes it to 3.86×.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.3], [1, 0.8]], { color: C.short, width: 2.5 })
          .text(0.03, 0.22, '3.0× at entry', { color: C.muted })
          .text(0.6, 0.9, '3.86× after −10%', { color: C.short, bold: true }),
      ),
  },
  {
    title: 'Liquidation and maintenance margin',
    text: 'The venue force-closes a position when equity falls to the maintenance requirement, a small fraction of notional, which happens before equity reaches zero. Higher leverage puts it closer to entry. Trace shows an estimate with a constant maintenance fraction.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.2, { color: '#8E2A1B', dash: '2 4', label: 'maintenance', below: true })
          .path([[0.05, 0.85], [0.5, 0.5], [0.72, 0.2]], { color: C.ink, width: 2 })
          .dot(0.72, 0.2, { color: '#8E2A1B', shape: 'x', label: 'liquidated' }),
      ),
  },
  {
    title: 'Isolated vs cross margin',
    text: 'Isolated: the collateral for one position is walled off; you can lose at most that allocation. Cross: all positions share the account balance. Trace plans use isolated margin so a plan cannot drain the rest of the account.',
    svg: () =>
      chart((ch) =>
        ch
          .bar(0.05, 0.45, 0.5, 0.7, { color: C.blueSoft })
          .text(0.05, 0.32, 'isolated: this plan only', { color: C.blue, bold: true })
          .bar(0.55, 0.95, 0.5, 0.7, { color: 'rgba(198,65,44,.25)' })
          .text(0.55, 0.32, 'cross: whole account', { color: C.short, bold: true }),
      ),
  },
  {
    title: 'Mark price vs last price',
    text: 'Last price is the most recent trade. Mark price is a smoothed fair value the venue uses for unrealized P&L and liquidation, so a single odd trade cannot liquidate you. Charts usually show last; liquidation uses mark. Trace uses the last trade for everything, which is the optimistic simplification.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(wobble([0, 0.5], [1, 0.65], 60, 0.05, 90), { color: C.graphite, width: 1.5 })
          .path([[0, 0.5], [1, 0.65]], { color: C.ink, width: 2 })
          .text(0.03, 0.9, 'grey: last trades', { color: C.graphite, bold: true })
          .text(0.03, 0.82, 'dark: mark price', { color: C.ink, bold: true }),
      ),
  },
  {
    title: 'Funding',
    text: 'A periodic payment between longs and shorts that keeps a perpetual near its index. Positive rate: longs pay shorts. Only positions open at the settlement pay or receive.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .vline(0.5, { label: 'settlement' })
          .path([[0.1, 0.5], [0.9, 0.6]], { color: C.long, width: 3 })
          .arrow(0.5, 0.45, 0.5, 0.28, {
            label: 'longs pay when the rate is positive',
            lx: 0.04,
            ly: 0.18,
          }),
      ),
  },
  {
    title: 'Taker and maker fees',
    text: 'Taker: you trade against a resting order and pay the higher fee. Maker: your resting limit is filled and pays less or gets a rebate. Trace assumes taker fees for market and stop fills; a pullback limit would usually be a maker fill.',
    svg: () =>
      chart((ch) =>
        ch
          .bar(0.05, 0.5, 0.55, 0.7, { color: C.short, label: 'taker 0.045%' })
          .bar(0.05, 0.25, 0.25, 0.45, { color: C.long, label: 'maker 0.015%' }),
      ),
  },
  {
    title: 'Slippage',
    text: 'The gap between the price you expected and the price you got, from spread and thin books. Real fills embed it; the simulator fills at the threshold price, which is optimistic.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.6, { color: C.muted, label: 'expected', left: true })
          .dot(0.5, 0.6, { color: C.muted })
          .dot(0.5, 0.7, { color: C.short, label: 'filled here' })
          .arrow(0.42, 0.6, 0.42, 0.7, { label: 'slippage', lx: 0.2, ly: 0.66, color: C.short }),
      ),
  },
  {
    title: 'Drawdown',
    text: 'The drop from a peak in equity to a later trough. Equity ink shows the drawdown from your margin; the equity sparkline in the video export shows every peak and trough.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path([[0, 0.5], [0.3, 0.8], [0.55, 0.4], [0.8, 0.7], [1, 0.75]], { color: C.ink, width: 2 })
          .arrow(0.3, 0.8, 0.3, 0.4, { label: 'drawdown', lx: 0.33, ly: 0.6 }),
      ),
  },
  {
    title: 'R (risk unit) and reward-to-risk',
    text: 'R is the dollars you risk to your stop. A trade that gains 2R made twice its risk. Risk-at-stop sizing sets R directly; a take profit of +$20 against a $10 stop is a 2:1 reward-to-risk plan.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.3, { color: C.short, label: '−1R stop', below: true, left: true })
          .hline(0.9, { color: C.long, label: '+2R target', left: true })
          .dot(0.1, 0.5, { color: C.long, shape: 'up', label: 'entry' })
          .arrow(0.4, 0.5, 0.4, 0.3, { color: C.short })
          .arrow(0.6, 0.5, 0.6, 0.9, { color: C.long }),
      ),
  },
  {
    title: 'Time exit and flat',
    text: 'Trace-specific: the drawing ending before the horizon is a time exit; a lifted pen or a horizontal segment is flat, meaning no position. Being flat is a decision, not a gap in the plan.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0.4, 0.6, { label: 'flat' })
          .band(0.85, 1, { label: 'time exit' })
          .path([[0, 0.5], [0.4, 0.68]])
          .path([[0.6, 0.45], [0.85, 0.7]]),
      ),
  },
];

/** Hover/click info buttons next to every configurator item. Returns a teardown function. */
export function mountPopovers(root: HTMLElement) {
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  document.body.appendChild(pop);
  let pinned: HTMLButtonElement | null = null;
  let current: HTMLButtonElement | null = null;
  // Tracked so teardown can remove them again: React double-invokes effects in dev,
  // and a leaked button shows up as a stray 'i' glued to the section heading.
  const injected: HTMLButtonElement[] = [];

  function render(btn: HTMLButtonElement, key: string) {
    const d = INFO[key];
    if (!d) return;
    pop.innerHTML = `<h4>${d.title}</h4>${d.svg()}<p>${d.text}</p><div class="pin">${pinned ? 'Click the ⓘ again or press Esc to close.' : 'Click ⓘ to keep this open.'}</div>`;
    pop.hidden = false;
    current = btn;
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const aside = btn.closest('aside.config');
    const narrow = window.innerWidth < 700;
    let left =
      aside && window.innerWidth >= 1180 ? aside.getBoundingClientRect().right + 10 : r.right + 10;
    let top = r.top - 8;
    if (narrow) {
      left = 8;
      top = r.bottom + 8;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    } else {
      if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 10);
      if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    }
    pop.classList.toggle('pinned', !!pinned);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  const hide = () => {
    if (pinned) return;
    pop.hidden = true;
    current = null;
  };
  const unpin = () => {
    if (pinned) {
      pinned.setAttribute('aria-expanded', 'false');
      pinned = null;
    }
    pop.hidden = true;
    current = null;
  };

  function attach(host: Element, key: string) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'info';
    b.textContent = 'i';
    b.setAttribute('aria-label', `What is ${INFO[key].title}?`);
    b.setAttribute('aria-expanded', 'false');
    b.dataset.key = key;
    injected.push(b);
    const lab = host.closest('label');
    if (lab) lab.insertAdjacentElement('afterend', b);
    else host.appendChild(b);
    b.addEventListener('mouseenter', () => {
      if (!pinned) render(b, key);
    });
    b.addEventListener('mouseleave', hide);
    b.addEventListener('focus', () => {
      if (!pinned) render(b, key);
    });
    b.addEventListener('blur', hide);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pinned === b) {
        unpin();
        return;
      }
      if (pinned) pinned.setAttribute('aria-expanded', 'false');
      pinned = b;
      b.setAttribute('aria-expanded', 'true');
      render(b, key);
    });
  }

  root.querySelectorAll('aside.config .row label[for]').forEach((l) => {
    const key = l.getAttribute('for');
    const k = key === 'outageFrom' || key === 'outageTo' ? null : key;
    if (k && INFO[k]) attach(l, k);
  });
  root.querySelectorAll<HTMLElement>('[data-info]').forEach((el) => {
    const k = el.dataset.info;
    if (k && INFO[k]) attach(el, k);
  });

  const onDocClick = (e: MouseEvent) => {
    if (pinned && !pop.contains(e.target as Node) && e.target !== pinned) unpin();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') unpin();
  };
  const onScroll = () => {
    if (current) render(current, current.dataset.key!);
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);

  return () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll, true);
    for (const b of injected) b.remove();
    injected.length = 0;
    pop.remove();
  };
}
