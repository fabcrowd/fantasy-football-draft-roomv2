import { useMemo } from 'react';
import { positionValues } from '../engine/value';
import { describeLean } from '../engine/forecast';
import type { Forecast } from '../engine/forecast';
import type { Player, RosterSlots } from '../engine/types';

interface Props {
  available: Player[];
  all: Player[];
  roster: RosterSlots;
  teams: number;
  currentPick: number;
  myNextPick: number | null;
  /**
   * This room simulated forward from its real picks, when there are enough of
   * them. It replaces the ADP reading rather than sitting beside it: both
   * answer the same question and only one of them has seen the draft.
   */
  room: Forecast | null;
}

function pickLabel(overall: number, teams: number): string {
  const round = Math.floor((overall - 1) / teams) + 1;
  const slot = ((overall - 1) % teams) + 1;
  return round + '.' + String(slot).padStart(2, '0');
}

/**
 * What this pick buys you over the next one, position by position.
 *
 * The survival bar next to a player answers "will he last". This answers the
 * question you actually have on the clock, which is whether that matters. A
 * back with a 20 per cent chance of lasting is a crisis when the next back is
 * forty points worse and a shrug when the next one is three points worse, and
 * only the second number tells the two apart.
 *
 * The bars are scaled against the costliest position rather than a fixed span,
 * because the interesting reading is which position to spend on, and late in a
 * draft every real number is small.
 */
export default function ValuePanel(props: Props) {
  const { available, all, roster, teams, currentPick, myNextPick, room } = props;

  const rows = useMemo(() => {
    const base = positionValues(available, all, teams, roster, currentPick, myNextPick);
    if (!room) return base;

    // The forecast has already played this round out against the real rosters,
    // so its expected best and its survival replace the ADP model's guesses.
    return base
      .map((row) => {
        const later = room.expected[row.position];
        const odds = row.best ? room.survival.get(row.best.id) ?? 0 : 0;
        return { ...row, later, odds, cost: Math.max(0, row.now - later) };
      })
      .sort((a, b) => b.cost - a.cost);
  }, [available, all, teams, roster, currentPick, myNextPick, room]);

  if (myNextPick == null || !rows.length) return null;

  const lean = room ? describeLean(room.lean) : null;
  const top = rows[0].cost;
  // Under about a point of drop off there is nothing to choose between the
  // positions, and a bar chart of noise reads as a recommendation.
  const flat = top < 1;

  return (
    <div className="value-panel">
      <div className="panel-head">
        <h2 className="eyebrow">Cost of waiting</h2>
        <span className="hint">{'to ' + pickLabel(myNextPick, teams)}</span>
      </div>

      {room && lean && <p className="value-lean">{lean}</p>}

      <div className="value-rows">
        {flat && (
          <p className="hint value-flat">
            Every position holds up until your next pick. Take the best player on your board.
          </p>
        )}
        {rows.map((row) => (
          <div className="value-row" key={row.position} data-pos={row.position}>
            <span className="pos-tag">{row.position}</span>
            <div className="value-body">
              <div className="value-line">
                <span className="value-name">{row.best?.name ?? '—'}</span>
                <span className="value-cost">
                  {row.cost >= 0.5 ? '−' + row.cost.toFixed(0) : '0'}
                </span>
              </div>
              <div className="value-bar">
                <div
                  className="value-fill"
                  style={{ width: (top > 0 ? Math.max(0, row.cost / top) * 100 : 0) + '%' }}
                />
              </div>
              <p className="value-note">
                {Math.round(row.odds * 100) + '% he lasts'}
                {' · '}
                {room
                  ? room.taken[row.position].toFixed(1) + ' go first'
                  : (row.beforeCliff === 1
                    ? 'then a drop'
                    : row.beforeCliff + ' before the drop')}
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="hint value-foot">
        {room
          ? 'Points over a replacement starter, lost by waiting one turn. Read from '
            + room.sims + ' runs of this room, off the real picks and the real rosters.'
          : 'Points over a replacement starter, lost by waiting one turn. Read off '
            + 'ADP until a full round is in, so a run already under way will not show.'}
      </p>
    </div>
  );
}
