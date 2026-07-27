import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type {
  WorldCapture,
  WorldGame,
  WorldMessage,
  WorldPlayer,
} from './api';
import './fight-arena.css';

const ROUND_PRESENTATION_MS = 1_850;
const REDUCED_ROUND_PRESENTATION_MS = 900;
const SPEECH_SNIPPET_LENGTH = 82;

interface DirectionalRound {
  attacker: WorldPlayer;
  defender: WorldPlayer;
  attack: WorldMessage;
  defense: WorldMessage;
  captures: WorldCapture[];
}

interface VerifiedRound {
  key: string;
  round: number;
  leftToRight: DirectionalRound;
  rightToLeft: DirectionalRound;
}

interface ArenaProgressStyle extends CSSProperties {
  '--arena-progress': number;
}

interface SplatterStyle extends CSSProperties {
  '--splatter-x': string;
  '--splatter-y': string;
  '--splatter-turn': string;
}

export interface ArenaStageProps {
  game: WorldGame;
  complete: boolean;
  running: boolean;
}

function orderedPlayers(
  players: readonly WorldPlayer[],
): [WorldPlayer | null, WorldPlayer | null] {
  const left = players.find((player) => player.isSelf) ?? players[0] ?? null;
  const right = players.find((player) => player.id !== left?.id) ?? null;
  return [left, right];
}

function directionalRound(
  attacker: WorldPlayer,
  defender: WorldPlayer,
  roundMessages: readonly WorldMessage[],
  roundCaptures: readonly WorldCapture[],
): DirectionalRound | null {
  const attack = roundMessages.find(
    (message) =>
      message.kind === 'attack'
      && message.speakerId === attacker.id
      && message.targetId === defender.id,
  );
  const defense = roundMessages.find(
    (message) =>
      message.kind === 'defense'
      && message.speakerId === defender.id
      && message.targetId === attacker.id,
  );

  if (!attack || !defense) return null;

  return {
    attacker,
    defender,
    attack,
    defense,
    captures: roundCaptures.filter(
      (capture) =>
        capture.capturedById === attacker.id
        && capture.targetId === defender.id,
    ),
  };
}

function verifiedRounds(
  game: WorldGame,
  left: WorldPlayer | null,
  right: WorldPlayer | null,
): VerifiedRound[] {
  if (!left || !right) return [];

  const candidateRounds = new Set(
    game.messages
      .map((message) => message.round)
      .filter((round) => round > 0 && round <= game.maxRounds),
  );

  return [...candidateRounds]
    .sort((first, second) => first - second)
    .flatMap((round) => {
      const roundMessages = game.messages.filter((message) => message.round === round);
      if (roundMessages.length !== 4) return [];
      const roundCaptures = game.captures.filter((capture) => capture.round === round);
      const leftToRight = directionalRound(left, right, roundMessages, roundCaptures);
      const rightToLeft = directionalRound(right, left, roundMessages, roundCaptures);

      if (!leftToRight || !rightToLeft) return [];
      return [{
        key: `${game.id}:round:${round}`,
        round,
        leftToRight,
        rightToLeft,
      }];
    });
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

function speechSnippet(message: WorldMessage | undefined, fallback: string): string {
  const text = message?.text.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return fallback;
  if (text.length <= SPEECH_SNIPPET_LENGTH) return text;
  return `${text.slice(0, SPEECH_SNIPPET_LENGTH - 1).trimEnd()}…`;
}

function playerInitials(player: WorldPlayer | null): string {
  if (!player) return '··';
  const parts = player.displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return player.displayName.slice(0, 2).toUpperCase();
}

function captureCountCopy(count: number): string {
  if (count === 0) return 'shield held';
  return `${count} capture${count === 1 ? '' : 's'} verified`;
}

function playerStateCopy(player: WorldPlayer | null, fallback: string): string {
  if (!player) return `${fallback} is still connecting.`;
  const shields = Math.min(3, Math.max(0, player.shields));
  return `${player.displayName}: ${player.score} point${player.score === 1 ? '' : 's'}, `
    + `${shields} of 3 shields remaining.`;
}

function directionStatus(direction: DirectionalRound): string {
  const count = direction.captures.length;
  if (count === 0) {
    return `${direction.attacker.displayName} attacked ${direction.defender.displayName}; `
      + `${direction.defender.displayName} blocked the exchange.`;
  }
  return `${direction.attacker.displayName} attacked ${direction.defender.displayName}; `
    + `${count} server-verified capture${count === 1 ? ' was' : 's were'} recorded.`;
}

function roundStatus(round: VerifiedRound | null, game: WorldGame, complete: boolean): string {
  if (round) {
    return `${complete ? 'Match complete. ' : ''}Round ${round.round} of ${game.maxRounds}. `
      + `${directionStatus(round.leftToRight)} ${directionStatus(round.rightToLeft)}`;
  }
  if (complete) {
    const finalRound = Math.floor(game.messages.length / 4);
    return `Match complete after ${finalRound} rounds. No complete exchange is available to replay.`;
  }
  return `Round ${Math.max(1, game.round)} of ${game.maxRounds} is waiting for both `
    + 'server-verified attacks and defenses.';
}

function PaperPuppet({
  role,
}: {
  role: 'attacker' | 'defender';
}) {
  return (
    <svg
      className={`fighter-arena__paper-puppet is-${role}`}
      viewBox="0 0 160 210"
      aria-hidden="true"
      focusable="false"
    >
      <path className="fighter-arena__puppet-leg" d="M59 136 L53 184" />
      <path className="fighter-arena__puppet-leg" d="M101 136 L108 184" />
      <path className="fighter-arena__puppet-shoe" d="M34 190 Q48 178 61 187 L61 198 L34 198 Z" />
      <path className="fighter-arena__puppet-shoe" d="M100 187 Q114 178 130 190 L130 198 L100 198 Z" />

      <path className="fighter-arena__puppet-neck" d="M68 62 L92 62 L96 82 L64 82 Z" />
      <path className="fighter-arena__puppet-torso" d="M48 77 L112 77 L122 145 L38 145 Z" />
      <circle className="fighter-arena__puppet-pin" cx="49" cy="88" r="6" />
      <circle className="fighter-arena__puppet-pin" cx="111" cy="88" r="6" />
      <circle className="fighter-arena__puppet-pin" cx="59" cy="140" r="5" />
      <circle className="fighter-arena__puppet-pin" cx="101" cy="140" r="5" />

      {role === 'attacker' ? (
        <>
          <path className="fighter-arena__puppet-arm" d="M49 88 Q32 100 24 124" />
          <circle className="fighter-arena__puppet-glove" cx="21" cy="132" r="12" />
          <path className="fighter-arena__puppet-arm" d="M111 88 Q128 76 140 92" />
          <circle className="fighter-arena__puppet-glove" cx="145" cy="98" r="12" />
          <path className="fighter-arena__puppet-flash" d="M134 111 L151 114 L140 124 L153 134 L132 131 Z" />
        </>
      ) : (
        <>
          <path className="fighter-arena__puppet-arm" d="M49 88 Q31 105 31 131" />
          <circle className="fighter-arena__puppet-hand" cx="31" cy="136" r="8" />
          <path className="fighter-arena__puppet-arm" d="M111 88 Q126 99 127 119" />
          <path
            className="fighter-arena__puppet-shield"
            d="M108 104 L145 96 L148 132 Q143 157 127 167 Q111 157 106 132 Z"
          />
          <circle className="fighter-arena__puppet-shield-pin" cx="127" cy="126" r="6" />
        </>
      )}

      <circle className="fighter-arena__puppet-ear" cx="53" cy="41" r="8" />
      <circle className="fighter-arena__puppet-ear" cx="107" cy="41" r="8" />
      <circle className="fighter-arena__puppet-head" cx="80" cy="41" r="29" />
      <path className="fighter-arena__puppet-hair" d="M53 39 Q56 8 82 10 Q105 10 109 36 Q94 25 82 27 Q68 27 53 39 Z" />
      <circle className="fighter-arena__puppet-eye" cx="69" cy="42" r="3" />
      <circle className="fighter-arena__puppet-eye" cx="91" cy="42" r="3" />
      <path className="fighter-arena__puppet-mouth" d="M70 55 Q80 61 91 54" />
      <path className="fighter-arena__puppet-seam" d="M54 110 L106 110" />
      <circle className="fighter-arena__puppet-badge" cx="80" cy="126" r="9" />
    </svg>
  );
}

const SPLATTER_BITS: SplatterStyle[] = [
  { '--splatter-x': '-31px', '--splatter-y': '-24px', '--splatter-turn': '-24deg' },
  { '--splatter-x': '4px', '--splatter-y': '-39px', '--splatter-turn': '18deg' },
  { '--splatter-x': '34px', '--splatter-y': '-18px', '--splatter-turn': '31deg' },
  { '--splatter-x': '-27px', '--splatter-y': '18px', '--splatter-turn': '14deg' },
  { '--splatter-x': '30px', '--splatter-y': '23px', '--splatter-turn': '-19deg' },
];

function PaperSplatter() {
  return (
    <span className="fighter-arena__paper-splatter" aria-hidden="true">
      {SPLATTER_BITS.map((style, index) => (
        <i key={index} style={style} />
      ))}
    </span>
  );
}

function ShieldPips({ value }: { value: number }) {
  const shields = Math.min(3, Math.max(0, value));
  return (
    <span className="fighter-arena__shield-pips">
      {[0, 1, 2].map((index) => (
        <i key={index} className={index < shields ? 'is-full' : 'is-empty'} />
      ))}
    </span>
  );
}

function PlayerTape({
  player,
  side,
}: {
  player: WorldPlayer | null;
  side: 'left' | 'right';
}) {
  return (
    <div className={`fighter-arena__player-tape is-${side}`}>
      <div className="fighter-arena__player-tape-copy">
        <span>{player?.isSelf ? 'Your fighter' : side === 'left' ? 'Corner one' : 'Corner two'}</span>
        <strong>{player?.displayName ?? 'Connecting'}</strong>
        <small>attack + defense</small>
      </div>
      <div className="fighter-arena__player-tape-stats">
        <span className="fighter-arena__score-chip">
          <strong>{player?.score ?? '—'}</strong>
          <small>pts</small>
        </span>
        <ShieldPips value={player?.shields ?? 0} />
      </div>
    </div>
  );
}

function RoleFigure({
  player,
  role,
  side,
  direction,
}: {
  player: WorldPlayer | null;
  role: 'attacker' | 'defender';
  side: 'left' | 'right';
  direction: DirectionalRound | null;
}) {
  const isAttacker = role === 'attacker';
  const captures = direction?.captures.length ?? 0;
  const outcomeClass = !direction
    ? 'is-idle'
    : captures > 0 ? 'is-hit' : 'is-block';
  const speech = isAttacker
    ? speechSnippet(direction?.attack, 'Preparing a conversational probe…')
    : speechSnippet(direction?.defense, 'Holding the protected line…');

  return (
    <div
      className={[
        'fighter-arena__role-figure',
        `is-${role}`,
        `is-${side}`,
        outcomeClass,
        player?.isSelf ? 'is-self' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className={`fighter-arena__speech is-${isAttacker ? 'attack' : 'defense'}`}>
        <span>{isAttacker ? 'Probe' : 'Reply'}</span>
        <q>{speech}</q>
      </div>

      <div className="fighter-arena__puppet-space">
        <div className="fighter-arena__puppet-motion">
          <div className="fighter-arena__puppet-orientation">
            <PaperPuppet role={role} />
          </div>
        </div>
        {role === 'defender' && direction ? (
          <>
            {captures === 0 ? <span className="fighter-arena__shield-burst">BLOCK</span> : null}
            {captures > 0 ? <PaperSplatter /> : null}
          </>
        ) : null}
      </div>

      <div className="fighter-arena__role-label">
        <span className="fighter-arena__initials">{playerInitials(player)}</span>
        <span>
          <small>{isAttacker ? 'Attacker' : 'Defender'}</small>
          <strong>{player?.displayName ?? 'Awaiting fighter'}</strong>
        </span>
      </div>
    </div>
  );
}

function FightLane({
  direction,
  flow,
  left,
  right,
}: {
  direction: DirectionalRound | null;
  flow: 'left-to-right' | 'right-to-left';
  left: WorldPlayer | null;
  right: WorldPlayer | null;
}) {
  const leftToRight = flow === 'left-to-right';
  const attacker = leftToRight ? left : right;
  const defender = leftToRight ? right : left;
  const captureCount = direction?.captures.length ?? 0;
  const resultClass = !direction
    ? 'is-pending'
    : captureCount > 0 ? 'is-capture' : 'is-shield';

  return (
    <div className={`fighter-arena__lane is-${leftToRight ? 'ltr' : 'rtl'}`}>
      <RoleFigure
        player={attacker}
        role="attacker"
        side={leftToRight ? 'left' : 'right'}
        direction={direction}
      />
      <div className={`fighter-arena__exchange ${resultClass}`}>
        <span className="fighter-arena__exchange-line" />
        <span className="fighter-arena__exchange-arrow">{leftToRight ? '→' : '←'}</span>
        <span className="fighter-arena__outcome">
          {direction ? captureCountCopy(captureCount) : 'server pending'}
        </span>
      </div>
      <RoleFigure
        player={defender}
        role="defender"
        side={leftToRight ? 'right' : 'left'}
        direction={direction}
      />
    </div>
  );
}

export function ArenaStage({ game, complete, running }: ArenaStageProps) {
  const headingId = useId();
  const reducedMotion = usePrefersReducedMotion();
  const [left, right] = useMemo(() => orderedPlayers(game.players), [game.players]);
  const completedRounds = useMemo(
    () => verifiedRounds(game, left, right),
    [game, left, right],
  );
  const [roundQueue, setRoundQueue] = useState<VerifiedRound[]>(() => {
    const latest = completedRounds[completedRounds.length - 1];
    return latest ? [latest] : [];
  });
  const observedRoundKeys = useRef(
    new Set(completedRounds.map((round) => round.key)),
  );
  const observedGameId = useRef(game.id);

  useEffect(() => {
    const gameChanged = observedGameId.current !== game.id;
    if (gameChanged) {
      observedGameId.current = game.id;
      observedRoundKeys.current = new Set(completedRounds.map((round) => round.key));
      const latest = completedRounds[completedRounds.length - 1];
      setRoundQueue(latest ? [latest] : []);
      return;
    }

    const freshRounds = completedRounds.filter(
      (round) => !observedRoundKeys.current.has(round.key),
    );
    if (freshRounds.length === 0) return;

    for (const round of freshRounds) observedRoundKeys.current.add(round.key);
    setRoundQueue((current) => {
      const queuedKeys = new Set(current.map((round) => round.key));
      return [
        ...current,
        ...freshRounds.filter((round) => !queuedKeys.has(round.key)),
      ];
    });
  }, [completedRounds, game.id]);

  const activeRound = roundQueue[0] ?? null;

  useEffect(() => {
    if (!activeRound) return;
    const timer = window.setTimeout(() => {
      setRoundQueue((current) =>
        current[0]?.key === activeRound.key ? current.slice(1) : current);
    }, reducedMotion ? REDUCED_ROUND_PRESENTATION_MS : ROUND_PRESENTATION_MS);
    return () => window.clearTimeout(timer);
  }, [activeRound, reducedMotion]);

  const latestCompletedRound = completedRounds[completedRounds.length - 1] ?? null;
  const shownRound = activeRound ?? latestCompletedRound;
  const waitingForServer = !complete && running && !activeRound;
  const displayedRound = waitingForServer ? null : shownRound;
  const maxRounds = Math.max(1, game.maxRounds);
  const finalCompletedRound = latestCompletedRound?.round
    ?? Math.floor(game.messages.length / 4);
  const rawProgressRound = activeRound?.round
    ?? (complete
      ? finalCompletedRound
      : shownRound?.round ?? Math.max(0, game.round - 1));
  const progressRound = Math.min(maxRounds, Math.max(0, rawProgressRound));
  const progressStyle: ArenaProgressStyle = {
    '--arena-progress': progressRound / maxRounds,
  };
  const stageRound = waitingForServer
    ? Math.min(maxRounds, (shownRound?.round ?? 0) + 1)
    : shownRound?.round ?? progressRound;
  const roundDigits = String(maxRounds).length;
  const roundLabel = String(progressRound).padStart(roundDigits, '0');
  const maxRoundLabel = String(maxRounds).padStart(roundDigits, '0');
  const queuedAfterActive = Math.max(0, roundQueue.length - 1);
  const stageKey = activeRound?.key
    ?? (waitingForServer
      ? `sparring:${game.id}:${stageRound}`
      : `settled:${shownRound?.key ?? game.id}`);
  const title = activeRound
    ? `Round ${activeRound.round}: both corners move.`
    : complete
      ? 'The paper settles. The result stands.'
      : waitingForServer && shownRound
        ? `Round ${Math.min(maxRounds, shownRound.round + 1)} is being forged live.`
        : waitingForServer
          ? 'Both corners are already trading probes.'
          : shownRound
            ? `Round ${shownRound.round} is verified. The corners reset.`
            : 'The corners are waiting for the server bell.';

  return (
    <section
      className={[
        'fighter-arena',
        activeRound ? 'fighter-arena--animating' : '',
        waitingForServer ? 'fighter-arena--sparring' : '',
        complete ? 'fighter-arena--complete' : '',
      ].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
    >
      <header className="fighter-arena__header">
        <div className="fighter-arena__heading">
          <p>
            <span className="fighter-arena__live-pip" aria-hidden="true" />
            {complete && !activeRound ? 'Final tableau' : 'Server-verified arena'}
          </p>
          <h2 id={headingId}>{title}</h2>
        </div>

        <div className="fighter-arena__round-meter">
          <div className="fighter-arena__round-copy">
            <span>Round progress</span>
            <strong>{roundLabel} / {maxRoundLabel}</strong>
          </div>
          <div
            className="fighter-arena__progress-track"
            role="progressbar"
            aria-label="Match round progress"
            aria-valuemin={0}
            aria-valuemax={maxRounds}
            aria-valuenow={progressRound}
            aria-valuetext={`Round ${progressRound} of ${maxRounds}`}
          >
            <span style={progressStyle} />
          </div>
          {queuedAfterActive > 0 ? (
            <small>{queuedAfterActive} more verified round{queuedAfterActive === 1 ? '' : 's'} queued</small>
          ) : (
            <small>{complete ? 'All exchanges recorded' : 'Both directions resolve together'}</small>
          )}
        </div>
      </header>

      <p
        className="fighter-arena__accessible-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {waitingForServer
          ? `Round ${Math.min(maxRounds, (shownRound?.round ?? 0) + 1)} of ${maxRounds} `
            + 'is being generated. Both attackers are probing while both defenders hold guard.'
          : roundStatus(activeRound ?? shownRound, game, complete)}
      </p>
      <dl className="fighter-arena__accessible-scoreboard" aria-label="Match score and shields">
        <dt>{left?.displayName ?? 'Corner one'}</dt>
        <dd>{playerStateCopy(left, 'Corner one')}</dd>
        <dt>{right?.displayName ?? 'Corner two'}</dt>
        <dd>{playerStateCopy(right, 'Corner two')}</dd>
      </dl>

      <div
        className="fighter-arena__stage"
        key={stageKey}
        aria-hidden="true"
      >
        <PlayerTape player={left} side="left" />
        <div className="fighter-arena__round-stamp">
          <small>
            {activeRound
              ? 'NOW PLAYING'
              : complete
                ? 'FINAL'
                : waitingForServer
                  ? 'IN MOTION'
                  : 'BETWEEN ROUNDS'}
          </small>
          <strong>R{String(stageRound).padStart(roundDigits, '0')}</strong>
        </div>
        <PlayerTape player={right} side="right" />

        <div className="fighter-arena__lanes">
          <FightLane
            direction={displayedRound?.leftToRight ?? null}
            flow="left-to-right"
            left={left}
            right={right}
          />
          <div className="fighter-arena__lane-divider">
            <span>SIMULTANEOUS EXCHANGE</span>
          </div>
          <FightLane
            direction={displayedRound?.rightToLeft ?? null}
            flow="right-to-left"
            left={left}
            right={right}
          />
        </div>
      </div>

      <footer className="fighter-arena__legend" aria-hidden="true">
        <span><i className="is-shield" /> No verified capture · shield holds</span>
        <span><i className="is-capture" /> New server capture · paper stagger</span>
        <span>Four scoped bodies · two human players</span>
      </footer>
    </section>
  );
}
