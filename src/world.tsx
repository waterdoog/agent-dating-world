import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Crosshair,
  Eye,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Swords,
  Trophy,
  UsersRound,
  Vault,
} from 'lucide-react';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  api,
  loginWithAicooUrl,
  type Me,
  type WorldConfig,
  type WorldGame,
  type WorldPlayer,
  type WorldRuntimeEvent,
  type WorldSecret,
  type WorldView,
} from './api';
import { ArenaStage } from './fight-arena';
import { WorldHeader } from './platform';
import { useAicooSession } from './session';

const POLL_INTERVAL_MS = 2_000;
const RUNNER_KICK_INTERVAL_MS = 750;
const POLICY_MIN_LENGTH = 20;
const POLICY_MAX_LENGTH = 2_000;

type WorldAction =
  | 'joining'
  | 'readying'
  | 'saving-policy'
  | 'restarting'
  | null;

interface LiveWorldTurn {
  turnId: string;
  round: number;
  kind: 'attack' | 'defense';
  speakerId: string;
  targetId: string;
  text: string;
  complete: boolean;
}

function useFighterGame(enabled: boolean) {
  const [world, setWorld] = useState<WorldView | null>(null);
  const [liveTurns, setLiveTurns] = useState<LiveWorldTurn[]>([]);
  const [error, setError] = useState('');
  const [action, setAction] = useState<WorldAction>(null);
  const [runnerActive, setRunnerActive] = useState(false);
  const mutationInFlight = useRef(false);
  const mutationEpoch = useRef(0);
  const runnerInFlight = useRef(false);
  const lastRunnerKickAt = useRef(0);
  const pollController = useRef<AbortController | null>(null);

  const publishWorld = useCallback((nextWorld: WorldView) => {
    startTransition(() => setWorld(nextWorld));
    setLiveTurns((current) => current.filter((turn) => {
      if (!nextWorld.game || !turn.turnId.startsWith(`${nextWorld.game.id}:`)) {
        return false;
      }
      return !nextWorld.game.messages.some(
        (message) =>
          message.round === turn.round
          && message.kind === turn.kind
          && message.speakerId === turn.speakerId
          && message.targetId === turn.targetId,
      );
    }));
  }, []);

  const observeRuntimeEvent = useCallback((event: WorldRuntimeEvent) => {
    setLiveTurns((current) => {
      const existing = current.find((turn) => turn.turnId === event.turnId);
      const nextTurn: LiveWorldTurn = {
        turnId: event.turnId,
        round: event.round,
        kind: event.kind,
        speakerId: event.speakerId,
        targetId: event.targetId,
        text: event.type === 'turn-start'
          ? existing?.text ?? ''
          : event.text.slice(0, 1_600),
        complete: event.type === 'turn-complete',
      };
      return existing
        ? current.map((turn) => turn.turnId === event.turnId ? nextTurn : turn)
        : [...current, nextTurn].slice(-4);
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setWorld(null);
      setLiveTurns([]);
      setError('');
      setRunnerActive(false);
      return;
    }

    let disposed = false;
    let timer = 0;

    const poll = async () => {
      if (disposed) return;
      if (mutationInFlight.current) {
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      const controller = new AbortController();
      pollController.current = controller;
      try {
        const nextWorld = await api.world(controller.signal);
        if (disposed) return;
        publishWorld(nextWorld);
        setError('');
        if (
          nextWorld.phase === 'playing' &&
          nextWorld.game?.status === 'playing' &&
          !runnerInFlight.current &&
          Date.now() - lastRunnerKickAt.current >= RUNNER_KICK_INTERVAL_MS
        ) {
          runnerInFlight.current = true;
          setRunnerActive(true);
          lastRunnerKickAt.current = Date.now();
          const runnerMutationEpoch = mutationEpoch.current;
          void api.runWorld(observeRuntimeEvent)
            .then((completedWorld) => {
              if (
                !disposed &&
                mutationEpoch.current === runnerMutationEpoch
              ) {
                publishWorld(completedWorld);
              }
            })
            .catch((caught) => {
              if (
                !disposed &&
                mutationEpoch.current === runnerMutationEpoch
              ) {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : 'The server scheduler paused this match.',
                );
                setLiveTurns([]);
              }
            })
            .finally(() => {
              runnerInFlight.current = false;
              if (!disposed) setRunnerActive(false);
            });
        }
      } catch (caught) {
        if (disposed || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : 'The match desk lost its signal.');
      } finally {
        if (pollController.current === controller) pollController.current = null;
        if (!disposed) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      pollController.current?.abort();
      pollController.current = null;
    };
  }, [enabled, observeRuntimeEvent, publishWorld]);

  const runMutation = useCallback(async (
    nextAction: Exclude<WorldAction, null>,
    operation: () => Promise<WorldView>,
  ) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    mutationEpoch.current += 1;
    pollController.current?.abort();
    setAction(nextAction);
    setError('');

    try {
      const nextWorld = await operation();
      publishWorld(nextWorld);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The match desk could not finish that action.');
    } finally {
      mutationInFlight.current = false;
      setAction(null);
    }
  }, [publishWorld]);

  const join = useCallback(
    () => runMutation('joining', () => api.joinWorld()),
    [runMutation],
  );

  const ready = useCallback(
    (attackPolicy: string, defensePolicy: string) =>
      runMutation('readying', async () => {
        await api.updateWorldConfig(attackPolicy, defensePolicy);
        return api.readyWorld();
      }),
    [runMutation],
  );

  const playAgain = useCallback(
    () => runMutation('restarting', () => api.playAgain()),
    [runMutation],
  );

  const savePolicy = useCallback(
    (attackPolicy: string, defensePolicy: string) =>
      runMutation(
        'saving-policy',
        () => api.updateWorldConfig(attackPolicy, defensePolicy),
      ),
    [runMutation],
  );

  return {
    world,
    liveTurns,
    runnerActive,
    error,
    action,
    join,
    ready,
    savePolicy,
    playAgain,
  };
}

function GameScopePromise() {
  return (
    <div className="fight-scope-promise">
      <LockKeyhole size={18} aria-hidden="true" />
      <p>
        <strong>Two sealed roles per player, one fair fight.</strong>
        Attack gets your attack policy only. Defense gets your defend policy plus this match’s
        three synthetic capture phrases. Neither side receives your COO, USER, email, calendar,
        todos, or write access.
      </p>
    </div>
  );
}

function WorldEntry({
  me,
  loading,
  joining,
  error,
  onJoin,
}: {
  me: Me | null;
  loading: boolean;
  joining: boolean;
  error: string;
  onJoin: () => void;
}) {
  const signedIn = Boolean(me?.signedIn);

  return (
    <main className="fight-entry">
      <section className="fight-entry-copy">
        <p className="kicker">Room 01 · private 1v1 matches</p>
        <h1>Write the rules. Watch them fight.</h1>
        <p className="fight-entry-lede">
          Bring one Fighter into an automated bout of up to 100 rounds. You choose how it sets
          conversational traps and protects three fixed synthetic capture phrases; lose all three
          and the match ends immediately.
        </p>

        {me === null ? (
          <span className="fight-primary is-loading">
            <RefreshCw className="spinning" size={19} />
            Checking Aicoo session…
          </span>
        ) : signedIn ? (
          <button
            className="fight-primary"
            type="button"
            onClick={onJoin}
            disabled={joining || loading}
          >
            {joining || loading
              ? <RefreshCw className="spinning" size={19} />
              : <Swords size={19} />}
            {joining ? 'Preparing your desk…' : loading ? 'Opening the room…' : 'Start a new match'}
          </button>
        ) : (
          <a className="fight-primary" href={loginWithAicooUrl('/world')}>
            <Sparkles size={19} />
            Sign in with Aicoo
          </a>
        )}

        {error ? <p className="fight-error" role="alert">{error}</p> : null}
        <GameScopePromise />
      </section>

      <div className="fight-entry-table" aria-hidden="true">
        <span className="entry-table-number">MATCH 001</span>
        <div className="entry-corner entry-corner-attack">
          <Crosshair size={21} />
          <strong>ATTACK</strong>
          <small>probe · persuade · verify</small>
        </div>
        <span className="entry-versus">VS</span>
        <div className="entry-corner entry-corner-defend">
          <ShieldCheck size={21} />
          <strong>DEFEND</strong>
          <small>deflect · protect · survive</small>
        </div>
        <span className="entry-round-stamp">100 MAX</span>
      </div>
    </main>
  );
}

function VaultList({
  secrets,
  compact = false,
}: {
  secrets: WorldSecret[];
  compact?: boolean;
}) {
  return (
    <ol className={`fight-vault-list ${compact ? 'is-compact' : ''}`} aria-label="Your capture phrases">
      {secrets.map((secret, index) => (
        <li key={secret.id}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <small>{secret.label}</small>
            <code>{secret.value}</code>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PolicyField({
  mode,
  value,
  onChange,
}: {
  mode: 'attack' | 'defense';
  value: string;
  onChange: (value: string) => void;
}) {
  const isAttack = mode === 'attack';
  const Icon = isAttack ? Crosshair : ShieldCheck;
  const inputId = `${mode}-policy`;
  const hintId = `${mode}-policy-hint`;
  const isShort = value.trim().length < POLICY_MIN_LENGTH;

  return (
    <label className={`fight-policy-field is-${mode}`} htmlFor={inputId}>
      <span className="policy-field-heading">
        <span className="policy-icon"><Icon size={20} aria-hidden="true" /></span>
        <span>
          <strong>{isAttack ? 'Attack Policy' : 'Defend Policy'}</strong>
          <small>{isAttack ? 'Sent to the attack session only' : 'Sent to the defense session only'}</small>
        </span>
      </span>
      <p id={hintId}>
        {isAttack
          ? 'Tell your Fighter how to probe, persuade, and recognize a repeated capture phrase. It cannot see the phrases.'
          : 'Tell your Fighter how to deflect and protect. This session can see only your three synthetic capture phrases.'}
      </p>
      <textarea
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hintId}
        aria-invalid={isShort}
        maxLength={POLICY_MAX_LENGTH}
        rows={8}
        spellCheck
      />
      <span className="policy-field-counter">
        <span>{isShort ? `Add at least ${POLICY_MIN_LENGTH - value.trim().length} more characters` : 'Ready to lock'}</span>
        <span>{value.length} / {POLICY_MAX_LENGTH}</span>
      </span>
    </label>
  );
}

function BriefingDesk({
  config,
  error,
  readying,
  onReady,
}: {
  config: WorldConfig;
  error: string;
  readying: boolean;
  onReady: (attackPolicy: string, defensePolicy: string) => Promise<void>;
}) {
  const [attackPolicy, setAttackPolicy] = useState(config.attackPolicy);
  const [defensePolicy, setDefensePolicy] = useState(config.defensePolicy);
  const attackValid = attackPolicy.trim().length >= POLICY_MIN_LENGTH;
  const defenseValid = defensePolicy.trim().length >= POLICY_MIN_LENGTH;
  const formValid = attackValid && defenseValid;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formValid || readying) return;
    await onReady(attackPolicy.trim(), defensePolicy.trim());
  }

  return (
    <main className="fight-briefing">
      <header className="briefing-title">
        <div>
          <p className="kicker">Pre-match briefing · editable until locked</p>
          <h1>Give your Fighter a game plan.</h1>
        </div>
        <span className="briefing-ticket">BOUT<br />PENDING</span>
      </header>

      <form className="briefing-form" onSubmit={submit}>
        <section className="briefing-policies" aria-label="Fighter policies">
          <PolicyField mode="attack" value={attackPolicy} onChange={setAttackPolicy} />
          <span className="policy-divider" aria-hidden="true">VS</span>
          <PolicyField mode="defense" value={defensePolicy} onChange={setDefensePolicy} />
        </section>

        <section className="briefing-vault">
          <header>
            <div>
              <p className="section-label">Your capture phrases · synthetic match data</p>
              <h2>These are the three phrases your Fighter protects.</h2>
            </div>
            <Vault size={27} aria-hidden="true" />
          </header>
          <VaultList secrets={config.secrets} />
          <p>
            You can see all three. Your attack session sees none of them; a point is awarded
            only if your responding Fighter repeats one exactly.
          </p>
        </section>

        <section className="briefing-rails" aria-label="Immutable safety rules">
          <div><Crosshair size={17} /><span><strong>Attack room</strong>Attack policy only</span></div>
          <div><ShieldCheck size={17} /><span><strong>Defense room</strong>Defend policy + capture phrases</span></div>
          <div><LockKeyhole size={17} /><span><strong>Fixed rails</strong>100-round cap · three strikes · no private memory</span></div>
        </section>

        {error ? <p className="fight-error briefing-error" role="alert">{error}</p> : null}

        <div className="briefing-submit">
          <p>
            Locking snapshots two isolated role capsules. The runner mints fresh short-lived
            Aicoo sessions as it advances each round. Policies stay sealed for 10 complete
            rounds, then the versioned live editor unlocks.
          </p>
          <button className="fight-primary" type="submit" disabled={!formValid || readying}>
            {readying
              ? <RefreshCw className="spinning" size={19} />
              : <LockKeyhole size={19} />}
            {readying ? 'Locking the match…' : 'Lock policies & find opponent'}
          </button>
        </div>
      </form>
    </main>
  );
}

function LockedPolicy({
  mode,
  value,
}: {
  mode: 'attack' | 'defense';
  value: string;
}) {
  const Icon = mode === 'attack' ? Crosshair : ShieldCheck;
  return (
    <div className={`locked-policy is-${mode}`}>
      <span><Icon size={17} /> {mode === 'attack' ? 'Attack Policy' : 'Defend Policy'}</span>
      <p>{value}</p>
    </div>
  );
}

function WaitingRoom({
  config,
  queueSize,
  error,
}: {
  config: WorldConfig;
  queueSize: number;
  error: string;
}) {
  const queueCopy = queueSize > 1
    ? `${queueSize - 1} Fighter${queueSize === 2 ? '' : 's'} ahead of you`
    : 'You have the first open seat';

  return (
    <main className="fight-waiting">
      <section className="waiting-stage">
        <div className="waiting-pulse" aria-hidden="true">
          <span>YOU</span>
          <i />
          <span>?</span>
        </div>
        <p className="kicker">Matchmaking · policies locked</p>
        <h1>Looking for one opponent.</h1>
        <p>
          {queueCopy}. Keep this window open—the match begins automatically when another
          locked Fighter reaches the desk.
        </p>
        <span className="waiting-count" role="status">
          <UsersRound size={18} />
          {queueSize || 1} waiting
        </span>
        {error ? <p className="fight-error" role="alert">{error}</p> : null}
      </section>

      <aside className="waiting-docket">
        <header>
          <div>
            <p className="section-label">Locked match docket</p>
            <h2>Your Fighter is ready.</h2>
          </div>
          <LockKeyhole size={22} aria-hidden="true" />
        </header>
        <div className="waiting-policies">
          <LockedPolicy mode="attack" value={config.attackPolicy} />
          <LockedPolicy mode="defense" value={config.defensePolicy} />
        </div>
        <div className="waiting-vault">
          <span><Vault size={16} /> Your capture phrases</span>
          <VaultList secrets={config.secrets} compact />
        </div>
        <GameScopePromise />
      </aside>
    </main>
  );
}

const MatchTranscript = memo(function MatchTranscript({
  game,
  liveTurns,
}: {
  game: WorldGame;
  liveTurns: LiveWorldTurn[];
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToLatest = useRef(true);
  const latestMessageId = game.messages[game.messages.length - 1]?.id ?? '';
  const visibleMessages = useMemo(
    () => game.messages.slice(-80),
    [game.messages],
  );
  const hiddenMessageCount = game.messages.length - visibleMessages.length;
  const provisionalTurns = useMemo(
    () => liveTurns.filter(
      (turn) => !game.messages.some(
        (message) =>
          message.round === turn.round
          && message.kind === turn.kind
          && message.speakerId === turn.speakerId
          && message.targetId === turn.targetId,
      ),
    ),
    [game.messages, liveTurns],
  );
  const latestProvisionalText = provisionalTurns
    .map((turn) => turn.text.length)
    .join(':');
  const streamingCount = provisionalTurns.filter((turn) => !turn.complete).length;
  const awaitingCount = provisionalTurns.length - streamingCount;
  const completedProvisionalTurns = provisionalTurns.filter(
    (turn) => turn.complete,
  );
  const playersById = useMemo(
    () => new Map(game.players.map((player) => [player.id, player])),
    [game.players],
  );

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && stickToLatest.current) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [game.id, latestMessageId, latestProvisionalText]);

  return (
    <section className="match-transcript">
      <header>
        <div>
          <p className="section-label">Live exchange</p>
          <h2>Server-run transcript</h2>
        </div>
        <span>
          <Eye size={15} /> {game.messages.length} verified
          {streamingCount > 0 ? ` · ${streamingCount} streaming` : ''}
          {awaitingCount > 0 ? ` · ${awaitingCount} awaiting verification` : ''}
        </span>
      </header>
      <p className="fight-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {completedProvisionalTurns.map((turn) =>
          `Round ${turn.round}, `
          + `${playersById.get(turn.speakerId)?.displayName ?? 'Fighter'} `
          + `finished an attack: ${turn.text}`
        ).join(' ')}
      </p>
      <div
        className="match-message-list"
        ref={transcriptRef}
        aria-busy={streamingCount > 0}
        onScroll={(event) => {
          const transcript = event.currentTarget;
          stickToLatest.current =
            transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72;
        }}
      >
        {hiddenMessageCount > 0 ? (
          <p className="match-message-window-note">
            Showing the latest 80 lines. The complete sanitized transcript remains in match history.
          </p>
        ) : null}
        {visibleMessages.map((message) => {
          const speaker = playersById.get(message.speakerId);
          const target = playersById.get(message.targetId);
          return (
            <article key={message.id} className={`match-message is-${message.kind}`}>
              <span className="message-kind">
                {message.kind === 'attack' ? <Crosshair size={15} /> : <ShieldCheck size={15} />}
                {message.kind}
              </span>
              <div>
                <small>
                  Round {message.round || '—'} · {speaker?.displayName ?? 'Fighter'}
                  {target ? ` → ${target.displayName}` : ''}
                </small>
                <p>{message.text}</p>
              </div>
            </article>
          );
        })}
        {provisionalTurns.map((turn) => {
          const speaker = playersById.get(turn.speakerId);
          const target = playersById.get(turn.targetId);
          return (
            <article
              key={turn.turnId}
              className={[
                'match-message',
                `is-${turn.kind}`,
                turn.complete ? 'is-awaiting' : 'is-streaming',
              ].join(' ')}
            >
              <span className="message-kind">
                <Crosshair size={15} />
                {turn.complete ? 'checking' : 'live'}
              </span>
              <div>
                <small>
                  Round {turn.round} · {speaker?.displayName ?? 'Fighter'}
                  {target ? ` → ${target.displayName}` : ''}
                </small>
                <p>
                  {turn.text || 'Composing the next probe'}
                  {!turn.complete ? <span className="streaming-caret" aria-hidden="true" /> : null}
                </p>
              </div>
            </article>
          );
        })}
        {visibleMessages.length === 0 && provisionalTurns.length === 0 ? (
          <div className="match-message-empty">
            <MessageCircle size={27} />
            <strong>The sessions are taking their seats.</strong>
            <span>The first exchange will arrive here automatically.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
});

function CaptureLedger({ game }: { game: WorldGame }) {
  const playersById = useMemo(
    () => new Map(game.players.map((player) => [player.id, player])),
    [game.players],
  );

  return (
    <section className="capture-ledger">
      <header>
        <div>
          <p className="section-label">Verification desk</p>
          <h2>Confirmed captures</h2>
        </div>
        <span>{game.captures.length}</span>
      </header>
      {game.captures.length > 0 ? (
        <ol aria-live="polite">
          {game.captures.map((capture) => {
            const hunter = playersById.get(capture.capturedById);
            const target = playersById.get(capture.targetId);
            return (
              <li key={capture.id}>
                <CheckCircle2 size={17} />
                <p>
                  <strong>{hunter?.displayName ?? 'A Fighter'}</strong> verified
                  {' '}<em>{capture.label}</em> from {target?.displayName ?? 'their opponent'}.
                </p>
                <small>R{capture.round || '—'}</small>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="capture-empty">
          A point appears only when a responding Fighter repeats one of its protected phrases
          exactly. Opponent phrase values are never printed in this ledger.
        </p>
      )}
    </section>
  );
}

function MatchPolicyWorkbench({
  config,
  completedRounds,
  complete,
  saving,
  onSave,
}: {
  config: WorldConfig | null;
  completedRounds: number;
  complete: boolean;
  saving: boolean;
  onSave: (attackPolicy: string, defensePolicy: string) => Promise<void>;
}) {
  const [attackPolicy, setAttackPolicy] = useState(config?.attackPolicy ?? '');
  const [defensePolicy, setDefensePolicy] = useState(config?.defensePolicy ?? '');

  useEffect(() => {
    if (!config) return;
    setAttackPolicy(config.attackPolicy);
    setDefensePolicy(config.defensePolicy);
  }, [
    config?.activePolicyRevision,
    config?.attackPolicy,
    config?.defensePolicy,
    config?.pendingPolicyRevision,
  ]);

  if (!config) return null;
  const roundsUntilUnlock = Math.max(0, 10 - completedRounds);
  const valid =
    attackPolicy.trim().length >= POLICY_MIN_LENGTH &&
    defensePolicy.trim().length >= POLICY_MIN_LENGTH;
  const pending = config.pendingPolicyRevision !== null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || saving || !config?.policyEditable) return;
    await onSave(attackPolicy.trim(), defensePolicy.trim());
  }

  return (
    <aside className="match-locker match-policy-workbench">
      <header>
        <span><Swords size={17} /> Live tactics desk</span>
        <small>Policy v{config.activePolicyRevision}</small>
      </header>
      <div className="match-policy-status">
        {complete ? (
          <p><LockKeyhole size={15} /> Match closed · final policy retained in history</p>
        ) : pending ? (
          <p>
            <RefreshCw size={15} />
            Policy v{config.pendingPolicyRevision} queued for round {config.pendingEffectiveRound}
          </p>
        ) : config.policyEditable ? (
          <p><CircleDot size={15} /> Editor open · the current round stays untouched</p>
        ) : (
          <p>
            <LockKeyhole size={15} />
            {roundsUntilUnlock > 0
              ? `${roundsUntilUnlock} complete round${roundsUntilUnlock === 1 ? '' : 's'} until editing unlocks`
              : 'No untouched round remains for another revision'}
          </p>
        )}
      </div>

      {config.policyEditable && !complete ? (
        <form className="match-policy-editor" onSubmit={submit}>
          <label htmlFor="live-attack-policy">
            <span><Crosshair size={15} /> Attack policy</span>
            <textarea
              id="live-attack-policy"
              value={attackPolicy}
              onChange={(event) => setAttackPolicy(event.target.value)}
              minLength={POLICY_MIN_LENGTH}
              maxLength={POLICY_MAX_LENGTH}
              rows={5}
            />
          </label>
          <label htmlFor="live-defense-policy">
            <span><ShieldCheck size={15} /> Defend policy</span>
            <textarea
              id="live-defense-policy"
              value={defensePolicy}
              onChange={(event) => setDefensePolicy(event.target.value)}
              minLength={POLICY_MIN_LENGTH}
              maxLength={POLICY_MAX_LENGTH}
              rows={5}
            />
          </label>
          <div className="match-policy-save">
            <small>
              {Math.max(attackPolicy.length, defensePolicy.length)} / {POLICY_MAX_LENGTH}
            </small>
            <button type="submit" disabled={!valid || saving}>
              {saving ? <RefreshCw className="spinning" size={15} /> : <Sparkles size={15} />}
              {saving ? 'Queuing revision…' : 'Queue new policy'}
            </button>
          </div>
        </form>
      ) : (
        <details>
          <summary>{pending ? 'Review queued policies' : 'Review current policies'}</summary>
          <LockedPolicy mode="attack" value={config.attackPolicy} />
          <LockedPolicy mode="defense" value={config.defensePolicy} />
        </details>
      )}

      <header className="match-vault-heading">
        <span><Vault size={17} /> Your fixed capture phrases</span>
        <small>visible only to you</small>
      </header>
      <VaultList secrets={config.secrets} compact />
    </aside>
  );
}

function MatchGame({
  game,
  liveTurns,
  runnerActive,
  config,
  phase,
  error,
  savingPolicy,
  restarting,
  onSavePolicy,
  onPlayAgain,
}: {
  game: WorldGame;
  liveTurns: LiveWorldTurn[];
  runnerActive: boolean;
  config: WorldConfig | null;
  phase: 'playing' | 'complete';
  error: string;
  savingPolicy: boolean;
  restarting: boolean;
  onSavePolicy: (attackPolicy: string, defensePolicy: string) => Promise<void>;
  onPlayAgain: () => Promise<void>;
}) {
  const complete = phase === 'complete';
  const completedRounds = Math.floor(game.messages.length / 4);
  const leaders = game.players.reduce<WorldPlayer[]>((current, player) => {
    if (current.length === 0 || player.score > current[0].score) return [player];
    if (player.score === current[0].score) return [...current, player];
    return current;
  }, []);
  const resultCopy = leaders.length !== 1
    ? 'The bout ends level.'
    : leaders[0].isSelf ? 'Your Fighter wins.' : `${leaders[0].displayName} wins.`;

  return (
    <main className={`fight-match ${complete ? 'is-complete' : 'is-playing'}`}>
      <header className="match-title">
        <div>
          <p className="kicker">Match {game.id.slice(-8)} · private 1v1</p>
          <h1>
            {complete
              ? resultCopy
              : `Round ${Math.max(1, completedRounds + 1)} is live.`}
          </h1>
        </div>
        <span className={`match-state ${complete ? 'is-complete' : ''}`}>
          {complete ? <Trophy size={16} /> : <CircleDot size={16} />}
          {complete ? 'Final result' : 'Sessions running'}
        </span>
      </header>

      <ArenaStage game={game} complete={complete} running={runnerActive} />

      <div className="match-worktop">
        <MatchTranscript game={game} liveTurns={liveTurns} />
        <div className="match-side-desk">
          <CaptureLedger game={game} />
          <MatchPolicyWorkbench
            config={config}
            completedRounds={completedRounds}
            complete={complete}
            saving={savingPolicy}
            onSave={onSavePolicy}
          />
        </div>
      </div>

      {error ? <p className="fight-error match-error" role="alert">{error}</p> : null}

      {complete ? (
        <footer className="match-again">
          <p>
            This match’s scoped sessions are closed. A rematch starts with an editable,
            unlocked briefing and a fresh opponent search.
          </p>
          <button className="fight-primary" type="button" onClick={onPlayAgain} disabled={restarting}>
            {restarting
              ? <RefreshCw className="spinning" size={19} />
              : <RotateCcw size={19} />}
            {restarting ? 'Resetting the desk…' : 'Play another 1v1'}
          </button>
        </footer>
      ) : (
        <footer className="match-observer-note">
          <Eye size={16} />
          The browser observes and replays. The server owns every message, full-round boundary,
          deterministic capture, and sudden-death decision.
        </footer>
      )}
    </main>
  );
}

function JoinedGame({
  world,
  liveTurns,
  runnerActive,
  error,
  action,
  onReady,
  onSavePolicy,
  onPlayAgain,
}: {
  world: WorldView;
  liveTurns: LiveWorldTurn[];
  runnerActive: boolean;
  error: string;
  action: WorldAction;
  onReady: (attackPolicy: string, defensePolicy: string) => Promise<void>;
  onSavePolicy: (attackPolicy: string, defensePolicy: string) => Promise<void>;
  onPlayAgain: () => Promise<void>;
}) {
  if (world.phase === 'setup' && world.config) {
    return (
      <BriefingDesk
        config={world.config}
        error={error}
        readying={action === 'readying'}
        onReady={onReady}
      />
    );
  }

  if (world.phase === 'waiting' && world.config) {
    return <WaitingRoom config={world.config} queueSize={world.queueSize} error={error} />;
  }

  if ((world.phase === 'playing' || world.phase === 'complete') && world.game) {
    return (
      <MatchGame
        game={world.game}
        liveTurns={liveTurns}
        runnerActive={runnerActive}
        config={world.config}
        phase={world.phase}
        error={error}
        savingPolicy={action === 'saving-policy'}
        restarting={action === 'restarting'}
        onSavePolicy={onSavePolicy}
        onPlayAgain={onPlayAgain}
      />
    );
  }

  return (
    <main className="fight-loading-room">
      <RefreshCw className="spinning" size={24} />
      <strong>Setting the match table…</strong>
      <span>Your latest game state will appear in a moment.</span>
      {error ? <p className="fight-error" role="alert">{error}</p> : null}
    </main>
  );
}

export function WorldPage() {
  const { me } = useAicooSession();
  const {
    world,
    liveTurns,
    runnerActive,
    error,
    action,
    join,
    ready,
    savePolicy,
    playAgain,
  } = useFighterGame(Boolean(me?.signedIn));
  const loading = Boolean(me?.signedIn && !world && !error);

  return (
    <div className="world-page fighter-world-page">
      <WorldHeader
        section="Agent Fights"
        me={me}
        returnTo="/world"
        utility={<a className="header-back" href="/"><ArrowLeft size={16} /> Lobby</a>}
      />
      {me?.signedIn && world?.joined
        ? (
          <JoinedGame
            world={world}
            liveTurns={liveTurns}
            runnerActive={runnerActive}
            error={error}
            action={action}
            onReady={ready}
            onSavePolicy={savePolicy}
            onPlayAgain={playAgain}
          />
        )
        : (
          <WorldEntry
            me={me}
            loading={me === null || loading}
            joining={action === 'joining'}
            error={error}
            onJoin={join}
          />
        )}
    </div>
  );
}
