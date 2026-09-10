# Trace — draw a trade

The v4.2 concept prototype, as a Next.js app, running against the **live BTC/USD price**.

Draw a line on the chart. Trace reads the drawing as a set of scheduled orders — one leg
per straight stretch, a flat wherever you lift the pen — and executes them against the
real market with paper money. You can keep redrawing while it runs; anything past the
lock boundary is still yours to change.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm build && pnpm start
pnpm typecheck
```

---

## What changed from the single-file prototype

The UI is the original: same three-column layout, same configurator, same
Review / Results / Ledger / Terms panels, same canvas, same ⓘ popover on every field,
same pattern library, same exports. `reference/index.original.html` is kept for
comparison. Three deliberate differences:

**1. The market is real.** The synthetic generator is gone, and with it the scenario,
move, noise and seed controls. In their place the configurator has a **Live market**
group showing the venue, socket health, price and tick count. History is one-minute
candles from Binance klines (Coinbase as fallback), proxied through `/api/candles` so the
browser never deals with CORS; the live socket then opens on **whichever venue served the
history**, because BTC-USD and BTCUSDT differ by a few dollars and mixing them would put
a visible step in the chart where live data begins. If the socket cannot connect it polls
`/api/price`; if that fails too it falls back to a synthetic walk and says `Demo prices`
in the header. The execution-service **outage** simulation is still there — that models
your scheduler failing, not the market.

**2. Time is the wall clock.** There is no playback speed and no seeking forward, because
there is nothing ahead to seek to. The playbar scrubber reviews what has already happened
and **Live** returns to now; while you are reviewing the past, the canvas is pan-only.

**3. Nothing can be replayed.** There is no seed, so the same drawing tried twice meets
two different markets. The leverage comparison in Results and the video/JSON exports
replay against the *recorded* tape — the prices this run actually met.

**Added:** a **Guide** tab (nine illustrated steps, drawn with the same SVG DSL as the ⓘ
popovers) and a first-run coach-mark walkthrough that ends by opening it.

## Two defaults that had to move

The prototype was tuned for a synthetic market that travelled 6% in fifteen minutes. Real
BTC covers a few tenths of a percent in half an hour, so two original defaults would have
made the app non-functional. Both are still editable fields, and only the default changed:

| Field | Was | Now | Why |
| --- | --- | --- | --- |
| Simplify tolerance | 0.25% of price | **derived from the market** (min 0.001) | 0.25% of $77k is $192. Every realistic drawing was smaller than that, so every plan compiled to "flat" and nothing traded. It is now set from the range of the last three minutes — 5% of it — because the threshold for "this turn was deliberate" belongs on the timescale you draw at, not the timescale of a day. Deriving it from the *daily* range was a real regression: on a perp ranging 13% a day it came out at $3 and silently ate every swing of a zigzag, so a clean six-swing drawing compiled to zero legs and read as flat. Editing the field yourself stops the market setting it. |
| Price axis range | ±15% | **±0.4%** (min 0.1) | Display only — it never moves an order. At ±15% a real session is a flat line across the middle of the chart. |
| Time columns | 64 | **256** | The grid the drawing is quantised onto. Each column keeps one price — the midpoint of what the stroke covered inside it — so a feature narrower than a column is averaged away. At 64 columns over a fifteen-minute horizon a column is 14 seconds, while the chart is zoomed to a three-minute window where 14 seconds is a fifth of an inch: whole zigzag swings landed inside one column and vanished. An eight-swing zigzag compiled to four legs, a ten-swing one to two, and shifting the drawing sideways by half a column changed the answer. At 256 the column is 3.5 seconds and an *n*-swing zigzag compiles to *n* legs. |
| Minimum gap | 2 columns | **8 columns** | Purely to hold the two thresholds that are measured in columns — wobble absorption and gap-to-flat — at the same *duration* after the grid got four times finer. 8 × 3.5s = 28s, exactly 2 × 14s. |

Everything else keeps its original default, including the $30 plan loss limit and the $20
take profit. Worth knowing what those mean here: $30 against $300 of exposure is a 10% BTC
move, which will not happen inside half an hour, so at the default they are effectively no
stop and no target. The Review panel prints the trigger price and the percentage for each,
so the consequence is visible rather than implied.

## Layout

```
app/
  page.tsx / layout.tsx     entry; IBM Plex Sans via next/font
  globals.css               the prototype's stylesheet verbatim, plus feed + guide styles
  api/candles/route.ts      1-minute candle history (Binance → Coinbase)
  api/price/route.ts        last price, for the polling fallback
components/
  TraceApp.tsx              the original markup as JSX, uncontrolled, mounted once
lib/
  trace-ui.ts               the UI controller: config, panels, canvas, tools, exports
  trace-core.ts             the engine: intent compiler + simulator (no DOM, no React)
  trace-info.ts             ⓘ popovers — the SVG mini-chart DSL, INFO and GLOSS
  trace-guide.ts            the Guide tab and the coach marks
  live-feed.ts              LiveFeed: history, websocket, polling and demo fallbacks
  feed.ts                   PriceTape (ticks + candles) and the per-venue socket specs
  patterns.ts               the twenty pattern-library shapes
  types.ts / format.ts
reference/
  index.original.html       the single-file prototype
```

### Why the controller is imperative

`TraceApp.tsx` renders the original DOM once, as uncontrolled inputs, and `mountTrace`
owns it from there. That is deliberate. This is a canvas app whose side panels are
generated HTML, and an earlier attempt to hold all of it in React state drifted away from
the original's behaviour. Keeping the controller imperative is what makes "the same as the
prototype" verifiable.

The one thing this costs: every listener must be removed on teardown, because React
invokes effects twice in development. All of them are registered against a single
`AbortController` signal, and the ⓘ buttons the popover module injects are tracked so they
can be removed too. Without that, a torn-down instance keeps handling pointer events and
writing panels — which showed up as a plan quoting $100,000 prices while the feed was at
$77,000.

## Two failure modes the feed forced us to handle

**A socket can go quiet without closing.** A sleeping laptop or a changed network leaves a
half-open websocket that delivers nothing and never fires `close` or `error`. Left alone
the chart freezes while the header still says "Live", which is the most misleading state
the app could be in. `LiveFeed` watches the time since the last tick and, after fifteen
seconds of silence, shows **Stalled — reconnecting** and rebuilds the connection.

**The seeded price has to sit in the past.** History's final candle is usually the
*in-progress* minute, so its close time is up to sixty seconds in the future. Seeding the
tape at that timestamp made it the newest tick, so `push` clamped every arriving live tick
onto it and `at()` answered one frozen price for the whole first minute — a dead-flat
chart, and a simulator trading against a market that never moved. The seed is now pinned
to `t <= 0`, which is all it ever meant: the price as the session began.

**The lock boundary must come from the wall clock.** It used to be derived from
`sim.tNow`, the simulator's stepped position, which only advances inside the animation
loop — and browsers throttle that loop in a background or occluded tab. Coming back to a
throttled tab and drawing immediately placed the stroke against a stale boundary, so it
landed in what was already the past and the next replan silently discarded it: no
position, an empty order queue, and no explanation. The boundary now takes the later of
the wall clock and the simulator, an edit syncs both before reading it, and Review warns
outright if a drawing has ended up behind now.

## Closing a position

While a position is open, a red disc with a white cross sits at the right-hand edge of
the plot, tracking the price the position is carrying. Clicking it goes flat from the
lock boundary — the same thing the *Go flat from the boundary* button does, which stays
in the toolbar. Hovering names what will be closed.

It began next to the lock boundary, which is where the close actually takes effect, and
that turned out to be the worst place for it: the boundary is surrounded by the price
line and the equity ink, and the disc disappeared into them. The right edge is the one
part of the plot that is reliably empty. Only a *pointerdown* on the disc closes, so a
stroke dragged across it on the way somewhere else is unaffected, and it is drawn last
so nothing can cover it.

## Honest limits

Prices are real; the execution is not. Fills happen at exactly the price asked for, which
no exchange can promise — real fills slip, and a fast market can jump straight through a
stop. Fees, funding and the liquidation estimate are simplified constants. There is no
wallet, no exchange and no order that leaves the browser.
