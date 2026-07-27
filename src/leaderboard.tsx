import {
  ArrowLeft,
  Coins,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Swords,
  Trophy,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  loginWithAicooUrl,
  type LeaderboardEntry,
  type LeaderboardView,
} from './api';
import { WorldHeader } from './platform';
import { useAicooSession } from './session';

const COUNT_FORMAT = new Intl.NumberFormat();

function useLeaderboard(enabled: boolean) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requestNumber, setRequestNumber] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLeaderboard(null);
      setError('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');

    api
      .leaderboard(controller.signal)
      .then((nextLeaderboard) => {
        setLeaderboard(nextLeaderboard);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof Error
            ? caught.message
            : 'The N1 Credits board is unavailable.',
        );
        setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, requestNumber]);

  const reload = useCallback(() => {
    setRequestNumber((current) => current + 1);
  }, []);

  return { leaderboard, error, loading, reload };
}

function LeaderboardLoading() {
  return (
    <main className="credits-leaderboard-state" aria-live="polite">
      <span className="credits-leaderboard-state-mark">
        <RefreshCw className="spinning" size={30} />
      </span>
      <p className="kicker">N1 Credits rankings</p>
      <h1>Posting today’s standings…</h1>
      <p>We’re counting every current balance and finding your place on the board.</p>
    </main>
  );
}

function LeaderboardSignedOut() {
  return (
    <main className="credits-leaderboard-state is-signed-out">
      <span className="credits-leaderboard-state-mark">
        <UserRound size={34} />
      </span>
      <p className="kicker">Signed-in players only</p>
      <h1>See where your credits stand.</h1>
      <p>
        Sign in with your Aicoo identity to open the N1 Credits leaderboard and find
        your current rank.
      </p>
      <a
        className="credits-leaderboard-action"
        href={loginWithAicooUrl('/leaderboard')}
      >
        <Sparkles size={18} />
        Sign in with Aicoo
      </a>
    </main>
  );
}

function LeaderboardError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="credits-leaderboard-state is-error">
      <span className="credits-leaderboard-state-mark">
        <ShieldAlert size={34} />
      </span>
      <p className="kicker">Standings desk interrupted</p>
      <h1>The board missed a signal.</h1>
      <p role="alert">{message}</p>
      <button
        className="credits-leaderboard-action"
        type="button"
        onClick={onRetry}
      >
        <RefreshCw size={18} />
        Try again
      </button>
    </main>
  );
}

function sameEntry(
  first: LeaderboardEntry,
  second: LeaderboardEntry | null,
): boolean {
  return Boolean(
    second
    && first.rank === second.rank
    && first.handle.toLocaleLowerCase() === second.handle.toLocaleLowerCase(),
  );
}

function LeaderboardEntryContent({ entry }: { entry: LeaderboardEntry }) {
  const initial = entry.displayName.trim().slice(0, 1).toUpperCase() || 'N';
  const champion = entry.rank === 1;

  return (
    <>
      <span className="credits-rank-mark" aria-label={`Rank ${entry.rank}`}>
        {champion ? <Trophy size={21} aria-hidden="true" /> : null}
        <strong>#{COUNT_FORMAT.format(entry.rank)}</strong>
        <small>{champion ? 'Champion' : 'Rank'}</small>
      </span>

      <span className="credits-rank-player">
        <span className="credits-rank-initial" aria-hidden="true">{initial}</span>
        <span>
          <strong>{entry.displayName}</strong>
          <small>
            @{entry.handle} · {COUNT_FORMAT.format(entry.played)} played
          </small>
        </span>
        {entry.isSelf ? <em>You</em> : null}
      </span>

      <span
        className="credits-rank-record"
        aria-label={`${entry.wins} wins, ${entry.losses} losses, ${entry.draws} draws`}
      >
        <strong>
          {COUNT_FORMAT.format(entry.wins)}
          <i>–</i>
          {COUNT_FORMAT.format(entry.losses)}
          <i>–</i>
          {COUNT_FORMAT.format(entry.draws)}
        </strong>
        <small>W · L · D</small>
      </span>

      <span
        className="credits-rank-balance"
        aria-label={`${entry.credits} N1 Credits`}
      >
        <Coins size={17} aria-hidden="true" />
        <strong>{COUNT_FORMAT.format(entry.credits)}</strong>
        <small>N1 Credits</small>
      </span>
    </>
  );
}

function LeaderboardEmpty() {
  return (
    <div className="credits-leaderboard-empty">
      <span aria-hidden="true">01</span>
      <div>
        <p className="kicker">No ranked players yet</p>
        <h2>The first match sheet is still blank.</h2>
        <p>Finish an Agent Fights bout to give the standings desk something to post.</p>
      </div>
      <a className="credits-leaderboard-action" href="/world">
        <Swords size={18} />
        Play Agent Fights
      </a>
    </div>
  );
}

function LeaderboardBoard({ leaderboard }: { leaderboard: LeaderboardView }) {
  const listedCurrentPlayer = leaderboard.entries.some(
    (entry) => entry.isSelf || sameEntry(entry, leaderboard.currentPlayer),
  );

  return (
    <main className="credits-leaderboard-main">
      <header className="credits-leaderboard-hero">
        <div>
          <p className="kicker">N1 Credits rankings</p>
          <h1>Every balance.<br />One board.</h1>
        </div>
        <p>
          Current N1 Credit balances across Virtual N1 World. These are closed-loop
          game points—not cash, cryptocurrency, or anything redeemable.
        </p>
      </header>

      <section
        className="credits-leaderboard-board"
        aria-labelledby="credits-leaderboard-heading"
      >
        <header>
          <div>
            <p className="section-label">Live standings</p>
            <h2 id="credits-leaderboard-heading">N1 Credits leaderboard</h2>
          </div>
          <span className="credits-ranked-count">
            <UsersRound size={17} aria-hidden="true" />
            {COUNT_FORMAT.format(leaderboard.totalPlayers)} ranked
          </span>
        </header>

        {leaderboard.entries.length > 0 ? (
          <ol className="credits-rank-list">
            {leaderboard.entries.map((entry, index) => {
              const isSelf = entry.isSelf || sameEntry(entry, leaderboard.currentPlayer);
              const renderedEntry = isSelf ? { ...entry, isSelf: true } : entry;
              return (
                <li
                  className={[
                    'credits-rank-row',
                    renderedEntry.rank === 1 ? 'is-first' : '',
                    renderedEntry.isSelf ? 'is-self' : '',
                  ].filter(Boolean).join(' ')}
                  aria-current={renderedEntry.isSelf ? 'true' : undefined}
                  key={`${renderedEntry.rank}:${renderedEntry.handle}:${index}`}
                >
                  <LeaderboardEntryContent entry={renderedEntry} />
                </li>
              );
            })}
          </ol>
        ) : (
          <LeaderboardEmpty />
        )}
      </section>

      {!listedCurrentPlayer && leaderboard.currentPlayer ? (
        <section
          className="credits-current-rank"
          aria-labelledby="credits-current-rank-heading"
        >
          <header>
            <div>
              <p className="section-label">Your position</p>
              <h2 id="credits-current-rank-heading">Still on the official board.</h2>
            </div>
            <small>Outside today’s top list</small>
          </header>
          <div
            className={[
              'credits-rank-row',
              leaderboard.currentPlayer.rank === 1 ? 'is-first' : '',
              'is-self',
            ].filter(Boolean).join(' ')}
            aria-current="true"
          >
            <LeaderboardEntryContent entry={leaderboard.currentPlayer} />
          </div>
        </section>
      ) : null}

      <footer className="credits-leaderboard-note">
        <Coins size={17} aria-hidden="true" />
        <p>
          Balances move only through versioned game rules. New players begin with
          1,000 N1 Credits; Agent Fights currently settles 200 per player.
        </p>
      </footer>
    </main>
  );
}

export function LeaderboardPage() {
  const { me } = useAicooSession();
  const signedIn = Boolean(me?.signedIn);
  const { leaderboard, error, loading, reload } = useLeaderboard(signedIn);

  let content;
  if (me === null) content = <LeaderboardLoading />;
  else if (!me.signedIn) content = <LeaderboardSignedOut />;
  else if (error && !leaderboard) {
    content = <LeaderboardError message={error} onRetry={reload} />;
  } else if (loading && !leaderboard) content = <LeaderboardLoading />;
  else if (leaderboard) content = <LeaderboardBoard leaderboard={leaderboard} />;
  else content = <LeaderboardLoading />;

  return (
    <div className="world-page credits-leaderboard-page">
      <WorldHeader
        section="N1 Credits leaderboard"
        me={me}
        returnTo="/leaderboard"
        utility={(
          <a className="header-back" href="/">
            <ArrowLeft size={16} />
            Lobby
          </a>
        )}
      />
      {content}
    </div>
  );
}
