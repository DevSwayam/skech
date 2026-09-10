'use client';

import { useEffect, useRef } from 'react';
import { mountTrace } from '@/lib/trace-ui';

/**
 * The original prototype's markup, rendered once by React as *uncontrolled* inputs.
 * `mountTrace` then owns the DOM the way the single-file prototype did — this is a
 * canvas app whose panels are generated HTML, and fighting that with controlled state
 * is what makes a port drift away from the original's behaviour.
 */
export default function TraceApp() {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    return mountTrace(rootRef.current);
  }, []);

  return (
    <div className="app" ref={rootRef}>
      <header>
        <h1>Trace — draw a trade</h1>
        <span className="sub">
          Concept prototype for spec v4.2. Live perpetual prices, paper trading, no wallet, no orders.
        </span>
        <span className="feed-pill connecting" id="hdrFeed">
          <i />
          <span id="hdrFeedLabel">Connecting</span>
        </span>
        <span className="sub" id="hdrSym" />
        <span className="px" id="hdrPrice">
          —
        </span>
        <span className="chg" id="hdrChg" />
        <div className="state">
          Plan state{' '}
          <span id="stateBadge" className="badge">
            DRAFT
          </span>
        </div>
      </header>

      <aside className="config" aria-label="Configurator">
        <h2>Configurator</h2>
        <p className="small" id="liveCfgNote" hidden>
          Live: changes apply from the lock boundary onward. Margin changes count as transfers;
          leverage and sizing apply to the next leg.
        </p>
        <div className="group">
          <h3 data-info="secCanvas">Canvas and interpretation</h3>
          <div className="row">
            <label htmlFor="horizonN">Horizon</label>
            <span className="pair">
              <input
                id="horizonN"
                type="number"
                min="1"
                step="1"
                defaultValue="15"
                aria-label="Horizon amount"
              />
              <select id="horizonU" defaultValue="60" aria-label="Horizon unit">
                <option value="1">sec</option>
                <option value="60">min</option>
                <option value="3600">h</option>
              </select>
            </span>
          </div>
          <div className="row">
            <label htmlFor="columns">Time columns</label>
            <select id="columns" defaultValue="64">
              <option value="32">32 (coarse)</option>
              <option value="64">64</option>
              <option value="128">128 (fine)</option>
              <option value="256">256 (very fine)</option>
            </select>
          </div>
          <div className="row">
            <label />
            <span className="val" id="colWidthVal">
              1 column = 14 s
            </span>
          </div>
          <div className="row">
            <label htmlFor="lockSec">Order lock-in window (s)</label>
            <input id="lockSec" type="number" min="0" step="0.5" defaultValue="1" />
          </div>
          <div className="row">
            <label htmlFor="entryRule">Entry rule for each leg</label>
            <select id="entryRule" defaultValue="scheduled">
              <option value="scheduled">At the scheduled time (market)</option>
              <option value="limit">Pullback limit at the drawn price</option>
              <option value="breakout">Breakout stop through the drawn price</option>
            </select>
          </div>
          <div className="row">
            <label data-info="refPrice">Reference price</label>
            <span className="val" id="refPriceVal">
              live quote
            </span>
          </div>
          <div className="row">
            <label htmlFor="gapMin">Minimum gap (columns of 64)</label>
            <input id="gapMin" type="number" min="1" max="8" step="1" defaultValue="2" />
          </div>
          <div className="row">
            <label htmlFor="tolPct">Simplify tolerance (% of price)</label>
            <input id="tolPct" type="number" min="0.005" max="3" step="0.005" defaultValue="0.05" />
          </div>
          <div className="row">
            <label />
            <span className="val" id="tolVal">
              ±$38
            </span>
          </div>
          <div className="row">
            <label htmlFor="legBudget">Leg budget (0 = no cap)</label>
            <input id="legBudget" type="number" min="0" max="200" step="1" defaultValue="30" />
          </div>
          <div className="row">
            <label htmlFor="yRange">Price axis range (view only)</label>
            <input id="yRange" type="range" min="0.005" max="30" step="0.005" defaultValue="0.1" />
          </div>
          <div className="row">
            <label />
            <span className="val" id="yRangeVal">
              auto
            </span>
          </div>
          <div className="check">
            <label>
              <input id="showSwings" type="checkbox" defaultChecked /> Label swings (HH, HL, LH, LL)
              and slopes
            </label>
            <span data-info="swings" />
          </div>
          <div className="row">
            <label htmlFor="penSmooth">Pen smoothing</label>
            <input id="penSmooth" type="range" min="0" max="90" step="5" defaultValue="40" />
          </div>
          <div className="row">
            <label />
            <span className="val" id="penSmoothVal">
              40%
            </span>
          </div>
          <div className="check">
            <label>
              <input id="forwardOnly" type="checkbox" defaultChecked /> Forward-only pen (tip
              follows the pointer; time never runs back)
            </label>
            <span data-info="pen" />
          </div>
          <div className="check">
            <label>
              <input id="pauseWhileDrawing" type="checkbox" /> Pause the clock while redrawing live
            </label>
            <span data-info="pauseDraw" />
          </div>
        </div>

        <div className="group">
          <h3 data-info="secPlan">Plan controls</h3>
          <div className="row">
            <label htmlFor="margin">Allocated margin ($)</label>
            <input id="margin" type="number" min="10" step="10" defaultValue="100" />
          </div>
          <div className="row">
            <label data-info="leverage">Opening leverage</label>
            <div className="seg" role="group" aria-label="Leverage">
              {[1, 2, 3, 5, 10, 15].map((l) => (
                <button key={l} data-lev={l} aria-pressed={l === 3}>
                  {l}×
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <label data-info="sizing">Sizing mode</label>
            <div className="seg" role="group" aria-label="Sizing mode">
              <button id="sizeMargin" aria-pressed="true">
                Fixed margin
              </button>
              <button id="sizeRisk" aria-pressed="false">
                Risk at stop
              </button>
            </div>
          </div>
          <div className="row" data-mode="risk">
            <label htmlFor="riskPerLeg">Planned loss per leg ($)</label>
            <input id="riskPerLeg" type="number" min="0.5" step="0.5" defaultValue="10" />
          </div>
          <div className="row" data-mode="risk">
            <label htmlFor="stopPct">Stop distance from entry (%)</label>
            <input id="stopPct" type="number" min="0.1" step="0.1" defaultValue="5" />
          </div>
          <div className="row">
            <label data-info="notional">Notional per leg</label>
            <span className="val" id="notionalVal">
              $300
            </span>
          </div>
          <div className="row" data-mode="risk">
            <label>Margin required per leg</label>
            <span className="val" id="marginReqVal">
              —
            </span>
          </div>
          <div className="row">
            <label htmlFor="lossLimit">Plan loss limit ($)</label>
            <input id="lossLimit" type="number" min="0" step="1" defaultValue="30" />
          </div>
          <div className="row">
            <label htmlFor="tpTarget">Take profit ($, 0 = none)</label>
            <input id="tpTarget" type="number" min="0" step="1" defaultValue="20" />
          </div>
          <small>Take-profit and stop lines on the chart can also be dragged.</small>
        </div>

        <div className="group">
          <h3 data-info="secCosts">Venue costs</h3>
          <div className="row">
            <label htmlFor="feeRate">Taker fee per side (%)</label>
            <input id="feeRate" type="number" min="0" step="0.005" defaultValue="0.045" />
          </div>
          <div className="row">
            <label htmlFor="fundingRate">Funding rate per hour (%)</label>
            <input id="fundingRate" type="number" step="0.00025" defaultValue="0.00125" />
          </div>
          <div className="row">
            <label htmlFor="nextFunding">Next settlement in (min)</label>
            <input id="nextFunding" type="number" min="0" step="1" defaultValue="7" />
          </div>
          <div className="row">
            <label htmlFor="fundingInterval">Settlement interval (min)</label>
            <input id="fundingInterval" type="number" min="1" step="1" defaultValue="60" />
          </div>
          <div className="row">
            <label htmlFor="maintFrac">Maintenance margin (%)</label>
            <input id="maintFrac" type="number" min="0.1" step="0.05" defaultValue="1.25" />
          </div>
        </div>

        <div className="group">
          <h3 data-info="secMarket">Live market</h3>
          <div className="feed-row">
            <span className="k">Market</span>
            <select id="marketPick" className="btn" aria-label="Market to trade">
              <option value="BTCUSDT">BTC perp</option>
            </select>
          </div>
          <div className="feed-row">
            <span className="k">Moves</span>
            <span className="v" id="marketLively">
              —
            </span>
          </div>
          <div className="feed-row">
            <span className="k">Feed</span>
            <span className="feed-pill connecting" id="feedStatus">
              <i />
              <span id="feedStatusLabel">Connecting</span>
            </span>
          </div>
          <div className="feed-row">
            <span className="k">Source</span>
            <span className="v" id="feedSource">
              —
            </span>
          </div>
          <div className="feed-row">
            <span className="k">Last price</span>
            <span className="v" id="feedPrice">
              —
            </span>
          </div>
          <div className="feed-row">
            <span className="k">Ticks this session</span>
            <span className="v" id="feedTicks">
              0
            </span>
          </div>
          <small>
            Real prices: one-minute candles for history and a live trade stream on top, both from
            Bybit&rsquo;s perpetual book. Nothing is generated and nothing repeats — every run
            happens against whatever the market actually does next. The list is ranked by how far
            each market has travelled today, because a chart is only worth drawing on if the price
            moves inside the window you are planning over.
          </small>
          <div className="check">
            <label>
              <input id="outageOn" type="checkbox" /> Simulate an execution-service outage
            </label>
            <span data-info="outage" />
          </div>
          <div className="row">
            <label htmlFor="outageFrom">Outage from (min)</label>
            <input id="outageFrom" type="number" min="0" step="0.5" defaultValue="5" />
          </div>
          <div className="row">
            <label htmlFor="outageTo">Outage to (min)</label>
            <input id="outageTo" type="number" min="0" step="0.5" defaultValue="9" />
          </div>
          <small>
            During an outage, scheduled entries are skipped and scheduled closes run late.
            Venue-native stop, take-profit and liquidation still act.
          </small>
        </div>
      </aside>

      <main>
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Chart mode">
            <button
              id="modeLive"
              aria-pressed="true"
              title="The market moves from the start; draw ahead of now to place orders"
            >
              Live chart
            </button>
            <button
              id="modePlanFirst"
              aria-pressed="false"
              title="Draw a plan first, review it, then start the run"
            >
              Plan first
            </button>
          </div>
          <span data-info="chartMode" />
          <button id="liveStart" className="btn primary" hidden>
            Start live chart
          </button>
          <button id="liveStop" className="btn" hidden>
            Stop
          </button>
          <label className="check" id="armedWrap" hidden>
            <input id="armed" type="checkbox" defaultChecked /> Armed: drawings become orders after
            the lock window
          </label>
          <span id="restartNote" className="small" hidden>
            Horizon and columns apply to the next chart.{' '}
            <button id="restartNow" className="btn small">
              Restart with new settings
            </button>
          </span>
          <div className="steps" id="planSteps" aria-label="Phase">
            <span id="stepDraw" className="on">
              1 Draw
            </span>
            <span id="stepReview">2 Review</span>
            <span id="stepRun">3 Run</span>
          </div>
          <div className="seg mode" role="group" aria-label="How the drawing is read">
            <button id="modePath" aria-pressed="true">
              Follow my path
            </button>
            <button id="modeSingle" aria-pressed="false">
              Single trade
            </button>
          </div>
          <span id="modeHint" className="small" />
          <span data-info="mode" />
          <div id="runTools" className="seg" role="group" aria-label="Live tools" hidden>
            <button id="toolAdjust" aria-pressed="true">
              Adjust
            </button>
            <button id="toolErase" aria-pressed="false">
              Erase
            </button>
            <button id="toolDraw" aria-pressed="false">
              Sketch
            </button>
            <button id="toolPan" aria-pressed="false">
              Pan
            </button>
          </div>
          <button id="flattenBtn" className="btn" hidden>
            Go flat from the boundary
          </button>
          <span data-info="lockSec" id="liveInfo" hidden />
          <span className="spacer" />
          <select
            id="examples"
            className="btn"
            defaultValue=""
            aria-label="Load a pattern from the library"
          >
            <option value="">Pattern library…</option>
            <optgroup label="Trend">
              <option value="up">Single trend leg (long)</option>
              <option value="uptrend">Uptrend: higher highs, higher lows</option>
              <option value="downtrend">Downtrend: lower highs, lower lows</option>
              <option value="staircase">Staircase (step up, pause, step up)</option>
            </optgroup>
            <optgroup label="Reversal">
              <option value="v">V bottom</option>
              <option value="spike">Inverted V (spike top)</option>
              <option value="w">W / double bottom</option>
              <option value="m">M / double top</option>
              <option value="hs">Head and shoulders top</option>
              <option value="ihs">Inverse head and shoulders</option>
              <option value="saucer">Rounded bottom (saucer)</option>
            </optgroup>
            <optgroup label="Continuation">
              <option value="bullflag">Bull flag: pullback then continuation</option>
              <option value="bearflag">Bear flag</option>
              <option value="breakout">Breakout from a range</option>
              <option value="retest">Breakout, pullback, retest</option>
            </optgroup>
            <optgroup label="Range and timing">
              <option value="chop">Sideways chop (range)</option>
              <option value="gap">Sit out the middle (gap)</option>
              <option value="late">Start later, end early</option>
              <option value="zigzag">Overtrading zigzag</option>
            </optgroup>
          </select>
          <button id="undo" className="btn">
            Undo stroke
          </button>
          <button id="clear" className="btn">
            Clear
          </button>
        </div>

        <div className="canvas-wrap">
          <canvas id="chart" width="1200" height="560" aria-label="Drawing canvas" />
          <div id="hint" className="hint">
            Draw your plan. Rising means long, falling means short, lifting the pen means flat.
          </div>
          <div id="fsHud" className="fs-hud" hidden>
            <div className="fs-state">
              <span id="fsBadge" className="badge">
                —
              </span>
              <span id="fsTime" className="small">
                0:00
              </span>
            </div>
            <div className="fs-grid">
              <div>
                Price<b id="fsPrice">—</b>
              </div>
              <div>
                Position<b id="fsPos">flat</b>
              </div>
              <div>
                Equity<b id="fsEq">—</b>
              </div>
              <div>
                Net P&amp;L<b id="fsPnl">—</b>
              </div>
              <div>
                Eff. leverage<b id="fsLev">—</b>
              </div>
              <div>
                Equity ink<b id="fsInk">—</b>
                <div className="ink">
                  <span id="fsInkBar" style={{ width: '100%' }} />
                </div>
              </div>
            </div>
          </div>
          <div id="fsTop" className="fs-bar fs-top" hidden>
            <button id="fsExit" className="btn small">
              Exit full screen
            </button>
          </div>
          <div id="fsBottom" className="fs-bar fs-bottom" hidden />
        </div>

        <div className="viewbar">
          <div className="viewctl" role="group" aria-label="Chart view">
            <button id="vtOut" title="Zoom out in time (or scroll)">
              −
            </button>
            <span className="vl">time</span>
            <button id="vtIn" title="Zoom in in time (or scroll)">
              +
            </button>
            <button id="vpOut" title="Widen the price range (or shift + scroll)">
              −
            </button>
            <span className="vl">price</span>
            <button id="vpIn" title="Narrow the price range (or shift + scroll)">
              +
            </button>
            <button id="vLeft" title="Pan earlier">
              ◂
            </button>
            <button id="vRight" title="Pan later">
              ▸
            </button>
            <button id="vUp" title="Pan up">
              ▴
            </button>
            <button id="vDown" title="Pan down">
              ▾
            </button>
            <button id="vFit" title="Fit the drawing">
              Fit
            </button>
            <button id="vReset" title="Reset the view">
              Reset
            </button>
            <button id="vFollow" title="Keep now in view as the chart moves" aria-pressed="true">
              Follow
            </button>
            <button id="vFull" title="Full-screen chart (Esc to leave)">
              Full screen
            </button>
          </div>
          <div id="viewLabel" className="viewlabel" />
        </div>

        <div id="patternNote" className="small pattern-note" hidden />

        <div className="legend">
          <span>
            <i style={{ borderColor: 'var(--graphite)' }} />
            Your sketch
          </span>
          <span>
            <i style={{ borderColor: 'var(--blue)', borderTopWidth: '5px' }} />
            Executable legs and equity ink
          </span>
          <span>
            <i style={{ borderColor: 'rgba(46,79,216,.45)', borderTopWidth: '2px' }} />
            Sampled path (dashed where a pen lift was bridged)
          </span>
          <span>
            <i className="hatch" />
            Flat: no position
          </span>
          <span>
            <i style={{ borderColor: 'var(--ink)' }} />
            Actual market
          </span>
          <span>
            <i className="dash" style={{ borderColor: 'var(--long)' }} />
            Take profit
          </span>
          <span>
            <i className="dash" style={{ borderColor: 'var(--short)' }} />
            Stop and liquidation
          </span>
        </div>

        <div className="playbar">
          <button id="play" className="btn" disabled>
            Live
          </button>
          <input
            id="scrub"
            type="range"
            min="0"
            max="900"
            step="0.5"
            defaultValue="0"
            disabled
            aria-label="Review time"
          />
          <span className="t" id="scrubT">
            0:00 / 15:00
          </span>
          <span className="small" id="scrubNote" />
        </div>

        <div id="queue" className="queue" hidden />

        <div className="live">
          <div>
            Price<b id="lvPrice">—</b>
          </div>
          <div>
            Position<b id="lvPos">flat</b>
          </div>
          <div>
            Equity<b id="lvEquity">—</b>
          </div>
          <div>
            Net P&amp;L<b id="lvPnl">—</b>
          </div>
          <div>
            Effective leverage<b id="lvLev">—</b>
          </div>
          <div>
            Equity ink<b id="lvInk">—</b>
            <div className="ink">
              <span id="inkBar" style={{ width: '100%' }} />
            </div>
          </div>
        </div>
      </main>

      <aside className="side" aria-label="Review and results">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected="true" data-tab="review">
            Review
          </button>
          <button role="tab" aria-selected="false" data-tab="results">
            Results
          </button>
          <button role="tab" aria-selected="false" data-tab="ledger">
            Ledger
          </button>
          <button role="tab" aria-selected="false" data-tab="guide" id="guideTab">
            Guide
          </button>
          <button role="tab" aria-selected="false" data-tab="terms">
            Terms
          </button>
        </div>
        <section id="tab-review" className="panel on" />
        <section id="tab-results" className="panel">
          <p className="small">Results appear after the run finishes.</p>
        </section>
        <section id="tab-ledger" className="panel">
          <p className="small">Fills and events appear here during the run.</p>
        </section>
        <section id="tab-guide" className="panel" />
        <section id="tab-terms" className="panel" />
      </aside>
    </div>
  );
}
