import { PriceTape, VENUES, type Candle, type FeedStatus, type Venue, type VenueTick } from './feed';

const POLL_MS = 2500;
const DEMO_MS = 250;
/** No tick for this long means the socket is dead even if it never said so. */
const STALE_MS = 15_000;
const STALE_CHECK_MS = 5_000;

export interface FeedState {
  status: FeedStatus;
  source: Venue | null;
  symbol: string;
  price: number;
  change24h: number | null;
  ticks: number;
  historyLoaded: boolean;
}

/**
 * The live BTC feed, as a plain object rather than a hook: the UI controller is
 * imperative, so it subscribes with a callback and reads the tape directly.
 *
 * History comes from our own API route (Binance klines, Coinbase as fallback) and the
 * live socket is opened on *the same venue*, because BTC-USD and BTCUSDT differ by a few
 * dollars and mixing them would put a step in the chart where live data begins.
 */
export class LiveFeed {
  readonly tape: PriceTape;
  private state: FeedState = {
    status: 'connecting',
    source: null,
    symbol: 'BTCUSDT',
    price: 0,
    change24h: null,
    ticks: 0,
    historyLoaded: false,
  };
  private listeners = new Set<(s: FeedState) => void>();
  private open24h: number | null = null;
  private ws: WebSocket | null = null;
  private pollId: ReturnType<typeof setInterval> | null = null;
  private demoId: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private staleId: ReturnType<typeof setInterval> | null = null;
  private beatId: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private stopped = false;

  readonly symbol: string;

  constructor(t0Ms: number, symbol = 'BTCUSDT') {
    this.tape = new PriceTape(t0Ms);
    this.symbol = symbol;
    this.state = { ...this.state, symbol };
  }

  get snapshot(): FeedState {
    return this.state;
  }

  onChange(fn: (s: FeedState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<FeedState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  async start() {
    await this.loadHistory();
    if (this.stopped) return;
    this.openSocket(this.state.source ?? 'bybit');
    this.staleId = setInterval(() => this.checkStale(), STALE_CHECK_MS);
  }

  /**
   * A websocket can stop delivering without ever firing close or error — a sleeping
   * laptop, a changed network, a silently dropped connection. Left alone the chart
   * freezes while the header still claims to be live, so treat silence as a failure.
   */
  private checkStale() {
    if (this.stopped || this.state.status !== 'live') return;
    if (Date.now() - this.lastTick < STALE_MS) return;
    this.emit({ status: 'stale' });
    this.closeSocket();
    this.openSocket(this.state.source ?? 'bybit');
  }

  private async loadHistory() {
    try {
      const res = await fetch(`/api/candles?granularity=60&symbol=${encodeURIComponent(this.symbol)}`, {
        cache: 'no-store',
      });
      const j = (await res.json()) as { source: Venue | null; candles: Candle[] };
      if (!j.candles?.length) throw new Error('no candles');
      this.tape.seedCandles(j.candles);
      this.emit({
        historyLoaded: true,
        source: j.source && VENUES[j.source] ? j.source : null,
        price: this.tape.last,
      });
    } catch {
      this.emit({ historyLoaded: true, source: null });
    }
  }

  private clearTimers() {
    if (this.pollId) clearInterval(this.pollId);
    if (this.demoId) clearInterval(this.demoId);
    this.pollId = this.demoId = null;
  }

  private accept(tick: VenueTick) {
    this.lastTick = Date.now();
    if (tick.open24h && tick.open24h > 0) this.open24h = tick.open24h;
    this.tape.push({ t: tick.t, p: tick.price });
    const price = this.tape.last;
    this.emit({
      status: this.state.status,
      price,
      ticks: this.tape.count,
      change24h: this.open24h ? ((price - this.open24h) / this.open24h) * 100 : this.state.change24h,
    });
  }

  private openSocket(venue: Venue) {
    if (this.stopped) return;
    const spec = VENUES[venue];
    this.emit({ status: 'connecting', source: venue });
    try {
      this.ws = new WebSocket(spec.wsUrl(this.symbol));
    } catch {
      this.startPolling();
      return;
    }
    // If no tick arrives soon the socket is useless to us; fall back to polling.
    this.watchdog = setTimeout(() => {
      if (!this.stopped && this.state.status !== 'live') {
        this.closeSocket();
        this.startPolling();
      }
    }, 6000);

    this.ws.onopen = () => {
      const sub = spec.subscribe?.(this.symbol);
      if (sub) this.ws?.send(sub);
      // Bybit closes a socket it has not heard from; keep it alive explicitly.
      if (spec.heartbeat) {
        this.beatId = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(spec.heartbeat!.message);
        }, spec.heartbeat.everyMs);
      }
    };
    this.ws.onmessage = (ev) => {
      if (this.stopped) return;
      let ticks: VenueTick[] | null = null;
      try {
        ticks = spec.parse(ev.data as string);
      } catch {
        return;
      }
      if (!ticks?.length) return;
      if (this.state.status !== 'live') this.emit({ status: 'live' });
      this.clearTimers();
      for (const tick of ticks) this.accept(tick);
    };
    this.ws.onerror = () => {
      if (!this.stopped && this.state.status !== 'live') this.startPolling();
    };
    this.ws.onclose = () => {
      if (!this.stopped) this.startPolling();
    };
  }

  private startPolling() {
    if (this.stopped || this.pollId) return;
    this.clearTimers();
    this.emit({ status: 'polling' });
    let misses = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/price?symbol=${encodeURIComponent(this.symbol)}`, {
          cache: 'no-store',
        });
        const j = (await res.json()) as { price: number | null };
        if (!j.price) throw new Error('no price');
        misses = 0;
        this.accept({ price: j.price, t: Date.now() });
      } catch {
        if (++misses >= 3) this.startDemo();
      }
    };
    void tick();
    this.pollId = setInterval(tick, POLL_MS);
  }

  /** Last resort so the prototype still demonstrates itself with no network at all. */
  private startDemo() {
    if (this.stopped || this.demoId) return;
    this.clearTimers();
    this.emit({ status: 'demo' });
    let p = this.tape.last || 100_000;
    let drift = 0;
    this.demoId = setInterval(() => {
      drift = drift * 0.98 + (Math.random() - 0.5) * 0.0004;
      p = Math.max(1, p * (1 + drift + (Math.random() - 0.5) * 0.0003));
      this.accept({ price: p, t: Date.now() });
    }, DEMO_MS);
  }

  private closeSocket() {
    if (this.beatId) clearInterval(this.beatId);
    this.beatId = null;
    const sock = this.ws;
    this.ws = null;
    if (!sock) return;
    sock.onmessage = null;
    sock.onerror = null;
    sock.onclose = null;
    try {
      // Closing mid-handshake makes the browser log a warning, so wait for the open.
      if (sock.readyState === WebSocket.CONNECTING) sock.onopen = () => sock.close();
      else sock.close();
    } catch {
      /* nothing to close */
    }
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.staleId) clearInterval(this.staleId);
    this.clearTimers();
    this.closeSocket();
    this.listeners.clear();
  }
}

export const FEED_LABEL: Record<FeedStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  stale: 'Stalled — reconnecting',
  polling: 'Live (polling)',
  demo: 'Demo prices',
  offline: 'Offline',
};
