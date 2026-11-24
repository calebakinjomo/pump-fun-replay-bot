# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/calebakinjomo/pump-fun-replay-bot/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/calebakinjomo/pump-fun-replay-bot/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun): it trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve events. Paper money only — nothing real is traded.

## Strategy: the late R=30 runner

Measured on the dev window (Nov 2–3, 2026; 1,222 sampled mints):

- A pump.fun curve's price can never fall below its create price (virtual SOL is 30 + real SOL). A "rug" is a pump that retraces toward the launch price.
- The entry trigger is the moment a curve's real SOL first crosses **30 SOL** from below, at least 20 slots after creation. Instant crossings (age 0) are bundled launches — one actor buys ~14 SOL in the first slot and dumps it ~10 slots later. Organic runners cross late, with a crowd: at least 5 buy trades from 5 distinct buyers in the last 10 slots.
- P(complete | max real SOL ≥ 30) is 33%; P(complete | ≥ 50) is 62%. A runner to completion (85 SOL) pays ~+200% from a 30-SOL entry.
- Size is 0.30 SOL per coin (the 1%-of-real-reserve cap at 30 SOL), so round-trip fees (~2.5% curve + 210k lamports tx) stay ~2.6%.
- Exits: sell a third at +50%, the rest at +190% or on a −12.5% stop, or after 5,000 slots. One entry per coin, max 5 open positions.

## Dev results (`grade-local --driver process`)

- **Net PnL: +0.485 SOL** (return +4.8%; 90% interval −0.377 … +1.482 SOL)
- 153 fills over 29 coins, 29 round trips ≥ 0.01 SOL, win rate 31%, max drawdown 3.1% — guardrails met
- Top 3 coins made 57% of the gains; without them net PnL is −0.32 SOL
- Stress (20 block surrogates): median −0.28 SOL, p10 −0.62, p90 +0.19; 14 of 20 lost money; the dev score is above 19 of 20. The edge is concentrated in a few organic runners, so the score leans on this window's coins — see `tools/sim.ts` for the offline simulator used to tune it.

For comparison, the kit's pilots on the same dev window: equal-weight −0.019 SOL (5 coins, guardrails not met), momentum −9.489 SOL (drawdown 95.7%), sniper −0.475 SOL, reversion −3.995 SOL.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` — the strategy (all parameters in `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte
- `tools/sim.ts` — offline research simulator (re-implements the replay market model; not part of the bot)
- `tools/sweep.ts` — parameter sweep driver over the simulator

## Reproduce the grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --stress
```

Deterministic by construction: no clock, no randomness, no I/O in the strategy, so the two graded executions reproduce byte for byte.

## License

MIT — see [LICENSE](LICENSE).
