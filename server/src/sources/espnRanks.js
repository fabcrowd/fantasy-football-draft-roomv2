// ESPN: the third opinion, and the only one that is an opinion.
//
// Sleeper and Fantasy Football Calculator both measure the same thing, which is
// where players actually come off the board in real drafts. Agreement between
// two measurements of the market is not consensus; it is one number counted
// twice. ESPN publishes something different: an editorial draft rank, set by
// people rather than by the mean of what happened. It also publishes its own
// ADP, measured over its own drafts, which is a genuinely separate population
// from Sleeper's and FFC's.
//
// So one fetch gives two independent signals, and the disagreement between an
// editorial rank and a market ADP is the interesting part of both.
//
// Free, and no key. What it costs instead is size: ESPN ignores every limit and
// sort in the filter and answers with its entire player universe, so the
// response is about forty megabytes. It is fetched once and cached, and what is
// kept is the small part: a rank, an ADP and an auction value per player.

import { cached } from '../cache.js';
import { joinKey } from '../names.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
/** Rankings move day to day in season. Six hours matches the other feeds. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const POSITION_BY_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

const TEAM_BY_ID = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

/**
 * Which of ESPN's rank tables answers for each of this app's formats.
 *
 * ESPN publishes STANDARD, PPR and SUPERFLEX. It publishes nothing for half PPR
 * and nothing for dynasty. Half PPR takes the PPR table, which is the closer of
 * the two it does publish; dynasty takes it as well, and both are recorded as
 * borrowed rather than presented as the format's own.
 */
const RANK_TYPE = {
  standard: 'STANDARD',
  'half-ppr': 'PPR',
  ppr: 'PPR',
  '2qb': 'SUPERFLEX',
  dynasty: 'PPR',
};

/** The formats ESPN publishes a table of its own for. */
const NATIVE = new Set(['standard', 'ppr', '2qb']);

/**
 * Every player ESPN ranks, keyed the way the rest of the app joins.
 *
 * The whole universe is eleven thousand rows across every position ESPN tracks
 * for other formats. Only the six draftable ones are kept, and only the rows
 * carrying a rank, which takes it to about three and a half thousand.
 */
export async function fetchEspnRanks({ format, year, force = false }) {
  const rankType = RANK_TYPE[format] || 'PPR';
  const entry = await cached(`espn_ranks_${year}`, MAX_AGE_MS, async () => {
    const res = await fetch(
      BASE + '/' + year + '/players?scoringPeriodId=0&view=kona_player_info',
      {
        headers: {
          accept: 'application/json',
          // Ignored by ESPN, which answers with everything regardless. Sent
          // anyway so that the day it starts being honoured, this gets smaller
          // rather than wrong.
          'x-fantasy-filter': JSON.stringify({ players: { limit: 1000 } }),
        },
      },
    );
    if (!res.ok) throw new Error('ESPN rankings returned ' + res.status + '.');
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.players || []);

    const rows = [];
    for (const p of list) {
      const position = POSITION_BY_ID[p.defaultPositionId];
      const ranks = p.draftRanksByRankType;
      if (!position || !ranks) continue;

      const byType = {};
      for (const type of ['STANDARD', 'PPR', 'SUPERFLEX']) {
        const r = ranks[type];
        if (r && Number(r.rank) > 0) {
          byType[type] = { rank: Number(r.rank), auction: Number(r.auctionValue) || null };
        }
      }
      if (!Object.keys(byType).length) continue;

      rows.push({
        name: String(p.fullName || '').trim(),
        position,
        team: TEAM_BY_ID[p.proTeamId] || '',
        ranks: byType,
        adp: Number(p.ownership?.averageDraftPosition) || null,
        percentOwned: Number(p.ownership?.percentOwned) || null,
      });
    }
    return rows;
  }, force);

  const rows = entry.value || [];
  const byKey = new Map();
  for (const row of rows) {
    const held = row.ranks[rankType];
    if (!held) continue;
    byKey.set(joinKey(row.name, row.position, row.team), {
      rank: held.rank,
      auction: held.auction,
      adp: row.adp,
      percentOwned: row.percentOwned,
    });
  }

  return {
    byKey,
    meta: {
      source: 'ESPN',
      sourceUrl: 'https://fantasy.espn.com',
      rankType,
      rankTypeBorrowed: !NATIVE.has(format),
      ranked: byKey.size,
      fetchedAt: entry.fetchedAt,
      stale: !!entry.stale,
    },
  };
}
