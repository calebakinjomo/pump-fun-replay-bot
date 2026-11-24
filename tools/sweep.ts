// Offline sweep driver: imports simulate() from ./sim.ts and grids params.
import { simulate } from './sim.ts';
import { DEFAULT_PARAMS, type Params } from '../strategy.ts';

const KIT = '/home/hatch/workspace/makefun/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit';
const grid = JSON.parse(process.argv[2] ?? '{}') as { vary: string[]; values: Record<string, unknown[]> };
const keys = grid.vary;
const vals = keys.map((k) => grid.values[k] as unknown[]);
const combos: Record<string, unknown>[] = [];
const rec = (i: number, cur: Record<string, unknown>) => {
  if (i === keys.length) { combos.push({ ...cur }); return; }
  for (const v of vals[i]!) { cur[keys[i]!] = v; rec(i + 1, cur); }
};
rec(0, {});
const rows: string[] = [];
for (const c of combos) {
  const params: Params = { ...DEFAULT_PARAMS, ...c } as Params;
  const r = simulate(KIT, params);
  const net = Number(r.net) / 1e9;
  rows.push(`${net.toFixed(4)}  halves=${(Number(r.halves[0]) / 1e9).toFixed(3)}/${(Number(r.halves[1]) / 1e9).toFixed(3)} fills=${r.fills} mints=${r.mints} maxDD=${r.maxDD.toFixed(3)} failed=${r.failed}  ${JSON.stringify(c)}`);
}
rows.sort();
for (const row of rows) console.log(row);
