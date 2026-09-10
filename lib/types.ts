export type Scenario = 'random' | 'up' | 'down' | 'v' | 'spike' | 'chop';
export type EntryRule = 'scheduled' | 'limit' | 'breakout';
export type ReadMode = 'path' | 'single';
export type SizingMode = 'margin' | 'risk';
/** The only three things a user can do to a drawing. */
export type Tool = 'sketch' | 'erase' | 'adjust';
/** `idle` = drawing, nothing sent. `trading` = the plan is executing against the live feed. */
export type Phase = 'idle' | 'trading' | 'done';

/** A point of a hand-drawn stroke: time in seconds from the chart start, price in dollars. */
export interface Point {
  t: number;
  p: number;
}

export type Stroke = Point[];

/** Everything the compiler and simulator need. Derived from the configurator form. */
export interface TraceConfig {
  horizonSec: number;
  columns: number;
  entryRule: EntryRule;
  fundingIntervalMin: number;
  showSwings: boolean;
  gapMin: number;
  tolPct: number;
  /** Infinity when the budget input is 0 (no cap). */
  legBudget: number;
  mode: ReadMode;
  refPrice: number;
  margin: number;
  leverage: number;
  lossLimit: number;
  tpTarget: number;
  feeRate: number;
  fundingRateHr: number;
  nextFundingMin: number;
  maintFrac: number;
  minNotional: number;
  scenario: Scenario;
  movePct: number;
  volPct: number;
  seed: number;
  outageOn: boolean;
  outageFrom: number;
  outageTo: number;
  lockSec: number;
  penSmooth: number;
  forwardOnly: boolean;
  pauseWhileDrawing: boolean;
  sizing: SizingMode;
  riskPerLeg: number;
  stopPct: number;
  flatDefault?: 'flat' | 'hold';
}

export interface Overrides {
  gaps: Record<string, 'flat' | 'bridge'>;
  flats: Record<string, 'flat' | 'hold'>;
}

export interface Column {
  c: number;
  t: number;
  p: number | null;
  gap: boolean;
  bridged: boolean;
}

export interface GapRun {
  key: string;
  startCol: number;
  endCol: number;
  len: number;
  kind: 'start' | 'mid' | 'end';
  t0: number;
  t1: number;
  action?: 'start' | 'end' | 'flat' | 'bridge';
  default?: 'flat' | 'bridge';
}

export interface Segment {
  startCol: number;
  endCol: number;
  points: Point[];
}

export type TurnName = 'SH' | 'SL' | 'HH' | 'LH' | 'HL' | 'LL';

/** One executable directional leg, or (dir 0) a flat stretch under tolerance. */
export interface Leg {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
  dir: number;
  seg: number;
  id: number;
  reversal: boolean;
  key?: string;
  override?: 'flat' | 'hold';
  holdable?: boolean;
  held?: boolean;
  heldKey?: string;
  movePct: number;
  minutes: number;
  rate: number;
  slope: string;
  turn?: TurnName;
}

export interface FlatInterval {
  kind: 'start' | 'end' | 'gap' | 'bridged' | 'horizontal';
  t0: number;
  t1: number;
  key: string;
  len?: number;
  default?: 'flat' | 'bridge';
  holdable?: boolean;
  override?: 'flat' | 'hold';
  movePct?: number;
}

export interface Sizing {
  mode: SizingMode;
  cap: number;
  marginCap: number;
  marginRequired: number;
  capped: boolean;
  stopFrac: number | null;
  wanted?: number;
  plannedLoss?: number;
}

export interface Thresholds {
  tp: number | null;
  stop: number | null;
  liq: number | null;
}

export interface FirstLegRisk {
  leg: Leg;
  Q: number;
  tp: number | null;
  stop: number | null;
  liq: number | null;
  sizing: Sizing;
}

export interface Plan {
  cols: Column[];
  gaps: GapRun[];
  segs: Segment[];
  legs: Leg[];
  flats: Leg[];
  flatIntervals: FlatInterval[];
  warnings: string[];
  tolUsed: number;
  simplified: boolean;
  legsAtBase: number;
  turnsAvailable: number;
  anchored: boolean;
  first: FirstLegRisk | null;
  roundTrips: number;
  estFees: number;
  fundingEvents: number;
  mode: ReadMode;
  sizing: Sizing;
  shapes: string[];
}

export interface Market {
  N: number;
  prices: number[];
  at: (t: number) => number;
}

export type LogKind =
  | 'fill'
  | 'skip'
  | 'warn'
  | 'state'
  | 'funding'
  | 'end'
  | 'replan'
  | 'amend';

export interface LogEntry {
  t: number;
  kind: LogKind;
  text: string;
}

export interface Fill {
  t: number;
  side: 'buy' | 'sell';
  action: 'open' | 'close';
  Q: number;
  p: number;
  fee: number;
  B: number;
  leg: number;
  cashBefore?: number;
  cap?: number;
  notional?: number;
  capBinding?: boolean;
  why?: string;
  gross?: number;
}

export interface Position {
  d: number;
  Q: number;
  P0: number;
  t0: number;
  leg: Leg;
}

export interface SeriesPoint {
  t: number;
  p: number;
  B: number;
  eq: number;
  lev: number;
  ink: number;
  status: SimStatus;
  pos: {
    d: number;
    Q: number;
    P0: number;
    th: Thresholds;
    leg: number;
  } | null;
}

export type SimStatus =
  | 'AUTHORIZED'
  | 'OPEN'
  | 'FLAT_WAITING'
  | 'ENTRY_PENDING'
  | 'CLOSED'
  | 'LIQUIDATED';

export type EndReason =
  | 'target_reached'
  | 'stopped'
  | 'loss_limit'
  | 'liquidated'
  | 'time_exit'
  | 'no_legs';

export interface SimEvent {
  t: number;
  type: 'open' | 'close' | 'funding';
  leg?: Leg;
  forced?: boolean;
  atMarket?: boolean;
}

export interface QueueItem {
  t: number;
  type: 'open' | 'close';
  leg: Leg;
  locked: boolean;
  forced: boolean;
}

export interface Replan {
  t: number;
  lockSec: number;
  legs: Leg[];
  anchored: boolean;
  drawingEnd: number | null;
}

export interface RunResult {
  series: SeriesPoint[];
  log: LogEntry[];
  fills: Fill[];
  net: number;
  B: number;
  fees: number;
  funding: number;
  minEq: number;
  maxLev: number;
  endReason: EndReason | null;
  endT: number;
  N: number;
  replans: Replan[];
  commits: number;
}
