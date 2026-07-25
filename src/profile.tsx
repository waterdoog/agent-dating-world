import {
  ArrowLeft,
  Coins,
  Crosshair,
  MessageSquareText,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Swords,
  Trophy,
  UserRound,
  Vault,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  loginWithAicooUrl,
  type ProfileGame,
  type ProfileMessage,
  type ProfilePlayer,
  type ProfileResult,
  type ProfileView,
} from './api';
import { WorldHeader } from './platform';
import { useAicooSession } from './session';

const COUNT_FORMAT = new Intl.NumberFormat();
const MATCH_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const JOIN_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
});

const RESULT_LABELS: Record<ProfileResult, string> = {
  win: 'Victory',
  loss: 'Defeat',
  draw: 'Draw',
};

function formatDate(value: string | null, formatter = MATCH_DATE_FORMAT): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : formatter.format(date);
}

function usePlayerProfile(enabled: boolean) {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requestNumber, setRequestNumber] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setProfile(null);
      setError('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');

    api
      .profile(controller.signal)
      .then((nextProfile) => {
        setProfile(nextProfile);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : 'The record desk is unavailable.');
        setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, requestNumber]);

  const reload = useCallback(() => {
    setRequestNumber((current) => current + 1);
  }, []);

  return { profile, error, loading, reload };
}

function ProfileLoading() {
  return (
    <main className="profile-state" aria-live="polite">
      <span className="profile-state-mark"><RefreshCw className="spinning" size={30} /></span>
      <p className="kicker">Player records</p>
      <h1>Opening your match book…</h1>
      <p>We’re collecting your balance, career score, and saved conversations.</p>
    </main>
  );
}

function ProfileSignedOut() {
  return (
    <main className="profile-state profile-signed-out">
      <span className="profile-state-mark"><UserRound size={34} /></span>
      <p className="kicker">Private player record</p>
      <h1>Your fights have a home now.</h1>
      <p>
        Sign in to see your N1 Credits, lifetime score, and the conversations from every
        completed match.
      </p>
      <a className="profile-primary" href={loginWithAicooUrl('/profile')}>
        <Sparkles size={18} />
        Sign in with Aicoo
      </a>
    </main>
  );
}

function ProfileError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="profile-state profile-error-state">
      <span className="profile-state-mark"><ShieldAlert size={34} /></span>
      <p className="kicker">Record desk interrupted</p>
      <h1>Your history is still safe.</h1>
      <p role="alert">{message}</p>
      <button className="profile-primary" type="button" onClick={onRetry}>
        <RefreshCw size={18} />
        Try again
      </button>
    </main>
  );
}

function PlayerIdentity({ player }: { player: ProfilePlayer }) {
  const initial = player.displayName.trim().slice(0, 1).toUpperCase() || 'N';

  return (
    <section className="profile-identity" aria-labelledby="profile-name">
      <div className="profile-player-mark" aria-hidden="true">
        <span>{initial}</span>
        <small>PLAYER</small>
      </div>
      <div className="profile-player-copy">
        <p className="kicker">Official fighter record</p>
        <h1 id="profile-name">{player.displayName}</h1>
        <p>
          @{player.handle}
          {player.joinedAt
            ? <span> · in the world since {formatDate(player.joinedAt, JOIN_DATE_FORMAT)}</span>
            : null}
        </p>
      </div>
      <div className="profile-credit-ticket" aria-label={`${player.credits} N1 Credits`}>
        <span><Coins size={18} /> N1 Credits</span>
        <strong>{COUNT_FORMAT.format(player.credits)}</strong>
        <small>Initial grant 1,000 · match wagers are not live yet</small>
      </div>
    </section>
  );
}

function CareerScore({ profile }: { profile: ProfileView }) {
  const { stats } = profile;

  return (
    <section className="profile-career" aria-labelledby="career-heading">
      <header>
        <div>
          <p className="kicker">Career scoreboard</p>
          <h2 id="career-heading">{COUNT_FORMAT.format(stats.played)} games on record</h2>
        </div>
        <a className="profile-play-link" href="/world">
          <Swords size={17} />
          Play Agent Fights
        </a>
      </header>

      <div className="profile-score-line" aria-label="Win, loss, and draw record">
        <div className="score-win">
          <span>W</span>
          <strong>{COUNT_FORMAT.format(stats.wins)}</strong>
          <small>Wins</small>
        </div>
        <div className="score-loss">
          <span>L</span>
          <strong>{COUNT_FORMAT.format(stats.losses)}</strong>
          <small>Losses</small>
        </div>
        <div className="score-draw">
          <span>D</span>
          <strong>{COUNT_FORMAT.format(stats.draws)}</strong>
          <small>Draws</small>
        </div>
        <div className="score-capture">
          <Crosshair size={22} />
          <strong>{COUNT_FORMAT.format(stats.captures)}</strong>
          <small>Secrets captured</small>
        </div>
        <div className="score-leak">
          <Vault size={22} />
          <strong>{COUNT_FORMAT.format(stats.leaks)}</strong>
          <small>Secrets leaked</small>
        </div>
      </div>
    </section>
  );
}

function speakerName(
  message: ProfileMessage,
  game: ProfileGame,
  player: ProfilePlayer,
): string {
  if (player.id && message.speakerId === player.id) return 'Your agent';
  if (game.opponent.id && message.speakerId === game.opponent.id) {
    return game.opponent.displayName;
  }
  return message.kind === 'attack' ? 'Attack agent' : 'Defense agent';
}

function MatchTranscript({
  game,
  player,
}: {
  game: ProfileGame;
  player: ProfilePlayer;
}) {
  return (
    <div className="match-sheet-body">
      <section className="match-transcript" aria-labelledby={`transcript-${game.id}`}>
        <h3 id={`transcript-${game.id}`}>
          <MessageSquareText size={17} />
          Match conversation
        </h3>
        {game.messages.length > 0 ? (
          <ol>
            {game.messages.map((message) => (
              <li className={`message-${message.kind}`} key={message.id}>
                <div>
                  <span>Round {message.round || '—'}</span>
                  <strong>{speakerName(message, game, player)}</strong>
                  <small>{message.kind}</small>
                </div>
                <p>{message.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="profile-transcript-empty">
            This result was saved without a conversation transcript.
          </p>
        )}
      </section>

      <aside className="match-verification" aria-label="Verification record">
        <h3><Crosshair size={17} /> Verified captures</h3>
        {game.captures.length > 0 ? (
          <ol>
            {game.captures.map((capture) => (
              <li key={capture.id}>
                <span>R{capture.round || '—'}</span>
                <strong>{capture.label}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p>No synthetic secrets were verified in this match.</p>
        )}
        <small>This archive is visible only to your signed-in account.</small>
      </aside>
    </div>
  );
}

function MatchSheet({
  game,
  player,
  index,
}: {
  game: ProfileGame;
  player: ProfilePlayer;
  index: number;
}) {
  const resultLabel = RESULT_LABELS[game.result];

  return (
    <article className={`match-sheet result-${game.result}`}>
      <details>
        <summary>
          <span className="match-number">#{String(index + 1).padStart(2, '0')}</span>
          <span className="match-result">
            {game.result === 'win' ? <Trophy size={18} /> : <Swords size={18} />}
            <strong>{resultLabel}</strong>
          </span>
          <span className="match-opponent">
            <small>Opponent</small>
            <strong>{game.opponent.displayName}</strong>
            <span>@{game.opponent.handle}</span>
          </span>
          <span className="match-score" aria-label={`Score ${game.score} to ${game.opponentScore}`}>
            <strong>{game.score}</strong>
            <i>:</i>
            <strong>{game.opponentScore}</strong>
          </span>
          <time dateTime={game.completedAt ?? game.createdAt ?? undefined}>
            {formatDate(game.completedAt ?? game.createdAt)}
          </time>
          <span className="match-open-copy">
            <MessageSquareText size={16} />
            Open chat
          </span>
        </summary>
        <MatchTranscript game={game} player={player} />
      </details>
    </article>
  );
}

function EmptyArchive() {
  return (
    <div className="profile-empty-archive">
      <span aria-hidden="true">01</span>
      <div>
        <p className="kicker">No completed games yet</p>
        <h3>Your first match sheet is waiting.</h3>
        <p>
          Tune both policies, enter the queue, and this archive will keep the result and full
          agent conversation after the fight.
        </p>
      </div>
      <a className="profile-primary" href="/world">
        <Swords size={18} />
        Set up a fight
      </a>
    </div>
  );
}

function PlayerProfile({ profile }: { profile: ProfileView }) {
  return (
    <main className="profile-main">
      <PlayerIdentity player={profile.player} />
      <CareerScore profile={profile} />

      <section className="profile-archive" aria-labelledby="archive-heading">
        <header>
          <div>
            <p className="kicker">Private match archive</p>
            <h2 id="archive-heading">Past game conversations</h2>
          </div>
          <p>Open any result to replay the exchange round by round.</p>
        </header>

        {profile.games.length > 0 ? (
          <div className="match-sheet-stack">
            {profile.games.map((game, index) => (
              <MatchSheet
                game={game}
                player={profile.player}
                index={index}
                key={game.id}
              />
            ))}
          </div>
        ) : (
          <EmptyArchive />
        )}
      </section>
    </main>
  );
}

export function ProfilePage() {
  const { me } = useAicooSession();
  const signedIn = Boolean(me?.signedIn);
  const { profile, error, loading, reload } = usePlayerProfile(signedIn);

  let content;
  if (me === null) content = <ProfileLoading />;
  else if (!me.signedIn) content = <ProfileSignedOut />;
  else if (error && !profile) content = <ProfileError message={error} onRetry={reload} />;
  else if (loading && !profile) content = <ProfileLoading />;
  else if (profile) content = <PlayerProfile profile={profile} />;
  else content = <ProfileLoading />;

  return (
    <div className="world-page profile-page">
      <WorldHeader
        section="Player record"
        me={me}
        returnTo="/profile"
        utility={<a className="header-back" href="/"><ArrowLeft size={16} /> Lobby</a>}
      />
      {content}
    </div>
  );
}
