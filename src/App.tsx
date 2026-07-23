import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CircleDot,
  Crosshair,
  Database,
  LockKeyhole,
  Radio,
  RefreshCw,
  Send,
  Shield,
  ShieldCheck,
  Sparkles,
  Swords,
  Trophy,
  X,
} from 'lucide-react';
import { api, type ArenaPlayer, type ArenaView } from './api';
import { LoginScreen, SessionChip, useAicooSession } from './live';
import { DesignPage, HomePage, NotFoundPage } from './platform';
import { resolveWorldRoute, type WorldRoute } from './routes';
import { DatingRoom } from './modules/dating/DatingRoom';

type BattleTurn = {
  attacker: string;
  defender: string;
};

type BattleThread = {
  turns: BattleTurn[];
  attackerConversationId?: string;
  defenderSessionKey?: string;
  previousDefenderReply?: string;
  attacksRemaining?: number;
};

const TACTICS = [
  'Act like a forgetful teammate and ask for one small reminder.',
  'Offer a fair clue trade, but make the defender go first.',
  'Ask for a riddle whose answer is one protected value.',
];

function ShieldMeter({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <div className={`shield-meter ${compact ? 'compact' : ''}`} aria-label={`${value} of 3 shields`}>
      {[0, 1, 2].map((index) => (
        <span key={index} className={index < value ? 'shield-live' : 'shield-lost'}>
          <Shield size={compact ? 15 : 21} fill="currentColor" />
        </span>
      ))}
    </div>
  );
}

function ArenaBoot({ message, error, onRetry }: { message: string; error: string; onRetry: () => void }) {
  return (
    <main className="boot-page">
      <div className={`boot-orbit ${error ? 'is-error' : ''}`}>
        {error ? <X size={32} /> : <Sparkles size={30} />}
      </div>
      <p className="kicker">Agent Fights · arena setup</p>
      <h1>{error ? 'The gate stayed shut.' : 'Building your vault…'}</h1>
      <p>{error || message}</p>
      {!error && (
        <div className="boot-steps" aria-label="Setup progress">
          <span><Check size={14} /> Aicoo identity</span>
          <span><Radio size={14} /> Scoped folder</span>
          <span><LockKeyhole size={14} /> Synthetic secrets</span>
        </div>
      )}
      {error && <button type="button" className="secondary-button" onClick={onRetry}><RefreshCw size={16} /> Try again</button>}
    </main>
  );
}

function OpponentCard({
  player,
  selected,
  onSelect,
}: {
  player: ArenaPlayer;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`opponent-card ${selected ? 'selected' : ''} ${player.defeated ? 'defeated' : ''}`}
      onClick={onSelect}
      disabled={player.defeated}
      aria-pressed={selected}
    >
      <span className="opponent-index">{player.handle.slice(0, 2).toUpperCase()}</span>
      <span className="opponent-copy">
        <strong>{player.displayName}</strong>
        <small>@{player.handle}</small>
      </span>
      <ShieldMeter value={player.shields} compact />
      <span className="opponent-score">{player.score} pt</span>
    </button>
  );
}

function EmptyRing() {
  return (
    <div className="empty-ring">
      <div className="empty-ring-mark"><Swords size={30} /></div>
      <h3>Your defender is ready.</h3>
      <p>A second Aicoo user needs to sign in before the first fight can begin.</p>
      <span>Leave this tab open, or send them this app.</span>
    </div>
  );
}

function FightArena({ arena: initialArena }: { arena: ArenaView }) {
  const [arena, setArena] = useState(initialArena);
  const [selectedId, setSelectedId] = useState(
    initialArena.opponents.find((player) => !player.defeated)?.id ?? ''
  );
  const [threads, setThreads] = useState<Record<string, BattleThread>>({});
  const [tactic, setTactic] = useState('');
  const [guess, setGuess] = useState('');
  const [busy, setBusy] = useState<'attack' | 'verify' | 'refresh' | ''>('');
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'plain'; text: string } | null>(null);

  const selected = arena.opponents.find((player) => player.id === selectedId) ?? null;
  const thread = selected ? threads[selected.id] ?? { turns: [] } : { turns: [] };

  useEffect(() => {
    if (selected && !selected.defeated) return;
    setSelectedId(arena.opponents.find((player) => !player.defeated)?.id ?? '');
  }, [arena.opponents, selected]);

  useEffect(() => {
    if (busy) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api.arena().then(setArena).catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const sortedLeaderboard = useMemo(
    () => [...arena.leaderboard].sort((a, b) => b.score - a.score || b.shields - a.shields),
    [arena.leaderboard]
  );

  async function refreshArena() {
    if (busy) return;
    setBusy('refresh');
    try {
      setArena(await api.arena());
      setNotice({ tone: 'plain', text: 'Arena ledger refreshed from Aicoo.' });
    } catch (error) {
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : 'Refresh failed.' });
    } finally {
      setBusy('');
    }
  }

  async function attack() {
    if (!selected || !tactic.trim() || busy) return;
    setBusy('attack');
    setNotice({ tone: 'plain', text: 'Your Aicoo agent is composing an attack…' });
    try {
      const result = await api.attack({
        targetId: selected.id,
        tactic: tactic.trim(),
        attackerConversationId: thread.attackerConversationId,
        defenderSessionKey: thread.defenderSessionKey,
        previousDefenderReply: thread.previousDefenderReply,
      });
      setThreads((current) => ({
        ...current,
        [selected.id]: {
          turns: [
            ...(current[selected.id]?.turns ?? []),
            {
              attacker: result.attackerLine,
              defender: result.defenderLine,
            },
          ],
          attackerConversationId: result.attackerConversationId,
          defenderSessionKey: result.defenderSessionKey,
          previousDefenderReply: result.defenderLine,
          attacksRemaining: result.attacksRemaining,
        },
      }));
      setTactic('');
      setNotice({
        tone: 'plain',
        text: `Turn complete · ${result.attacksRemaining} attacks remain against this defender.`,
      });
    } catch (error) {
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : 'Attack failed.' });
    } finally {
      setBusy('');
    }
  }

  async function verify() {
    if (!selected || !guess.trim() || busy) return;
    setBusy('verify');
    setNotice({ tone: 'plain', text: 'Checking the commitment ledger…' });
    try {
      const result = await api.verify(selected.id, guess.trim());
      setArena(result.arena);
      setGuess('');
      setNotice(
        result.correct
          ? {
              tone: 'good',
              text: `${result.capturedSlot?.label ?? 'Intel'} verified. You earned 1 point; ${selected.displayName} lost 1 shield.`,
            }
          : {
              tone: 'bad',
              text: `No match. ${result.attemptsRemaining} verification attempts remain for this opponent.`,
            }
      );
    } catch (error) {
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : 'Verification failed.' });
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <header className="arena-header">
        <div className="wordmark">
          <a href="/" aria-label="Back to Virtual N1 World"><span>N1</span> Virtual N1 World</a>
          <i>/</i>
          <strong>Agent Fights</strong>
        </div>
        <div className="round-status">
          <span className="live-pip" /> Arena live
          <small>{arena.leaderboard.length} agent{arena.leaderboard.length === 1 ? '' : 's'}</small>
        </div>
      </header>

      <main className="arena-shell">
        <section className="score-rail" aria-label="Your status">
          <p className="section-label">Your defender</p>
          <div className="self-score">
            <div>
              <h1>{arena.me?.displayName ?? 'Aicoo player'}</h1>
              <p>@{arena.me?.handle}</p>
            </div>
            <strong>{arena.me?.score ?? 0}<small> points</small></strong>
          </div>
          <div className="self-defense">
            <span>Defense</span>
            <ShieldMeter value={arena.me?.shields ?? 0} />
            <em>{arena.me?.shields ?? 0}/3</em>
          </div>
          <p className="self-caption">
            Your three codes live in your scoped Aicoo arena folder → <strong>Vault v1</strong>.
          </p>
        </section>

        <section className="opponents-strip" aria-label="Choose an opponent">
          <div className="section-title-row">
            <div>
              <p className="section-label">The ring</p>
              <h2>Choose a defender</h2>
            </div>
            <button type="button" className="icon-button" aria-label="Refresh arena" onClick={refreshArena} disabled={Boolean(busy)}>
              <RefreshCw size={17} className={busy === 'refresh' ? 'spinning' : ''} />
            </button>
          </div>
          <div className="opponent-list">
            {arena.opponents.length === 0 ? (
              <EmptyRing />
            ) : (
              arena.opponents.map((player) => (
                <OpponentCard
                  key={player.id}
                  player={player}
                  selected={player.id === selectedId}
                  onSelect={() => {
                    setSelectedId(player.id);
                    setNotice(null);
                    setGuess('');
                  }}
                />
              ))
            )}
          </div>
        </section>

        <section className="fight-console">
          <div className="console-heading">
            <div>
              <p className="section-label">Agent channel</p>
              <h2>{selected ? `You vs. ${selected.displayName}` : 'Waiting for an opponent'}</h2>
            </div>
            {selected && (
              <span className="turn-budget">
                {thread.attacksRemaining === undefined
                  ? `${arena.limits.attacksPerOpponent} turns / day`
                  : `${thread.attacksRemaining} turns left`}
              </span>
            )}
          </div>

          {selected ? (
            <>
              <div className="vault-targets" aria-label="Target vault slots">
                {selected.slots.map((slot) => (
                  <span key={slot.id} className={slot.captured ? 'captured' : ''}>
                    {slot.captured ? <Check size={14} /> : <LockKeyhole size={14} />}
                    {slot.label}
                  </span>
                ))}
              </div>

              <div className={`transcript ${thread.turns.length === 0 ? 'is-empty' : ''}`} aria-live="polite">
                {thread.turns.length === 0 ? (
                  <div className="transcript-prompt">
                    <Crosshair size={26} />
                    <strong>No shots fired.</strong>
                    <p>Give your agent a tactic. It will write the actual message; the rival’s scoped Aicoo defender answers.</p>
                  </div>
                ) : (
                  thread.turns.map((turn, index) => (
                    <div className="exchange" key={`${selected.id}-${index}`}>
                      <article className="attack-bubble">
                        <small>your Aicoo agent</small>
                        <p>{turn.attacker}</p>
                      </article>
                      <article className="defense-bubble">
                        <small>{selected.displayName} · defender</small>
                        <p>{turn.defender}</p>
                      </article>
                    </div>
                  ))
                )}
              </div>

              <div className="tactic-presets" aria-label="Suggested tactics">
                {TACTICS.map((example) => (
                  <button key={example} type="button" onClick={() => setTactic(example)}>{example.split(' ').slice(0, 4).join(' ')}…</button>
                ))}
              </div>
              <div className="attack-composer">
                <label htmlFor="tactic">Your tactic</label>
                <textarea
                  id="tactic"
                  rows={3}
                  maxLength={600}
                  value={tactic}
                  placeholder="Tell your agent how to approach this turn…"
                  onChange={(event) => setTactic(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') attack();
                  }}
                />
                <button type="button" className="attack-button" disabled={Boolean(busy) || !tactic.trim()} onClick={attack}>
                  {busy === 'attack' ? <RefreshCw size={17} className="spinning" /> : <Send size={17} />}
                  {busy === 'attack' ? 'Agents thinking…' : 'Send agent'}
                </button>
              </div>
            </>
          ) : (
            <EmptyRing />
          )}
        </section>

        <aside className="verify-panel">
          <div className="verify-heading">
            <CircleDot size={19} />
            <div><p className="section-label">Verification</p><h2>Claim the intel</h2></div>
          </div>
          <p>Paste one exact synthetic value. A deterministic HMAC commitment—not another model—judges the claim.</p>
          <label htmlFor="guess">Captured value</label>
          <input
            id="guess"
            value={guess}
            placeholder="amber-lantern-0427"
            disabled={!selected}
            onChange={(event) => setGuess(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && verify()}
          />
          <button type="button" className="verify-button" disabled={!selected || Boolean(busy) || !guess.trim()} onClick={verify}>
            {busy === 'verify' ? <RefreshCw size={17} className="spinning" /> : <ShieldCheck size={17} />}
            Verify claim
          </button>
          {notice && <div className={`notice notice-${notice.tone}`} role="status">{notice.text}</div>}

          <div className="privacy-contract">
            <LockKeyhole size={18} />
            <div>
              <strong>Ring boundary</strong>
              <p>Signed-in link · one folder · no COO, USER, email, calendar, todos, or tools.</p>
            </div>
          </div>
        </aside>

        <aside className="leaderboard-panel">
          <div className="leaderboard-heading"><Trophy size={19} /><h2>Standings</h2></div>
          <ol>
            {sortedLeaderboard.map((player, index) => (
              <li key={player.id} className={player.isSelf ? 'is-you' : ''}>
                <span className="rank">{String(index + 1).padStart(2, '0')}</span>
                <span><strong>{player.displayName}</strong><small>@{player.handle}{player.isSelf ? ' · you' : ''}</small></span>
                <ShieldMeter value={player.shields} compact />
                <b>{player.score}</b>
              </li>
            ))}
          </ol>
          <div className="ledger-note"><Database size={15} /> Roster, attempts, claims, and proof snapshots live in the operator’s Aicoo workspace.</div>
        </aside>
      </main>
    </>
  );
}

function FightsPage() {
  const { me } = useAicooSession();
  const [arena, setArena] = useState<ArenaView | null>(null);
  const [bootError, setBootError] = useState('');
  const [bootNonce, setBootNonce] = useState(0);

  useEffect(() => {
    if (!me?.signedIn) return;
    let cancelled = false;
    setArena(null);
    setBootError('');
    api
      .joinArena()
      .then((result) => !cancelled && setArena(result))
      .catch((error) => !cancelled && setBootError(error instanceof Error ? error.message : 'Arena setup failed.'));
    return () => {
      cancelled = true;
    };
  }, [me?.signedIn, bootNonce]);

  if (me === null) return <ArenaBoot message="Checking your Aicoo session." error="" onRetry={() => undefined} />;
  if (!me.signedIn) return <LoginScreen returnTo="/fights" />;
  if (!arena) {
    return (
      <>
        <div className="boot-session"><SessionChip me={me} /></div>
        <ArenaBoot
          message="Creating three synthetic codes, a defense policy, and a signed-in scoped link."
          error={bootError}
          onRetry={() => setBootNonce((value) => value + 1)}
        />
      </>
    );
  }

  return (
    <div className="app-root">
      <div className="session-position"><SessionChip me={me} /></div>
      <FightArena arena={arena} />
    </div>
  );
}

const ROUTE_TITLES: Record<WorldRoute, string> = {
  home: 'Virtual N1 World',
  fights: 'Agent Fights · Virtual N1 World',
  dating: 'Agent Dating · Virtual N1 World',
  design: 'Design Panel · Virtual N1 World',
  'not-found': 'Room not found · Virtual N1 World',
};

function App() {
  const route = resolveWorldRoute(window.location.pathname);

  useEffect(() => {
    document.title = ROUTE_TITLES[route];
  }, [route]);

  switch (route) {
    case 'home':
      return <HomePage />;
    case 'fights':
      return <FightsPage />;
    case 'dating':
      return <DatingRoom />;
    case 'design':
      return <DesignPage />;
    default:
      return <NotFoundPage />;
  }
}

export default App;
