export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** m:ss, the only time format the prototype uses. */
export function fmtT(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtUSD(x: number, signed?: boolean) {
  const a = Math.abs(x);
  const s = a >= 1000 ? a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a.toFixed(2);
  return (x < 0 ? '−$' : signed && x > 0 ? '+$' : '$') + s;
}

export function fmtUSD0(x: number) {
  const a = Math.abs(x);
  const s = Number.isInteger(+a.toFixed(6)) ? a.toLocaleString('en-US') : a.toFixed(2);
  return (x < 0 ? '−$' : '$') + s;
}

/** Adaptive precision: the market picker spans five-figure BTC down to cent-priced perps. */
export function fmtPrice(p: number) {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return (
    '$' +
    p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
  );
}

/** m:ss, signed, for an axis that now extends into the history before the session. */
export function fmtTSigned(sec: number) {
  return (sec < -0.5 ? '−' : '') + fmtT(Math.abs(sec));
}

export function fmtDur(sec: number) {
  return sec < 60
    ? `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`
    : sec < 3600
      ? `${(sec / 60).toFixed(sec % 60 ? 1 : 0)} min`
      : `${(sec / 3600).toFixed(1)} h`;
}

export function labelReason(r: string | null) {
  return (
    (
      {
        target_reached: 'take profit reached',
        stopped: 'stop hit at the loss limit',
        loss_limit: 'loss limit reached at a close',
        liquidated: 'liquidated',
        time_exit: 'time exit',
        reversal: 'reversal',
        scheduled: 'scheduled close',
        late: 'late close after outage',
        redraw: 'closed by redraw',
        no_legs: 'no executable legs',
      } as Record<string, string>
    )[r ?? ''] || r
  );
}

export const TURN_WORDS: Record<string, string> = {
  SH: 'swing high',
  SL: 'swing low',
  HH: 'higher high',
  LH: 'lower high',
  HL: 'higher low',
  LL: 'lower low',
};
