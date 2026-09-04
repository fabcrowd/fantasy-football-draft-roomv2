import { chooseCpuPick } from './cpu';
import { availablePlayers, currentPick, currentTeam, nextUserPick, presetFor } from './draft';
import { mulberry32 } from './random';
import { replacementPoints } from './value';
import type { DraftEngine } from './draft';
import type { CpuConfig, Player, Position } from './types';
import { POSITIONS } from './types';

/**
 * WHAT THE ROOM IS ACTUALLY DOING
 *
 * The survival bar reads ADP and nothing else, which is the same as assuming
 * every room drafts like the average of thousands of rooms. Yours does not.
 * Six backs off the board in the first ten picks is a fact about this draft,
 * and it is the fact that decides whether the back you want reaches you.
 *
 * Two things are measured here and then simulated forward:
 *
 *   what the room leans towards   counted from picks against what ADP expected
 *   what each team still needs    already in the engine, as their real roster
 *
 * The second one was always there: the computer teams score players by their
 * own open slots. It has only ever been pointed at an invented room. Pointed at
 * the real one, with the real rosters and the real picks behind it, the same
 * model answers who is likely to be gone before your turn comes back.
 */

/** How far a position has to run before the lean reads as the strongest setting. */
const FULL_LEAN = 0.5;

/** How many baseline drafts a lean is measured against. */
const BASELINE_RUNS = 3;

/**
 * The room's positional lean, in the same -5 to +5 the dials use.
 *
 * For every position, count what has gone against what a room with no lean at
 * all would have taken by now, and scale by the size of the room. A surplus of
 * half a round is a strong lean; the dial saturates there, because past that
 * the reading is one run rather than a tendency.
 *
 * THE BASELINE IS SIMULATED, NOT THE ADP ORDER. Every real room drafts away
 * from ADP without leaning anywhere: it takes a starting back before a better
 * receiver because it has two back slots to fill, and ADP knows nothing about
 * slots. Measured against ADP, an ordinary room reads as nearly two points of
 * anti-receiver bias, and since the lean is then handed back to a model that
 * already applies the roster need bonus, that bias would be counted twice.
 * Measured against the same model with its position dials zeroed, an ordinary
 * room reads as ordinary, and only what this room does differently survives.
 *
 * It says nothing until a full round is in. Before that the sample is a
 * handful of picks and every position reads as a landslide.
 */
export function observedLean(engine: DraftEngine): Record<Position, number> {
  const { state } = engine;
  const made = state.picks.length;
  const lean = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<Position, number>;
  if (made < state.league.teams) return lean;

  const taken = { ...lean };
  for (const pick of state.picks) {
    const player = engine.byId.get(pick.playerId);
    if (player) taken[player.position] += 1;
  }

  const expected = baseline(engine, made);
  const scale = FULL_LEAN * state.league.teams;
  for (const pos of POSITIONS) {
    lean[pos] = Math.max(-5, Math.min(5, ((taken[pos] - expected[pos]) / scale) * 5));
  }
  return lean;
}

/**
 * What a room with no lean would hold after this many picks.
 *
 * The same league and the same model with every position dial at zero, drafted
 * from an empty board. A few runs, averaged, because one run of a room that
 * reaches is itself noisy.
 */
function baseline(engine: DraftEngine, picks: number): Record<Position, number> {
  const { state } = engine;
  const out = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<Position, number>;
  const cpu: CpuConfig = {
    ...state.cpu,
    positionBias: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 },
    cpuUsesMyRankings: false,
  };

  for (let run = 0; run < BASELINE_RUNS; run += 1) {
    const rng = mulberry32(state.league.seed + run * 15485863 + 3);
    let live: DraftEngine = {
      ...engine,
      state: {
        ...state,
        teams: state.teams.map((t) => ({
          ...t, playerIds: [], counts: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 },
        })),
        picks: [],
        availableIds: [...engine.byId.keys()],
        done: false,
      },
      presets: new Map(),
    };

    for (let i = 0; i < picks && !live.state.done; i += 1) {
      const team = currentTeam(live.state);
      if (!team) break;
      const player = chooseCpuPick(availablePlayers(live), {
        league: live.state.league,
        cpu,
        overallPick: currentPick(live.state),
        team: { index: team.index, counts: team.counts, picksMade: team.playerIds.length },
        rankOverride: null,
        rng,
      });
      if (!player) break;
      out[player.position] += 1 / BASELINE_RUNS;
      live = takePlayer(live, player, false);
    }
  }
  return out;
}

export interface Forecast {
  sims: number;
  /** The pick this forecast runs to. */
  targetPick: number;
  /** Per player id, the share of simulations where he was still there. */
  survival: Map<string, number>;
  /** Per position, the mean number taken between now and your next pick. */
  taken: Record<Position, number>;
  /** Per position, the mean value of the best one left, over a replacement starter. */
  expected: Record<Position, number>;
  /** The lean the room was simulated with. */
  lean: Record<Position, number>;
}

/**
 * Play the rest of the round out many times and count what comes back.
 *
 * Every run is the real board, the real rosters and the real picks, carried
 * forward by the same model the computer teams use, with a different seed each
 * time. What survives a hundred of those is a probability that knows about this
 * room, which is exactly what reading ADP alone cannot give you.
 */
export function forecast(engine: DraftEngine, sims = 120): Forecast | null {
  const { state } = engine;
  const target = nextUserPick(state);
  const from = currentPick(state);
  if (target == null || target <= from || state.done) return null;

  const lean = observedLean(engine);
  const cpu: CpuConfig = {
    ...state.cpu,
    // The room's own lean sits on top of whatever the dials say, so a setting
    // you chose is still honoured and the measurement moves it.
    positionBias: Object.fromEntries(
      POSITIONS.map((p) => [p, Math.max(-5, Math.min(5, (state.cpu.positionBias[p] ?? 0) + lean[p]))]),
    ) as Record<Position, number>,
  };

  const survived = new Map<string, number>();
  const taken = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<Position, number>;
  const bestLeft = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<Position, number>;
  const replacement = replacementPoints(
    [...engine.byId.values()], state.league.teams, state.league.roster,
  );

  for (let sim = 0; sim < sims; sim += 1) {
    // A stream of its own per run. Without this every run is the same draft.
    const rng = mulberry32(state.league.seed + sim * 104729 + 7);
    let live = engine;

    while (currentPick(live.state) < target && !live.state.done) {
      const overall = currentPick(live.state);
      const team = currentTeam(live.state);
      if (!team) break;

      const promised = presetFor(live, overall);
      const player = promised ?? chooseCpuPick(availablePlayers(live), {
        league: live.state.league,
        cpu,
        overallPick: overall,
        team: { index: team.index, counts: team.counts, picksMade: team.playerIds.length },
        rankOverride: live.state.cpu.cpuUsesMyRankings ? live.rankOverride : null,
        rng,
      });
      if (!player) break;
      live = takePlayer(live, player, !!promised);
    }

    const left = availablePlayers(live);
    const seen = new Set<string>();
    for (const p of left) {
      survived.set(p.id, (survived.get(p.id) ?? 0) + 1);
      if (!seen.has(p.position)) {
        seen.add(p.position);
        // The pool is in board order, so the first one at a position is the
        // best available by the market. Value it against replacement.
        bestLeft[p.position] += Math.max(0, (p.points ?? 0) - replacement[p.position]);
      }
    }
    for (const pos of POSITIONS) {
      taken[pos] += countAt(engine, live, pos);
    }
  }

  const survival = new Map<string, number>();
  for (const [id, n] of survived) survival.set(id, n / sims);
  for (const pos of POSITIONS) {
    taken[pos] /= sims;
    bestLeft[pos] /= sims;
  }

  return {
    sims, targetPick: target, survival, taken, expected: bestLeft, lean,
  };
}

/** How many at a position went between the real board and the simulated one. */
function countAt(before: DraftEngine, after: DraftEngine, pos: Position): number {
  let n = 0;
  for (let i = before.state.picks.length; i < after.state.picks.length; i += 1) {
    if (after.byId.get(after.state.picks[i].playerId)?.position === pos) n += 1;
  }
  return n;
}

/**
 * Record a simulated pick.
 *
 * This is `applyPick` from the engine with the bookkeeping a simulation does
 * not need left out. A forecast runs this many thousands of times and throws
 * every result away, so it keeps only what the next pick reads: the rosters,
 * the pick count and who is left.
 */
function takePlayer(engine: DraftEngine, player: Player, preset: boolean): DraftEngine {
  const { state } = engine;
  const overall = currentPick(state);
  const teamIndex = state.order[overall - 1];

  const teams = preset
    ? state.teams
    : state.teams.map((t) => (t.index === teamIndex
      ? {
        ...t,
        playerIds: [...t.playerIds, player.id],
        counts: { ...t.counts, [player.position]: t.counts[player.position] + 1 },
      }
      : t));

  return {
    ...engine,
    state: {
      ...state,
      teams,
      picks: [...state.picks, {
        overall,
        round: Math.floor((overall - 1) / state.league.teams) + 1,
        slotInRound: ((overall - 1) % state.league.teams) + 1,
        teamIndex,
        playerId: player.id,
        auto: true,
        preset: null,
      }],
      availableIds: state.availableIds.filter((id) => id !== player.id),
      done: state.picks.length + 1 >= state.order.length,
    },
  };
}

/** The strength at which a lean is worth putting into words. */
const LEAN_WORTH_SAYING = 1.2;

/**
 * What the room is doing, in a sentence, or null when it is doing nothing.
 *
 * Only the two strongest positions are named. A list of six is a table, and a
 * table of small numbers reads as six findings rather than one.
 */
export function describeLean(lean: Record<Position, number>): string | null {
  const strong = POSITIONS
    .filter((p) => Math.abs(lean[p]) >= LEAN_WORTH_SAYING)
    .sort((a, b) => Math.abs(lean[b]) - Math.abs(lean[a]))
    .slice(0, 2);
  if (!strong.length) return null;

  const words = strong.map((p) => (lean[p] > 0 ? 'forcing ' : 'fading ') + p);
  return 'This room is ' + words.join(' and ') + '.';
}
