import { C, chart } from './trace-info';

type Pt = [number, number];

const wobble = (a: Pt, b: Pt, n = 24, amp = 0.03, f = 40): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + amp * Math.sin(u * f)];
  });

interface Step {
  title: string;
  body: string;
  svg?: () => string;
}

const STEPS: Step[] = [
  {
    title: 'Draw what you think BTC does next',
    body: 'The chart is the real BTC/USD price. The vertical line is <b>now</b>; everything to the right of it is empty, because it has not happened yet. Drag across that empty space to draw the shape you expect. A stroke going <b>up</b> is a <b>long</b> (you profit if price rises). A stroke going <b>down</b> is a <b>short</b>. Lifting the pen leaves a gap, and a gap means you hold nothing.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(wobble([0, 0.5], [0.4, 0.46], 20, 0.04, 50), { color: C.ink, width: 1.6 })
          .vline(0.4, { label: 'now' })
          .path([[0.4, 0.46], [0.68, 0.82]], { color: C.blue })
          .dot(0.4, 0.46, { color: C.long, shape: 'up', label: 'long' })
          .path([[0.72, 0.82], [1, 0.5]], { color: C.blue })
          .dot(0.72, 0.82, { color: C.short, shape: 'down', label: 'short' }),
      ),
  },
  {
    title: 'Every turn becomes one scheduled leg',
    body: 'Trace samples your stroke into time columns, throws away wobble smaller than the simplify tolerance, and turns what is left into <b>legs</b>: one trade per straight stretch. Draw up then down and you get two legs — a long, then a short that reverses it. The thin grey line is what you drew; the bold blue spine is what will actually trade. The <b>Review</b> tab lists every leg in words.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(
            [[0, 0.5], [0.08, 0.42], [0.16, 0.6], [0.24, 0.38], [0.33, 0.68], [0.42, 0.3], [0.5, 0.62], [0.58, 0.45], [0.66, 0.58], [0.75, 0.35], [0.83, 0.7], [0.92, 0.52], [1, 0.6]],
            { color: C.graphite, width: 1.5 },
          )
          .path([[0, 0.5], [0.42, 0.3], [0.83, 0.7], [1, 0.6]])
          .text(0.04, 0.9, 'grey: your sketch', { color: C.muted })
          .text(0.04, 0.82, 'blue: the legs that trade', { color: C.blue, bold: true }),
      ),
  },
  {
    title: 'Nothing trades until you say so',
    body: 'In <b>Live chart</b> mode the clock is already running, and a drawing becomes an order only while <b>Armed</b> is ticked. In <b>Plan first</b> mode you draw on a still canvas, read the Review tab, and press <b>Authorize and run</b>. Either way this is paper money: there is no wallet and no exchange, and no order ever leaves your browser.',
  },
  {
    title: 'The past is frozen; the future is still yours',
    body: 'Once the run is going, the chart has three regions. Left of <b>now</b> is executed and cannot change. The narrow amber band is the <b>lock window</b> — already sent to the venue. Everything right of that boundary is still editable, and the plan updates the moment you let go.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .band(0, 0.45, { solid: '#1B2431', alpha: 0.05, label: 'executed' })
          .band(0.45, 0.55, { solid: '#9A6200', alpha: 0.18, label: 'locked', textColor: C.amber })
          .path([[0, 0.5], [0.45, 0.62]], { color: C.ink, width: 2 })
          .path([[0.55, 0.64], [0.8, 0.8], [1, 0.7]], { dash: '6 4' })
          .text(0.58, 0.3, 'editable: redraw, erase, adjust', { color: C.blue, bold: true })
          .vline(0.55, { color: C.amber, dash: '1 0' }),
      ),
  },
  {
    title: 'Four tools while it runs',
    body: '<b>Adjust</b> turns every future turn into a draggable handle, and lets you drag the green take-profit and red stop lines. <b>Erase</b> cuts the plan: click to cut from there to the end, or drag to remove a range. <b>Sketch</b> draws a new shape that replaces the plan from where you start. <b>Pan</b> moves the view without touching orders. <span class="kbd">Undo stroke</span> and <span class="kbd">Clear</span> work on the editable future.',
    svg: () =>
      chart((ch) => {
        ch.grid().path([[0.05, 0.4], [0.36, 0.85], [0.64, 0.45], [0.95, 0.8]]);
        ([[0.36, 0.85], [0.64, 0.45], [0.95, 0.8]] as Pt[]).forEach(([u, v]) =>
          ch.dot(u, v, { color: C.blue }),
        );
        ch.text(0.3, 0.98, 'drag a handle to move a turn', { color: C.blue, bold: true });
      }),
  },
  {
    title: 'Your two safety rails',
    body: 'The <b>take profit</b> ends the plan as soon as you are up by that many dollars; the <b>plan loss limit</b> ends it if you are down by that much. Both are dollar amounts, and both are drawn on the chart so you can see the price they need. Watch that price: $30 against $300 of exposure is a 10% BTC move, which will not happen in half an hour — a limit that far away is not really a stop.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .hline(0.85, { color: C.long, label: 'take profit', left: true })
          .hline(0.18, { color: C.short, label: 'plan loss limit', below: true, left: true })
          .dot(0.1, 0.5, { color: C.long, shape: 'up', label: 'entry' })
          .path([[0.1, 0.5], [0.5, 0.62], [0.82, 0.85]], { color: C.ink, width: 2 })
          .dot(0.82, 0.85, { color: C.long }),
      ),
  },
  {
    title: 'The market is real, so nothing repeats',
    body: 'History is real one-minute candles and the live price is a real trade stream, both from the same venue. That means a run cannot be replayed: the same drawing tried twice meets two different markets, and there is no seed to hold it still. The <b>Live market</b> group in the configurator shows which venue is feeding you and whether the socket is healthy.',
    svg: () =>
      chart((ch) =>
        ch
          .grid()
          .path(wobble([0, 0.5], [0.5, 0.44], 24, 0.05, 60), { color: C.ink, width: 1.6 })
          .vline(0.5, { label: 'now' })
          .band(0.5, 1, { solid: '#000', alpha: 0.03, label: 'not yet known' })
          .text(0.03, 0.9, 'real candles, then live trades', { color: C.ink, bold: true }),
      ),
  },
  {
    title: 'Two numbers worth understanding first',
    body: 'BTC only travels a few tenths of a percent in half an hour, which makes two settings matter more than the rest. <b>Simplify tolerance</b> is how big a move must be to count as a leg — the dollar value is printed under the field, and setting it too high makes the whole drawing read as flat. <b>Price axis range</b> is display only, but at ±15% a real BTC session looks like a flat line; a few tenths of a percent is what makes it legible.',
  },
  {
    title: 'What it does not model',
    body: 'Prices are real; the execution is not. Fills here happen at exactly the price you asked for, which no exchange can promise — real fills slip, and a fast market can jump straight through a stop. Funding, fees and the liquidation estimate are simplified constants from a public schedule. Treat a good result here as practice, not as evidence.',
  },
];

export function guideHtml() {
  return (
    `<h2>How Trace works</h2>` +
    `<p class="guide-intro">You draw a line on a live BTC chart. Trace reads the drawing as a set of scheduled orders and runs them against the real price, with paper money. Nine things to know:</p>` +
    STEPS.map(
      (s, i) =>
        `<section class="guide-step"><h4><i>${i + 1}</i>${s.title}</h4><p>${s.body}</p>${s.svg ? s.svg() : ''}</section>`,
    ).join('') +
    `<section class="guide-step"><h4>Reading the chart</h4><p>The legend under the chart names every mark, and the <b>Terms</b> tab explains the trading vocabulary with a diagram each. Hover the ⓘ next to any configurator field for what that field does.</p></section>`
  );
}

// ---------- first-run coach marks ----------

const FLAG = 'trace.guide.seen.v1';

interface Coach {
  target: string;
  title: string;
  body: string;
  side?: 'below' | 'above' | 'left' | 'inside-bottom';
}

const COACH: Coach[] = [
  {
    target: '.canvas-wrap',
    title: 'This is the real BTC price',
    body: 'The clock is already running. Drag across the empty space to the right of the now line to draw what you think price will do — up is a long, down is a short.',
    side: 'inside-bottom',
  },
  {
    target: '.toolbar',
    title: 'Draw, or load a shape',
    body: 'Pattern library fills in a classic shape so you can see how a drawing turns into legs. While the run is going, the Adjust / Erase / Sketch / Pan tools appear here.',
    side: 'below',
  },
  {
    target: 'aside.config',
    title: 'Everything is adjustable',
    body: 'How the drawing is read, how much you risk, what the venue charges, and which feed you are on. Hover the ⓘ next to any field for a diagram of what it does.',
    side: 'left',
  },
  {
    target: '.tabs',
    title: 'Review, then the Guide',
    body: 'Review says what your drawing means in words, with warnings. Ledger shows fills as they happen. The Guide tab has the full walkthrough whenever you want it.',
    side: 'below',
  },
];

/** Returns a teardown function. Does nothing if the user has already seen it. */
export function mountCoachMarks(onOpenGuide: () => void) {
  let seen = false;
  try {
    seen = localStorage.getItem(FLAG) === '1';
  } catch {
    seen = false;
  }
  if (seen) return () => {};

  let step = 0;
  const ring = document.createElement('div');
  ring.className = 'coach-ring';
  const card = document.createElement('div');
  card.className = 'coach';
  card.setAttribute('role', 'dialog');
  document.body.append(ring, card);

  const done = () => {
    try {
      localStorage.setItem(FLAG, '1');
    } catch {
      /* private mode: just move on */
    }
    teardown();
  };

  function place() {
    const s = COACH[step];
    const el = document.querySelector(s.target);
    if (!el) {
      ring.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    ring.hidden = false;
    ring.style.top = `${r.top - 5}px`;
    ring.style.left = `${r.left - 5}px`;
    ring.style.width = `${r.width + 10}px`;
    ring.style.height = `${r.height + 10}px`;

    const cw = Math.min(330, window.innerWidth - 24);
    const chh = card.offsetHeight || 170;
    let left: number;
    let top: number;
    if (s.side === 'inside-bottom') {
      left = r.left + 16;
      top = r.top + r.height - chh - 16;
    } else if (s.side === 'left') {
      left = r.left - cw - 14;
      top = r.top + 8;
      if (left < 12) left = Math.max(12, r.left + 12);
    } else if (s.side === 'above') {
      left = r.left + 8;
      top = r.top - chh - 12;
    } else {
      left = r.left + 16;
      top = r.bottom + 12;
    }
    if (top + chh > window.innerHeight - 12) top = Math.max(12, r.top - chh - 12);
    if (top < 12) top = 12;
    if (left + cw > window.innerWidth - 12) left = Math.max(12, window.innerWidth - cw - 12);
    card.style.width = `${cw}px`;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function render() {
    const s = COACH[step];
    const last = step === COACH.length - 1;
    card.innerHTML =
      `<h4>${s.title}</h4><p>${s.body}</p>` +
      `<footer><span class="dots">${COACH.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</span>` +
      `<button class="btn small quiet" data-act="skip">Skip</button>` +
      (step > 0 ? `<button class="btn small" data-act="back">Back</button>` : '') +
      `<button class="btn small primary" data-act="next">${last ? 'Open the guide' : 'Next'}</button></footer>`;
    card.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'skip') done();
        else if (act === 'back') {
          step--;
          render();
          place();
        } else if (last) {
          done();
          onOpenGuide();
        } else {
          step++;
          render();
          place();
        }
      };
    });
    place();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') done();
  };
  const onResize = () => place();
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize, true);

  function teardown() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    ring.remove();
    card.remove();
  }

  // Let the layout settle before measuring.
  requestAnimationFrame(render);
  return teardown;
}
