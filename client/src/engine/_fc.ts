import { PRESETS, DEFAULT_CPU } from './cpu';
import { createDraft, runCpuPick, nextUserPick, currentPick } from './draft';
import { forecast, observedLean } from './forecast';
import { survivalOdds } from './survival';
import { DEFAULT_ROSTER, rosterSize } from './roster';
import type { Board, CpuConfig, LeagueConfig } from './types';

const board: Board = await (await fetch('http://localhost:5178/api/board?scoring=half-ppr&teams=12')).json();
const lg = (o = {}): LeagueConfig => ({
  teamNames: null, tradedPicks: null, teams: 12, rounds: rosterSize(DEFAULT_ROSTER),
  mySlot: 5, draftType: 'snake', scoring: 'half-ppr', adpSource: 'sleeper', year: 2026,
  seed: 4242, roster: DEFAULT_ROSTER, ...o,
});

// Play n picks of a room with a known lean, then see if we detect it.
function playTo(cpu: CpuConfig, n: number) {
  let e = createDraft(lg(), cpu, board.players, null);
  while (e.state.picks.length < n && !e.state.done) e = runCpuPick(e);
  return e;
}

for (const id of ['market', 'robust-rb', 'zero-rb', 'early-qb']) {
  const preset = PRESETS.find((p) => p.id === id)!;
  const e = playTo(preset.cpu, 36);
  const lean = observedLean(e);
  console.log(id.padEnd(11), 'detected lean ->',
    (['QB','RB','WR','TE'] as const).map((p) => p + ' ' + lean[p].toFixed(1)).join('  '));
}

console.log('\n--- forecast, market room, 36 picks in ---');
const e = playTo(DEFAULT_CPU, 36);
console.log('current pick', currentPick(e.state), 'my next', nextUserPick(e.state));
for (const sims of [60, 120, 240]) {
  const t0 = Date.now();
  const f = forecast(e, sims)!;
  console.log('sims', String(sims).padStart(3), 'took', String(Date.now() - t0).padStart(4) + 'ms',
    '| taken:', (['QB','RB','WR','TE'] as const).map((p) => p + ' ' + f.taken[p].toFixed(1)).join(' '));
}

const f = forecast(e, 240)!;
console.log('\nplayer                 roomOdds  adpOdds   diff');
const avail = e.state.availableIds.map((id) => e.byId.get(id)!).sort((a,b)=>a.adp-b.adp).slice(0, 14);
for (const p of avail) {
  const room = f.survival.get(p.id) ?? 0;
  const adp = survivalOdds(p, currentPick(e.state), f.targetPick);
  console.log(p.name.padEnd(22), (room*100).toFixed(0).padStart(5)+'%',
    (adp*100).toFixed(0).padStart(7)+'%', ((room-adp)*100).toFixed(0).padStart(6));
}
