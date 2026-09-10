export const dynamic = 'force-dynamic';

export interface MarketRow {
  symbol: string;
  label: string;
  last: number;
  change24hPct: number;
  turnover24h: number;
  fundingRatePct: number;
  /** Rough per-minute travel over the last day, in percent — how lively it is to trade. */
  livelinessPct: number;
}

interface BybitTicker {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  turnover24h: string;
  fundingRate?: string;
  highPrice24h: string;
  lowPrice24h: string;
}

/** Enough turnover that a paper fill at the last price is not a fantasy. */
const MIN_TURNOVER = 40_000_000;

/**
 * The tradeable market list, ranked by how much they actually move.
 *
 * A chart is only worth drawing on if the price does something inside the window you
 * are planning over. BTC covers a few tenths of a percent in half an hour; the livelier
 * perps cover that in under a minute. This ranks by intraday range rather than by market
 * cap so the default is something worth watching, and filters on turnover so the fills
 * stay plausible.
 */
export async function GET() {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`bybit ${res.status}`);
    const j = (await res.json()) as { retCode: number; result: { list: BybitTicker[] } };
    if (j.retCode !== 0) throw new Error(`bybit retCode ${j.retCode}`);

    const rows: MarketRow[] = j.result.list
      .filter((r) => r.symbol.endsWith('USDT') && Number(r.turnover24h) > MIN_TURNOVER)
      .map((r) => {
        const last = Number(r.lastPrice);
        const hi = Number(r.highPrice24h);
        const lo = Number(r.lowPrice24h);
        const rangePct = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
        return {
          symbol: r.symbol,
          label: r.symbol.replace(/USDT$/, '') + ' perp',
          last,
          change24hPct: Number(r.price24hPcnt) * 100,
          turnover24h: Number(r.turnover24h),
          fundingRatePct: Number(r.fundingRate ?? 0) * 100,
          livelinessPct: rangePct,
        };
      })
      // Keep only prices a dollar-denominated chart can show.
      .filter((r) => r.last >= 0.01 && Number.isFinite(r.livelinessPct))
      // Rank by movement *discounted by thinness*. A 78% range on $47M of turnover is
      // not a market you could actually get filled in, so liquidity has to temper the
      // ranking or the default lands on something untradeable.
      .sort(
        (a, b) =>
          b.livelinessPct * Math.min(1, b.turnover24h / 3e8) -
          a.livelinessPct * Math.min(1, a.turnover24h / 3e8),
      );

    const top = rows.slice(0, 14);
    // BTC is the reference everyone knows; keep it available even when it is asleep.
    if (!top.some((r) => r.symbol === 'BTCUSDT')) {
      const btc = rows.find((r) => r.symbol === 'BTCUSDT');
      if (btc) top.push(btc);
    }
    return Response.json({ markets: top }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { markets: [], error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
