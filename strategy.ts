// Early-strength scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Why this shape (measured on the dev window, Nov 2-3 2026, 1,222 sampled mints):
// - A pump.fun curve's price can never fall below its create price (virtual SOL is
//   30 + real SOL, so vq >= 30 always). A "rug" is a pump that retraces toward the
//   launch price. The game is therefore: buy a launch that is actually running,
//   sell into strength fast, and never hold the retrace.
// - The entry trigger is the moment a curve's real SOL first crosses 30 SOL from
//   below, at least 20 slots after creation. Instant crossings (age 0) are bundled
//   launches: one actor buys ~14 SOL in the first slot and dumps it ~10 slots
//   later. Organic runners cross late. First-passage stats from the fill-time
//   price (+2 slots), crossings at age >= 20: +200% before -10% on 9.6% of coins,
//   -10% first on 90.4% — EV +10.2% per trade before fees, because the downside
//   is capped at -10% while a runner to completion (R=85) pays +200% from R=30.
//   P(complete | max R >= 30) is 33%; P(complete | max R >= 50) is 62%.
// - Fees per round trip are ~2.5% curve + 210k lamports tx. At the R=30 crossing
//   the 1%-of-real-reserve cap allows a 0.30 SOL buy, so fees stay ~2.6%.
// - The sniper pilot (-0.47 SOL) buys too small and too early; the momentum pilot
//   (-9.49 SOL) pyramids into strength and holds through the retrace; the
//   reversion pilot (-4.00 SOL) buys dips that keep dipping. This bot waits for a
//   proven runner, risks 5-8% per trade, and lets the rare 2-5x runners pay.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only
// over insertion-ordered maps and explicitly sorted mint lists fed by the batch
// stream, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  /**
   * Real-SOL crossing that triggers an entry: buy on the first batch where the
   * curve's real SOL reaches crossRqSol from below. First-passage stats on the
   * dev window (from the fill-time price, +2 slots): at R=20, +200% before -5%
   * on 4.3% of coins, -5% first on 78.5% — EV +4.7% per trade before fees,
   * because the downside is capped while the upside is uncapped. Low crossings
   * (R=3/5) and fixed-age entries are negative: the pump has stalled by the
   * time a 2-slot-late fill lands.
   */
  crossRqSol: number;
  /** The crossing must happen within this many slots of the CreateEvent. */
  maxCrossAge: number;
  /**
   * The crossing must happen at least this many slots after the CreateEvent.
   * Instant crossings (age 0) are bundled launches: one actor buys ~14 SOL in
   * the first slot and dumps it ~10 slots later. Organic runners cross late.
   */
  minCrossAge: number;
  /** Real SOL reserve window at decision time. minRqSol keeps buys big enough to beat fees. */
  minRqSol: number;
  maxRqSol: number;
  /** Price now over create price, as a fraction: the launch must be running, not vertical. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minBuys: number;
  minBuyers: number;
  /** The most recent trade must be a buy (fresh demand, not a top being sold into). */
  lastMustBeBuy: boolean;
  /** Creator's own buys in the create slot, at most (SOL): a dev-heavy launch is a dump setup. */
  maxDevBuySol: number;
  /** Skip the coin when the creator has sold before entry. */
  skipDevSold: boolean;
  /** SOL to put into one position (capped by 1% of real SOL per reply). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** First take-profit: sell tp1Part of the position once value is tp1 over cost. */
  tp1: number;
  tp1Part: number;
  /** Sell the whole position once value is tpFull over cost. */
  tpFull: number;
  /** Sell the whole position once value is sl under cost. */
  stopLoss: number;
  /** Trailing stop: once up trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when net SOL over flowWindow falls below minus this. */
  exitFlowSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Slippage allowed on buys and sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  crossRqSol: 30,
  maxCrossAge: 100_000,
  minCrossAge: 20,
  minRqSol: 30,
  maxRqSol: 85,
  minRunup: 0,
  maxRunup: 10,
  flowWindow: 10,
  minFlowSol: 0,
  minBuys: 5,
  minBuyers: 5,
  lastMustBeBuy: true,
  maxDevBuySol: 10,
  skipDevSold: true,
  stakeSol: 0.3,
  minBuySol: 0.02,
  tp1: 0.5,
  tp1Part: 0.33,
  tpFull: 1.9,
  stopLoss: 0.125,
  trailArm: 1000,
  trail: 0.2,
  maxHold: 5000,
  exitOnDevSell: false,
  bigSellSol: 1000,
  exitFlowSol: 1000,
  staleSlots: 100_000,
  cooldown: 100,
  maxEntries: 1,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125; // protocol 95 + creator 30 bps charged on every curve trade.

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** Real SOL (SOL) as of the previous batch: detects the R-crossing moment. */
  prevRq: number;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  best: number; // best close value seen (SOL, curve + tx fees deducted)
  tookTp1: boolean;
  entryPrice: number;
}

/** Close value of `tokens` against (vq, vt) after curve fees and one tx fee, in SOL. */
function closeValue(tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * BigInt(FEE_BPS) + 9999n) / 10_000n;
  return Number(q - fee - txLamports) / LAMPORTS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.flowWindow, p.staleSlots) + 5;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: null, createPrice: 0, devBuy: 0, devSold: false, lastTradeSlot: -1, prevRq: 0, ticks: [], entries: 0, lastExit: -1e12 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL (buys minus sells) and distinct buyers over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): { net: number; buys: number; buyers: number } => {
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      if (t.buy) {
        net += t.sol;
        buys++;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buys, buyers: buyers.size };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = state.txFeeLamports();
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const traded = new Set<Pubkey>();
      const bigSell = new Set<Pubkey>();

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          const vt = BigInt(e.virtual_token_reserves);
          c.createPrice = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const vt = BigInt(e.virtual_token_reserves);
          const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
          c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (c.creator !== null && e.user === c.creator) {
            if (e.is_buy && e.slot === c.created) c.devBuy += sol;
            if (!e.is_buy) c.devSold = true;
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.lastExit = now;
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }

      // Fills: a buy landing opens the hold clock; a sell landing closes the book on the coin.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          const c = coins.get(f.mint);
          if (c !== undefined) c.lastExit = now;
          continue;
        }
        if (f.status !== 'filled') continue;
        const c = coins.get(f.mint);
        if (f.side === 'buy') {
          const h = held.get(f.mint);
          if (h !== undefined) h.opened = f.slot;
        } else if (c !== undefined) {
          held.delete(f.mint);
          c.entries++;
          c.lastExit = now;
        }
      }

      // 1. Exits first, in sorted mint order (deterministic).
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        if (pendingSell.has(mint)) continue;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = closeValue(pos.token_amount, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = { opened: now, best: value, tookTp1: false, entryPrice: vq === 0n || vt === 0n ? 0 : Number(vq) / Number(vt) };
          held.set(mint, h);
        }
        if (value > h.best) h.best = value;
        const c = coins.get(mint);
        const gain = value / cost - 1;
        let exit = false;
        let partial = false;
        if (!h.tookTp1 && gain >= p.tp1) partial = true;
        if (gain >= p.tpFull) exit = true;
        if (gain <= -p.stopLoss) exit = true;
        if (h.best >= cost * (1 + p.trailArm) && value <= h.best * (1 - p.trail)) exit = true;
        if (now - h.opened >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (bigSell.has(mint)) exit = true;
          if (now - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (flow(c, now, p.flowWindow).net < -p.exitFlowSol) exit = true;
        }
        if (partial && !exit) {
          const part = (pos.token_amount * BigInt(Math.round(p.tp1Part * 10_000))) / 10_000n;
          if (part > 0n && part < pos.token_amount && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlipBps });
            h.tookTp1 = true;
            h.best = value;
          }
          continue;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // 2. Entries on coins that traded this batch, in batch order (deterministic).
      // Entry trigger: the curve's real SOL just crossed crossRqSol from below.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = coins.get(mint)!;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const crossed = c.prevRq < p.crossRqSol && rqSol >= p.crossRqSol;
        if (!crossed) continue;
        if (c.created === null) continue;
        const age = now - c.created;
        if (age < p.minAge || age > p.maxCrossAge || age < p.minCrossAge) continue;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (c.devBuy > p.maxDevBuySol) continue;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (c.createPrice <= 0 || price <= 0) continue;
        const runup = price / c.createPrice - 1;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        const fl = flow(c, now, p.flowWindow);
        if (fl.net < p.minFlowSol || fl.buys < p.minBuys || fl.buyers < p.minBuyers) continue;
        const last = c.ticks[c.ticks.length - 1]!;
        if (p.lastMustBeBuy && !last.buy) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol * 0.97, p.stakeSol);
        if (amount > free - Number(tx) / LAMPORTS) amount = free - Number(tx) / LAMPORTS;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + Number(tx) / LAMPORTS;
        slotsLeft--;
        held.set(mint, { opened: now, best: 0, tookTp1: false, entryPrice: price });
      }
      // Real SOL as of this batch, for next batch's crossing detection.
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve !== undefined) coins.get(mint)!.prevRq = Number(curve.real_quote_reserves) / LAMPORTS;
      }
      return orders;
    },
  };
}
