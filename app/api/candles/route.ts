import type { Candle } from '@/lib/feed';

export const dynamic = 'force-dynamic';

/** Coinbase returns [time, low, high, open, close, volume], newest first. */
type CoinbaseCandle = [number, number, number, number, number, number];

/** Binance returns [openTime, open, high, low, close, volume, closeTime, ...]. */
type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];

async function fromCoinbase(granularity: number): Promise<Candle[]> {
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}`,
    { cache: 'no-store', headers: { 'User-Agent': 'trace-prototype' } },
  );
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows = (await res.json()) as CoinbaseCandle[];
  if (!Array.isArray(rows) || !rows.length) throw new Error('coinbase empty');
  return rows
    .map(([time, low, high, open, close]) => ({ t: time * 1000, o: open, h: high, l: low, c: close }))
    .sort((a, b) => a.t - b.t);
}

async function fromBinance(granularity: number): Promise<Candle[]> {
  const interval = granularity === 60 ? '1m' : granularity === 300 ? '5m' : '1h';
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=300`,
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

/**
 * Historical BTC candles, proxied server-side so the browser never has to care about
 * CORS or which venue happens to be reachable from this network.
 */
export async function GET(req: Request) {
  const granularity = Number(new URL(req.url).searchParams.get('granularity') ?? 60) || 60;
  const errors: string[] = [];
  // Binance klines include the in-progress minute; Coinbase's candles run a few
  // minutes behind, which would leave a hole between history and the live ticks.
  for (const [source, load] of [
    ['binance', fromBinance],
    ['coinbase', fromCoinbase],
  ] as const) {
    try {
      const candles = await load(granularity);
      return Response.json(
        { source, candles },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return Response.json({ source: null, candles: [], errors }, { status: 502 });
}
