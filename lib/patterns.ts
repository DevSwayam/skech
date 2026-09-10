import { lerp } from './format';

/** Authored in normalised units: u = position across the horizon 0..1, m = move as a fraction of the reference price. */
export type UPoint = [number, number];

export interface PatternDef {
  name: string;
  /** How Trace reads the shape. */
  how: string;
  /** What a trader means by it. */
  trader: string;
  pts: () => UPoint[][];
}

function curve(a: UPoint, b: UPoint, n: number, wob = 0): UPoint[] {
  const out: UPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push([lerp(a[0], b[0], u), lerp(a[1], b[1], u) + wob * Math.sin(u * 40)]);
  }
  return out;
}

export const PATTERNS: Record<string, PatternDef> = {
  up: {
    name: 'Single trend leg',
    how: 'One long from now to the endpoint. The simplest plan: direction, size, stop, target, time exit.',
    trader:
      'A trend leg is what everyone means by "going long": you expect price to travel up and hold for the whole move.',
    pts: () => [curve([0, 0], [1, 0.08], 40, 0.002)],
  },
  uptrend: {
    name: 'Uptrend: higher highs and higher lows',
    how: 'Long, short, long, short… on each swing. Trace labels each turn HH or HL. Every swing is a round trip, so the pullbacks (short legs) must be big enough to pay their fees.',
    trader:
      'The textbook definition of an uptrend: each swing high is above the last (HH) and each swing low is above the last (HL). Traders buy the higher lows and trail stops beneath them.',
    pts: () => [
      [[0, 0], [0.15, 0.05], [0.28, 0.02], [0.45, 0.09], [0.58, 0.055], [0.75, 0.13], [0.86, 0.1], [1, 0.16]],
    ],
  },
  downtrend: {
    name: 'Downtrend: lower highs and lower lows',
    how: 'Short, long, short, long… Trace labels each turn LH or LL.',
    trader:
      'Each rally fails below the previous high (LH) and each drop makes a new low (LL). Traders sell the lower highs.',
    pts: () => [
      [[0, 0], [0.15, -0.05], [0.28, -0.02], [0.45, -0.09], [0.58, -0.055], [0.75, -0.13], [0.86, -0.1], [1, -0.16]],
    ],
  },
  staircase: {
    name: 'Staircase',
    how: 'Long, then a horizontal segment (flat, position closed), then long again. The pauses are flat legs, each costing a round trip. Use the Hold toggle in Review to stay long through a pause.',
    trader:
      'Impulse, pause, impulse. Steps up with sideways rests are how strong trends often look; the rests are where traders add.',
    pts: () => [[[0, 0], [0.25, 0.05], [0.45, 0.05], [0.7, 0.1], [0.85, 0.1], [1, 0.14]]],
  },
  v: {
    name: 'V bottom',
    how: 'Two legs: short into the low, long out of it. Both must be timed to the reversal minute.',
    trader:
      'A sharp sell-off that reverses just as fast. Hard to trade live because the turn is only obvious afterwards; many traders wait for a higher low instead.',
    pts: () => [[...curve([0, 0], [0.45, -0.06], 20), ...curve([0.45, -0.06], [1, 0.07], 24)]],
  },
  spike: {
    name: 'Inverted V (spike top)',
    how: 'Long into the high, short out of it.',
    trader:
      'A blow-off: the last buyers rush in, then price collapses. The short leg is the trade most people want; the long leg is the part that pays for it if the timing is right.',
    pts: () => [[...curve([0, 0], [0.4, 0.07], 18), ...curve([0.4, 0.07], [1, -0.05], 26)]],
  },
  w: {
    name: 'W / double bottom',
    how: 'Four legs: short, long, short, long. Trace notes the two similar lows. A discretionary trader usually trades only the second low; here every leg trades.',
    trader:
      'Price tests a low twice and holds. The second low with a higher close is the classic reversal signal; the entry is the break above the middle peak (the neckline).',
    pts: () => [[[0, 0.02], [0.22, -0.06], [0.42, -0.015], [0.62, -0.058], [0.82, 0.01], [1, 0.06]]],
  },
  m: {
    name: 'M / double top',
    how: 'Long, short, long, short. Trace notes the two similar highs.',
    trader:
      'Price fails at the same level twice. Traders short the second failure or the break below the middle trough.',
    pts: () => [[[0, -0.02], [0.22, 0.06], [0.42, 0.015], [0.62, 0.058], [0.82, -0.01], [1, -0.06]]],
  },
  hs: {
    name: 'Head and shoulders top',
    how: 'Six legs. Trace names the shoulders, the higher head and the neckline between the two troughs.',
    trader:
      'Left shoulder, higher head, lower right shoulder: buyers are running out. The trade is the short on the break of the neckline; the measured target is the head-to-neckline height projected down.',
    pts: () => [[[0, -0.03], [0.14, 0.04], [0.28, 0.0], [0.45, 0.09], [0.6, 0.0], [0.74, 0.04], [1, -0.06]]],
  },
  ihs: {
    name: 'Inverse head and shoulders',
    how: 'Six legs mirrored: a lower head between two shoulders.',
    trader:
      'The bullish mirror: sellers exhaust at the head, and the break above the neckline is the long entry.',
    pts: () => [[[0, 0.03], [0.14, -0.04], [0.28, 0.0], [0.45, -0.09], [0.6, 0.0], [0.74, -0.04], [1, 0.06]]],
  },
  saucer: {
    name: 'Rounded bottom (saucer)',
    how: 'A slow curve. The simplifier reads it as a shallow short then a long; the exact turn depends on your tolerance.',
    trader:
      'A gradual, low-drama reversal. The slope terms matter here: both legs are shallow, so fees weigh heavily against the move.',
    pts: () => [
      Array.from({ length: 41 }, (_, i): UPoint => {
        const u = i / 40;
        return [u, -0.06 * Math.sin(u * Math.PI) + 0.03 * u];
      }),
    ],
  },
  bullflag: {
    name: 'Bull flag: pullback then continuation',
    how: 'Long, a shallow short (the pullback), then long. The middle leg is small; if it is under your tolerance it becomes a flat instead.',
    trader:
      'A strong impulse followed by a gentle drift against it, then another impulse. Traders buy the end of the drift; the flagpole height is the target.',
    pts: () => [[[0, 0], [0.3, 0.08], [0.6, 0.06], [1, 0.15]]],
  },
  bearflag: {
    name: 'Bear flag',
    how: 'Short, a shallow long, then short.',
    trader: 'The mirror image: an impulse down, a weak bounce, then continuation.',
    pts: () => [[[0, 0], [0.3, -0.08], [0.6, -0.06], [1, -0.15]]],
  },
  breakout: {
    name: 'Breakout from a range',
    how: 'A horizontal segment (flat, no position) then a long. Try the "Breakout stop" entry rule: the long fills only if price actually breaks through the drawn level.',
    trader:
      'Price coils sideways, then leaves the range decisively. The range top is the trigger; false breakouts that fall back inside are the main risk.',
    pts: () => [[[0, 0], [0.5, 0.003], [0.5, 0.003], [1, 0.1]]],
  },
  retest: {
    name: 'Breakout, pullback, retest',
    how: 'Long, a short back to the level, then long. With the "Pullback limit" entry rule the third leg rests at the drawn retest price.',
    trader:
      'After a breakout, price often returns to the old resistance to test it as support. Buying the retest gives a tighter stop than chasing the breakout.',
    pts: () => [[[0, 0], [0.35, 0.06], [0.55, 0.02], [1, 0.11]]],
  },
  chop: {
    name: 'Sideways chop (range)',
    how: 'Alternating small legs with similar highs and lows. Trace reads it as a range and warns that trading every swing is what pays the fees.',
    trader:
      'No trend: price oscillates between support and resistance. Range traders fade the edges; trend traders sit it out.',
    pts: () => [
      Array.from({ length: 61 }, (_, i): UPoint => {
        const u = i / 60;
        return [u, 0.018 * Math.sin(u * Math.PI * 6)];
      }),
    ],
  },
  gap: {
    name: 'Sit out the middle',
    how: 'Two strokes: long, then a gap (flat, position closed), then short. Gaps are how you avoid a funding settlement or a news release.',
    trader:
      'Being flat is a position too. Traders step aside for scheduled events and re-enter when the noise clears.',
    pts: () => [curve([0, 0], [0.35, 0.05], 20), curve([0.55, 0.045], [1, -0.04], 24)],
  },
  late: {
    name: 'Start later, end early',
    how: 'The first leg is a scheduled entry (not at now), and the drawing ends before the horizon, so the plan has a time exit.',
    trader: 'Waiting for a setup and leaving before the close: not every minute has to be traded.',
    pts: () => [curve([0.2, 0.01], [0.8, 0.07], 30)],
  },
  zigzag: {
    name: 'Overtrading zigzag',
    how: 'Many small alternating legs. Watch the fee line in Review and the leg budget notice.',
    trader:
      'Trying to catch every wiggle. Slippage and fees per round trip usually exceed the edge per swing.',
    pts: () => [
      Array.from({ length: 161 }, (_, i): UPoint => {
        const u = i / 160;
        return [u, 0.05 * Math.sin(u * Math.PI * 2.5) + 0.0012 * Math.sin(u * 90)];
      }),
    ],
  },
};

/**
 * The pattern amplitudes are fractions of price (up to 16%), which suited the original
 * synthetic market. Against live BTC — a few tenths of a percent in half an hour — they
 * are scaled down so a loaded pattern lands on the same scale as the real chart.
 */
export const PATTERN_SCALE = 0.06;
