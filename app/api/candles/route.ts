import type { Candle } from '@/lib/feed';

export const dynamic = 'force-dynamic';

/** Bybit returns [startMs, open, high, low, close, volume, turnover] as strings, newest first. */
type BybitKline = [string, string, string, string, string, string, string];
/** Binance returns [openTime, open, high, low, close, volume, closeTime, ...]. */
type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];
/** Coinbase returns [time, low, high, open, close, volume], newest first. */
type CoinbaseCandle = [number, number, number, number, number, number];

/**
 * Bybit linear perpetuals: real-time klines (the in-progress minute is included), every
 * USDT perp, and no key. This is the primary source — the app simulates a perpetual, so
 * the perp order book is the honest instrument to price it against.
 */
async function fromBybit(symbol: string, granularity: number): Promise<Candle[]> {
  const interval = granularity === 60 ? '1' : granularity === 300 ? '5' : '60';
  const res = await fetch(
    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=300`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`bybit ${res.status}`);
  const j = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: BybitKline[] } };
  if (j.retCode !== 0) throw new Error(`bybit ${j.retMsg}`);
  const rows = j.result?.list;
  if (!rows?.length) throw new Error('bybit empty');
  return rows
    .map(([t, o, h, l, c]) => ({
      t: Number(t),
      o: parseFloat(o),
      h: parseFloat(h),
      l: parseFloat(l),
      c: parseFloat(c),
    }))
    .sort((a, b) => a.t - b.t);
}

async function fromBinance(symbol: string, granularity: number): Promise<Candle[]> {
  const interval = granularity === 60 ? '1m' : granularity === 300 ? '5m' : '1h';
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=300`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const rows = (await res.json()) as BinanceKline[];
  if (!Array.isArray(rows) || !rows.length) throw new Error('binance empty');
  return rows.map(([t, o, h, l, c]) => ({
    t,
    o: parseFloat(o),
    h: parseFloat(h),
    l: parseFloat(l),
    c: parseFloat(c),
  }));
}

/** BTC only, and its candles lag a few minutes — a last resort. */
async function fromCoinbase(symbol: string, granularity: number): Promise<Candle[]> {
  if (symbol !== 'BTCUSDT') throw new Error('coinbase: BTC only here');
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}`,
    { cache: 'no-store', headers: { 'User-Agent': 'trace-prototype' } },
  );
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows = (await res.json()) as CoinbaseCandle[];
  if (!Array.isArray(rows) || !rows.length) throw new Error('coinbase empty');
  return rows
    .map(([time, low, high, open, close]) => ({
      t: time * 1000,
      o: open,
      h: high,
      l: low,
      c: close,
    }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Historical candles, proxied server-side so the browser never deals with CORS or with
 * one venue being unreachable from this network.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
  const granularity = Number(url.searchParams.get('granularity') ?? 60) || 60;
  const errors: string[] = [];
  for (const [source, load] of [
    ['bybit', fromBybit],
    ['binance', fromBinance],
    ['coinbase', fromCoinbase],
  ] as const) {
    try {
      const candles = await load(symbol, granularity);
      return Response.json(
        { source, symbol, candles },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return Response.json({ source: null, symbol, candles: [], errors }, { status: 502 });
}
