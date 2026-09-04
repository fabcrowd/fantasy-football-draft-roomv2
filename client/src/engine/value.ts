import { survivalOdds } from './survival';
import { emptyCounts, starterCount } from './roster';
import type { Player, Position, RosterSlots } from './types';
import { POSITIONS } from './types';

/**
 * What one position is worth right now, and what it will be worth if you wait.
 *
 * The survival bar answers "will he last". It does not answer the question you
 * actually have on the clock, which is "does it matter". A receiver with a 20
 * per cent chance of lasting is a crisis if the next receiver is 40 points
 * worse and a shrug if the next one is 3 points worse. That gap is the whole
 * decision, and nothing on the board was showing it.
 */
export interface PositionValue {
  position: Position;
  /** The best player available at this position, by points over replacement. */
  best: Player | null;
  /** His value over replacement, in projected points. */
  now: number;
  /** The value you expect to still be there at your next pick. */
  later: number;
  /** now - later: what this pick buys you over waiting one turn. */
  cost: number;
  /** The chance `best` himself lasts until then. */
  odds: number;
  /** How many players are left before the biggest drop in value. */
  beforeCliff: number;
}

/**
 * The projected points of a replacement player at each position.
 *
 * Replacement is the first player at a position nobody has to start, so it
 * depends on how many of that position a league starts in total. Rather than
 * split the flex slots by a table of made up shares, the split is read off the
 * market: count the positions among the first `teams * starters` players by
 * ADP. A superflex league drafts quarterbacks earlier, so more of them land in
 * that window and the quarterback replacement moves down on its own.
 *
 * It is measured against the whole board, drafted players included, because
 * replacement level is a fact about the league's shape and not about how this
 * particular draft has gone so far.
 */
export function replacementPoints(
  all: Player[],
  teams: number,
  roster: RosterSlots,
): Record<Position, number> {
  const depth = teams * starterCount(roster);
  const counts = emptyCounts();
  for (const p of [...all].sort((a, b) => a.adp - b.adp).slice(0, depth)) {
    counts[p.position] += 1;
  }

  const out = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const pool = all
      .filter((p) => p.position === pos && p.points != null)
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    if (!pool.length) {
      out[pos] = 0;
      continue;
    }
    // A league that starts one of something starts `teams` of them, however
    // late the market takes them. Without that floor a kicker, who never
    // appears inside the starter window at all, becomes his own replacement
    // and every kicker on the board prices at zero.
    const started = Math.max(counts[pos], teams * roster[pos]);
    out[pos] = pool[Math.min(started, pool.length - 1)].points ?? 0;
  }
  return out;
}

/**
 * The value you expect the best survivor at a position to carry.
 *
 * Walking the position in value order, a player is the best one left exactly
 * when he survives and everyone better than him does not. Those terms sum to
 * the expected best, which is the number to compare against taking one now.
 *
 * A player below replacement contributes nothing: he is not a reason to wait,
 * and counting him would make a barren position look like a full one.
 */
function expectedBest(
  ranked: Player[],
  replacement: number,
  currentPick: number,
  targetPick: number,
): number {
  let gone = 1;
  let total = 0;
  for (const p of ranked) {
    const value = (p.points ?? 0) - replacement;
    if (value <= 0) break;
    const odds = survivalOdds(p, currentPick, targetPick);
    total += gone * odds * value;
    gone *= 1 - odds;
    if (gone < 1e-4) break;
  }
  return total;
}

/**
 * How far down this position's list the biggest drop in value sits.
 *
 * Only the top of the list is worth reading: a cliff eight players away is not
 * a cliff you can fall off before your next turn.
 */
function playersBeforeCliff(ranked: Player[]): number {
  const top = ranked.slice(0, 9);
  let at = top.length;
  let worst = 0;
  for (let i = 0; i + 1 < top.length; i += 1) {
    const drop = (top[i].points ?? 0) - (top[i + 1].points ?? 0);
    if (drop > worst) {
      worst = drop;
      at = i + 1;
    }
  }
  return at;
}

/**
 * Every position, priced by what waiting one turn would cost.
 *
 * Sorted by that cost, so the position at the top is the one this pick is
 * worth spending on. Positions with no projected points behind them are left
 * out rather than shown as zero, which would read as "no drop off" when it
 * means "no data".
 */
export function positionValues(
  available: Player[],
  all: Player[],
  teams: number,
  roster: RosterSlots,
  currentPick: number,
  targetPick: number | null,
): PositionValue[] {
  const replacement = replacementPoints(all, teams, roster);
  const out: PositionValue[] = [];

  for (const pos of POSITIONS) {
    const ranked = available
      .filter((p) => p.position === pos && p.points != null)
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    if (!ranked.length) continue;

    const best = ranked[0];
    const now = (best.points ?? 0) - replacement[pos];
    const later = targetPick == null
      ? now
      : expectedBest(ranked, replacement[pos], currentPick, targetPick);

    out.push({
      position: pos,
      best,
      now,
      later,
      cost: now - later,
      odds: targetPick == null ? 1 : survivalOdds(best, currentPick, targetPick),
      beforeCliff: playersBeforeCliff(ranked),
    });
  }

  return out.sort((a, b) => b.cost - a.cost);
}
