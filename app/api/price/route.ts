export const dynamic = 'force-dynamic';

async function fromCoinbase() {
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

async function fromBinance() {
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const j = (await res.json()) as { price?: string };
  const price = parseFloat(j.price ?? '');
  if (!Number.isFinite(price)) throw new Error('binance no price');
  return price;
}

/** Last trade price, used as the polling fallback when the websocket cannot connect. */
export async function GET() {
  for (const load of [fromBinance, fromCoinbase]) {
    try {
      const price = await load();
      return Response.json({ price, t: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      // try the next venue
    }
  }
  return Response.json({ price: null }, { status: 502 });
}
