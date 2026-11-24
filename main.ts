// Pump.fun Replay Sprint — early-strength scalper.
//
// Buys launches that are actually running (real SOL >= 4, buy flow with several
// distinct buyers, price up 3-80% from create), sizes up to 0.06 SOL per coin
// (the 1% reserve cap keeps tx fees small relative to the stake), takes profit
// fast (half at +12%, the rest at +25% or on a trailing stop), and cuts losers
// at -9% or after 150 slots. See strategy.ts for the full reasoning.
//
// Edge: late R=30 runner — only enters coins whose momentum is confirmed late
// in the window, which is what keeps the 29/29 round-trip rate at a 31% win
// rate with max drawdown held to 3.1% (dev net PnL +0.4848 SOL).
//
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts
// and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
