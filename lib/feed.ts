export interface Candle {
  /** Candle open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Tick {
  /** Epoch ms. */
  t: number;
  p: number;
}

export type FeedStatus = 'connecting' | 'live' | 'stale' | 'polling' | 'demo' | 'offline';

export const CANDLE_MS = 60_000;

/**
 * The recorded price history of one session.
 *
 * Engine time is seconds since `t0Ms` (the moment the session started), so history sits
 * at negative t and the plan you draw sits at positive t. `at()` is what the simulator
 * calls, and it never looks past the last tick actually received.
 */
export class PriceTape {
  readonly t0Ms: number;
  /** Tick times in seconds since t0, ascending. */
  private ts: number[] = [];
  private ps: number[] = [];
  /** One-minute candles, ascending by open time, covering history and the live session. */
  candles: Candle[] = [];

  constructor(t0Ms: number) {
    this.t0Ms = t0Ms;
  }

  /** Seed from historical candles loaded before the session started. */
  seedCandles(candles: Candle[]) {
    this.candles = candles.slice().sort((a, b) => a.t - b.t);
    const last = this.candles[this.candles.length - 1];
    if (last && !this.ts.length) {
      // The final candle is usually the *in-progress* minute, so its close time is in
      // the future. The seed only means "this was the price as the session began", so it
      // has to sit at or before t = 0. Left in the future it becomes the newest tick,
      // `push` clamps every live tick onto it, and `at()` returns one frozen price —
      // a flat chart, and a simulator trading against a market that never moves.
      const t = Math.min(0, (last.t + CANDLE_MS - this.t0Ms) / 1000);
      this.ts.push(t);
      this.ps.push(last.c);
    }
  }

  push(tick: Tick) {
    if (!Number.isFinite(tick.p) || tick.p <= 0) return;
    let t = (tick.t - this.t0Ms) / 1000;
    // Trade timestamps jitter by a few milliseconds and can arrive slightly out of
    // order. The series has to stay monotonic for the binary search in `at()`, so
    // clamp such a tick onto the previous instant rather than throwing its price away.
    if (this.ts.length) t = Math.max(t, this.ts[this.ts.length - 1]);
    this.ts.push(t);
    this.ps.push(tick.p);
    this.addToCandle(tick);
  }

  private addToCandle(tick: Tick) {
    const bucket = Math.floor(tick.t / CANDLE_MS) * CANDLE_MS;
    const last = this.candles[this.candles.length - 1];
    if (last && last.t === bucket) {
      last.c = tick.p;
      last.h = Math.max(last.h, tick.p);
      last.l = Math.min(last.l, tick.p);
    } else if (!last || bucket > last.t) {
      // Carry the previous close forward only for the very next minute. After a gap in
      // the data, opening at the stale close would draw one huge bogus candle.
      const contiguous = last && bucket - last.t <= CANDLE_MS;
      const open = contiguous ? last!.c : tick.p;
      this.candles.push({
        t: bucket,
        o: open,
        h: Math.max(open, tick.p),
        l: Math.min(open, tick.p),
        c: tick.p,
      });
    }
  }

  /** Last known price at or before `t` (seconds since session start). */
  at = (t: number): number => {
    const n = this.ts.length;
    if (!n) return 0;
    if (t <= this.ts[0]) return this.ps[0];
    if (t >= this.ts[n - 1]) return this.ps[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.ts[m] <= t) lo = m;
      else hi = m;
    }
    return this.ps[lo];
  };

  get last() {
    return this.ps.length ? this.ps[this.ps.length - 1] : 0;
  }

  get lastT() {
    return this.ts.length ? this.ts[this.ts.length - 1] : 0;
  }

  get count() {
    return this.ts.length;
  }

  /**
   * High-to-low over the last `n` one-minute candles, in dollars. Used to scale how big
   * a drawn move has to be before it counts as a trade: a fixed percentage of price is
   * useless here, because BTC moves a few hundredths of a percent in a few minutes.
   */
  recentRange(n = 20): number {
    const cs = this.candles.slice(-n);
    if (!cs.length) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of cs) {
      lo = Math.min(lo, k.l);
      hi = Math.max(hi, k.h);
    }
    return Number.isFinite(hi - lo) ? hi - lo : 0;
  }

  /** Session price line (t in seconds, ascending) for drawing what has happened so far. */
  sessionLine(fromT = 0): Tick[] {
    const out: Tick[] = [];
    for (let i = 0; i < this.ts.length; i++)
      if (this.ts[i] >= fromT) out.push({ t: this.ts[i], p: this.ps[i] });
    return out;
  }
}

export type Venue = 'bybit' | 'binance' | 'coinbase';

export interface VenueTick {
  price: number;
  t: number;
  open24h?: number;
}

export interface VenueSpec {
  label: string;
  /** Symbol-aware: the picker can point the socket at any listed market. */
  wsUrl: (symbol: string) => string;
  /** Sent once the socket opens, if the venue needs an explicit subscription. */
  subscribe?: (symbol: string) => string;
  /** Some venues drop a socket that has not been pinged. */
  heartbeat?: { everyMs: number; message: string };
  /** A single message can carry several trades, so this always returns a list. */
  parse: (raw: string) => VenueTick[] | null;
}

const numOr = (v: unknown) => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * History and live ticks must come from the same venue: the same asset prices slightly
 * differently across books, and mixing them would put a visible step in the chart
 * exactly where the live data begins.
 */
export const VENUES: Record<Venue, VenueSpec> = {
  bybit: {
    label: 'Bybit perps',
    /**
     * `publicTrade` is every print on the book, and Bybit's REST klines include the
     * in-progress minute — so history joins the live stream with no gap. It also lists
     * every USDT perpetual, which is what makes the market picker possible.
     */
    wsUrl: () => 'wss://stream.bybit.com/v5/public/linear',
    subscribe: (symbol) => JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}`] }),
    heartbeat: { everyMs: 18_000, message: JSON.stringify({ op: 'ping' }) },
    parse: (raw) => {
      const m = JSON.parse(raw) as {
        topic?: string;
        data?: { p?: string; T?: number }[];
      };
      if (!m.topic?.startsWith('publicTrade') || !Array.isArray(m.data)) return null;
      const out: VenueTick[] = [];
      for (const d of m.data) {
        const price = numOr(d.p);
        if (price) out.push({ price, t: d.T ?? Date.now() });
      }
      return out.length ? out : null;
    },
  },
  binance: {
    label: 'Binance spot',
    /**
     * A combined stream, because the two things we need arrive at very different rates:
     * `aggTrade` fires on every trade and keeps the chart live, while `ticker` only
     * pushes once a second and is used solely for the 24-hour open.
     */
    wsUrl: (symbol) => {
      const s = symbol.toLowerCase();
      return `wss://stream.binance.com:9443/stream?streams=${s}@aggTrade/${s}@ticker`;
    },
    parse: (raw) => {
      const env = JSON.parse(raw) as { data?: Record<string, unknown> } & Record<string, unknown>;
      const d = env.data ?? env;
      if (d.e === 'aggTrade') {
        const price = numOr(d.p);
        return price ? [{ price, t: (d.T as number) ?? Date.now() }] : null;
      }
      if (d.e === '24hrTicker') {
        const price = numOr(d.c);
        return price
          ? [{ price, t: (d.E as number) ?? Date.now(), open24h: numOr(d.o) }]
          : null;
      }
      return null;
    },
  },
  coinbase: {
    label: 'Coinbase BTC-USD',
    wsUrl: () => 'wss://ws-feed.exchange.coinbase.com',
    subscribe: () =>
      JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }),
    parse: (raw) => {
      const m = JSON.parse(raw) as {
        type?: string;
        price?: string;
        time?: string;
        open_24h?: string;
      };
      if (m.type !== 'ticker') return null;
      const price = numOr(m.price);
      if (!price) return null;
      return [
        {
          price,
          t: m.time ? Date.parse(m.time) || Date.now() : Date.now(),
          open24h: numOr(m.open_24h),
        },
      ];
    },
  },
};
