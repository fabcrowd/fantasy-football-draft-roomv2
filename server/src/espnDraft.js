// Read a real ESPN draft: the teams in it, the order they pick in, and every
// pick that has already happened.
//
// It answers in exactly the shape the Sleeper reader answers in, because the
// client should not have to know which site a draft is on. Everything below is
// about the two places ESPN differs.
//
// ESPN NAMES NOBODY. A Sleeper pick carries the player's name and position; an
// ESPN pick carries a number and nothing else. So the player universe is read
// once, cached, and used to turn those numbers into names the board can join
// on. It is the largest thing this service fetches and the least likely to
// change, which is what makes it worth caching for a day.
//
// A PRIVATE LEAGUE NEEDS THE USER'S OWN COOKIES. There is no key to apply for.
// ESPN authorises the browser session, so a private league can only be read by
// sending the two cookies that browser holds. They arrive per request, are used
// for that request, and are never written to the cache: what is cached is the
// public player universe, never a league read with somebody's credentials.

import { cached } from './cache.js';
import { buildBoard } from './board.js';
import { joinKey, normPos, normTeam } from './names.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
/** The player universe is a season-long fact. */
const UNIVERSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** ESPN's position ids, for the six positions this app drafts. */
const POSITION_BY_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

/**
 * ESPN's NFL team ids.
 *
 * Checked against the D/ST rows in the universe itself, which carry both the
 * team's nickname and its id, so a wrong entry here shows up as a defence that
 * cannot be joined rather than as a silently wrong team.
 */
const TEAM_BY_ID = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

/** A league or team id from ESPN is a run of digits. */
export const IS_ESPN_ID = /^\d{1,20}$/;

/**
 * The two cookies a private league needs, cleaned up.
 *
 * SWID is written with braces and is often pasted without them. Both forms are
 * accepted because the difference is a paste artefact and not a decision the
 * user is making.
 */
export function cookieHeader(espnS2, swid) {
  const s2 = String(espnS2 || '').trim();
  const id = String(swid || '').trim();
  if (!s2 && !id) return null;
  const braced = id && !id.startsWith('{') ? '{' + id.replace(/^\{|\}$/g, '') + '}' : id;
  return [s2 && 'espn_s2=' + s2, braced && 'SWID=' + braced].filter(Boolean).join('; ');
}

async function get(url, cookie) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      ...(cookie ? { cookie } : {}),
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(cookie
      ? 'ESPN rejected those cookies. They expire: copy espn_s2 and SWID again from a '
        + 'browser tab where you are signed in to this league.'
      : 'That ESPN league is private. Add your espn_s2 and SWID cookies to read it.');
  }
  if (res.status === 404) throw new Error('ESPN has no league with that ID for this season.');
  if (!res.ok) throw new Error('ESPN returned ' + res.status + '.');
  return res.json();
}

/**
 * Every player ESPN knows, as id to name, position and team.
 *
 * Only the six draftable positions are kept. The raw list runs to eleven
 * thousand rows across every defensive position ESPN tracks for other formats,
 * and carrying them would triple the cache for players no draft can take.
 */
async function playerUniverse(year, force = false) {
  const entry = await cached('espn_players_' + year, UNIVERSE_MAX_AGE_MS, async () => {
    const raw = await fetch(BASE + '/' + year + '/players?scoringPeriodId=0&view=players_wl', {
      headers: {
        accept: 'application/json',
        // Without a filter ESPN answers with a short default page.
        'x-fantasy-filter': JSON.stringify({ players: { limit: 3000 } }),
      },
    });
    if (!raw.ok) throw new Error('ESPN player list returned ' + raw.status + '.');
    const list = await raw.json();

    const out = {};
    for (const p of list || []) {
      const position = POSITION_BY_ID[p.defaultPositionId];
      if (!position) continue;
      out[String(p.id)] = {
        name: String(p.fullName || '').trim(),
        position,
        team: TEAM_BY_ID[p.proTeamId] || '',
      };
    }
    return out;
  }, force);

  return entry.value || {};
}

function teamName(team) {
  const full = [team.location, team.nickname].filter(Boolean).join(' ').trim();
  return team.name || full || 'Team ' + team.id;
}

/**
 * A real ESPN draft, as picks against the board.
 *
 * `draftDetail.picks` is the whole draft every time rather than a growing tail,
 * which is what the client wants: it rebuilds the board from the list instead
 * of appending to it, so a pick undone upstream disappears here too.
 */
export async function espnDraftPicks(leagueId, boardQuery, cookie) {
  const year = boardQuery.year;
  const url = BASE + '/' + year + '/segments/0/leagues/' + leagueId
    + '?view=mDraftDetail&view=mTeam&view=mSettings';

  const [league, board, universe] = await Promise.all([
    get(url, cookie),
    buildBoard(boardQuery),
    playerUniverse(year),
  ]);

  const detail = league.draftDetail || {};
  const teams = league.teams || [];
  const size = Number(league.settings?.size) || teams.length || 0;

  const byKey = new Map(board.players.map((p) => [p.key, p]));
  const picks = [];
  const unknown = [];

  for (const pick of detail.picks || []) {
    const espnId = String(pick.playerId);
    const known = universe[espnId] || null;
    const name = known?.name || '';
    const position = normPos(known?.position || '');
    const team = normTeam(known?.team || '');

    const player = byKey.get(joinKey(name, position, team)) || null;
    if (!player) unknown.push({ name: name || espnId, position, team });

    const overall = Number(pick.overallPickNumber);
    picks.push({
      overall,
      round: Number(pick.roundId) || Math.floor((overall - 1) / (size || 1)) + 1,
      slot: Number(pick.roundPickNumber) || ((overall - 1) % (size || 1)) + 1,
      rosterId: pick.teamId != null ? Number(pick.teamId) : null,
      pickedBy: pick.teamId != null ? String(pick.teamId) : null,
      isKeeper: !!pick.keeper,
      playerId: player ? player.id : 'off-' + espnId,
      offBoard: !player,
      name: player ? player.name : (name || 'Unknown player'),
      position: player ? player.position : (position || 'RB'),
      team: player ? player.team : team,
    });
  }

  picks.sort((a, b) => a.overall - b.overall);

  return {
    picks,
    matched: picks.filter((p) => !p.offBoard).length,
    unknown,
    poolSize: board.players.length,
    // What the client needs to know about the draft itself, in the same words
    // the Sleeper reader uses for it.
    draft: {
      draftId: String(leagueId),
      status: draftStatus(detail),
      started: !!(detail.drafted || detail.inProgress),
      complete: !!detail.drafted && !detail.inProgress,
      teams: size,
      inProgress: !!detail.inProgress,
    },
    slots: teams.map((t, i) => ({
      slot: i + 1,
      teamId: String(t.id),
      name: teamName(t),
    })),
  };
}

function draftStatus(detail) {
  if (detail.inProgress) return 'drafting';
  if (detail.drafted) return 'complete';
  return 'pre_draft';
}
