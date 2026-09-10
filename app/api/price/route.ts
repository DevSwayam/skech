export const dynamic = 'force-dynamic';

async function fromBybit(symbol: string) {
  const res = await fetch(
    `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`bybit ${res.status}`);
  const j = (await res.json()) as {
    retCode: number;
    result?: { list?: { lastPrice?: string }[] };
  };
  const price = parseFloat(j.result?.list?.[0]?.lastPrice ?? '');
  if (!Number.isFinite(price)) throw new Error('bybit no price');
  return price;
}

async function fromBinance(symbol: string) {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const j = (await res.json()) as { price?: string };
  const price = parseFloat(j.price ?? '');
  if (!Number.isFinite(price)) throw new Error('binance no price');
  return price;
}

async function fromCoinbase(symbol: string) {
  if (symbol !== 'BTCUSDT') throw new Error('coinbase: BTC only here');
  const res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
    cache: 'no-store',
    headers: { 'User-Agent': 'trace-prototype' },
  });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const j = (await res.json()) as { price?: string };
  const price = parseFloat(j.price ?? '');
  if (!Number.isFinite(price)) throw new Error('coinbase no price');
  return price;
}

/** Last price, used as the polling fallback when the websocket cannot connect. */
export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
  for (const load of [fromBybit, fromBinance, fromCoinbase]) {
    try {
      const price = await load(symbol);
      return Response.json({ price, symbol, t: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      // try the next venue
    }
  }
  return Response.json({ price: null, symbol }, { status: 502 });
}
