import type { EspnCredentials } from '../storage';
import type { LeagueSetup, SavedLeague } from '../engine/types';

interface Props {
  league: SavedLeague | null;
  setup: LeagueSetup | null;
  myUserId: string | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  leagueLabel: string;
  espnLeagueId: string | null;
  espnCreds: EspnCredentials;
  onEspnLeagueId: (id: string | null) => void;
  onEspnCreds: (creds: EspnCredentials) => void;
}

const STATUS_WORDS: Record<string, string> = {
  pre_draft: 'has not opened yet',
  drafting: 'is running now',
  paused: 'is paused',
  complete: 'is finished',
};

/**
 * Getting ready to follow a real draft.
 *
 * Two things have to be true before the assistant can help: the app has to know
 * which league you are drafting in, and which manager in it is you. Sleeper
 * does not publish the draft order until minutes before the draft, so the slot
 * cannot be read early. Saying which manager you are can be done now and is
 * remembered, and the slot follows on its own the moment the order is drawn.
 */
export default function AssistantPanel(props: Props) {
  const {
    league, setup, myUserId, busy, error, onRefresh, leagueLabel,
    espnLeagueId, espnCreds, onEspnLeagueId, onEspnCreds,
  } = props;
  const draft = setup?.draft ?? null;
  const seats = setup?.slots ?? [];

  if (!league) {
    return (
      <section className="panel span-2">
        <div className="panel-head">
          <h2 className="eyebrow">Follow a real draft</h2>
        </div>
        <div className="setup-body">
          <p className="hint">
            Choose a Sleeper league above, or give an ESPN league below. With
            neither, the board opens ready for you to enter each pick by hand.
          </p>
          <EspnFields
            leagueId={espnLeagueId}
            creds={espnCreds}
            onLeagueId={onEspnLeagueId}
            onCreds={onEspnCreds}
          />
        </div>
      </section>
    );
  }

  const slot = seats.find((m) => m.userId === myUserId)?.slot;

  return (
    <section className="panel span-2">
      <div className="panel-head">
        <h2 className="eyebrow">Follow a real draft</h2>
        <button type="button" className="btn is-quiet" disabled={busy} onClick={onRefresh}>
          {busy ? 'Checking…' : 'Check Sleeper'}
        </button>
      </div>

      <div className="setup-body">
        <div>
          {!draft && <p className="hint">Not read yet. Press Check Sleeper.</p>}
          {draft && (
            <>
              <p className="eyebrow">The draft</p>
              <p style={{ margin: '2px 0 0' }}>
                {leagueLabel}
                {' '}
                {STATUS_WORDS[draft.status] || draft.status}
              </p>
              <p className="hint">
                {draft.teams + ' teams, ' + draft.rounds + ' rounds, ' + draft.type + '. '}
                {draft.startTime
                  ? 'Starts ' + new Date(draft.startTime).toLocaleString(undefined, {
                    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
                  }) + '. '
                  : ''}
                {slot
                  ? 'You are in seat ' + slot + '.'
                  : (draft.orderIsSet
                    ? 'The order is set. Pick your name above to take your seat.'
                    : 'The draft order is not drawn yet, so no seat is known. '
                      + 'It appears here once Sleeper sets it.')}
              </p>
              {setup && setup.namedTeams > 0 && (
                <p className="hint" style={{ marginTop: 4 }}>
                  {setup.namedTeams + ' of ' + setup.teams
                    + ' seats carry a team name, and the board uses them.'}
                </p>
              )}
            </>
          )}
        </div>

        {error && <div className="banner is-bad"><span>{error}</span></div>}

        <EspnFields
          leagueId={espnLeagueId}
          creds={espnCreds}
          onLeagueId={onEspnLeagueId}
          onCreds={onEspnCreds}
        />

        {draft && !draft.started && (
          <div className="banner">
            <span>
              This draft has not opened. You can still follow it: the board fills as picks land.
              Until then, run a mock instead to get a feel for the room.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

interface EspnProps {
  leagueId: string | null;
  creds: EspnCredentials;
  onLeagueId: (id: string | null) => void;
  onCreds: (creds: EspnCredentials) => void;
}

/**
 * Following a draft on ESPN instead.
 *
 * Two things are worth saying plainly on screen rather than in a readme
 * nobody opens mid-draft.
 *
 * The cookies are a signed-in session, not an ID. They go to this app's own
 * data service and to ESPN, and nowhere else, and they are held for this tab
 * rather than written to disk. Closing the tab forgets them.
 *
 * And whether ESPN publishes picks while a draft is actually running is not
 * something this app can promise. It is unverified, the panel says so, and the
 * board can always be filled by hand instead. Better a tool that says which
 * half it is sure of than one that goes quiet at pick 14.
 */
function EspnFields({ leagueId, creds, onLeagueId, onCreds }: EspnProps) {
  return (
    <div className="espn-fields">
      <p className="eyebrow">ESPN draft</p>
      <label className="field">
        <span className="field-label">League ID</span>
        <input
          type="text"
          inputMode="numeric"
          value={leagueId ?? ''}
          placeholder="from the URL of your ESPN league"
          onChange={(e) => onLeagueId(e.target.value.trim() || null)}
        />
      </label>

      <label className="field">
        <span className="field-label">espn_s2 cookie</span>
        <input
          type="password"
          value={creds.espnS2}
          autoComplete="off"
          placeholder="private leagues only"
          onChange={(e) => onCreds({ ...creds, espnS2: e.target.value.trim() })}
        />
      </label>

      <label className="field">
        <span className="field-label">SWID cookie</span>
        <input
          type="password"
          value={creds.swid}
          autoComplete="off"
          placeholder="private leagues only"
          onChange={(e) => onCreds({ ...creds, swid: e.target.value.trim() })}
        />
      </label>

      <p className="hint">
        A private ESPN league can only be read with your own signed-in session,
        which is what these two cookies are. They are kept for this tab only,
        never written to disk, and sent to this app&rsquo;s data service and to
        ESPN and nowhere else. Close the tab to forget them.
      </p>
      <p className="hint">
        Whether ESPN publishes picks while a draft is running is not something
        this app can promise, so check it against your own draft before you rely
        on it. If nothing arrives, switch to entering picks by hand on the draft
        screen: everything else on the board works the same either way.
      </p>
    </div>
  );
}
