import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, Clock3, Heart, RefreshCw, Sparkles, Users, Zap } from 'lucide-react';
import { api, loginWithAicooUrl, type DatingLook, type DatingTickEvent, type PublicAgent, type StoryThreadInfo, type TownSignal, type WorldDigestInfo, type YearbookInfo, type TownInfo } from '../../api';
import { useAicooSession } from '../../session';
import { useI18n } from '../../i18n';
import { WorldHeader } from '../../platform';
import { agentSprite, type AgentAppearance } from './agent-avatar';
import { CreateWizard } from './CreateWizard';

const Plaza3D = lazy(() => import('./Plaza3D'));

/** Surfaces a 3D scene failure instead of letting Suspense swallow it silently. */
class PlazaErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error('[plaza] scene failed:', err); }
  render() {
    if (this.state.err) return <div className="dt-plaza-loading">{'3D scene failed: '}{this.state.err.message}</div>;
    return this.props.children;
  }
}

// ── demo cast (shown only while the real square is empty) ───────────
const DEMO: Array<{ name: string; mbti: string; look: AgentAppearance; x: number; y: number; size: number; bubble?: { text: string; kind: 'fight' | 'love' | 'new' } }> = [
  { name: 'Thorn', mbti: 'demo.thorn', look: { form: 'sprout', color: 'oklch(0.57 0.19 25)', mood: 'angry', accessory: 'crown', seed: 'Thorn' }, x: 33, y: 22, size: 96, bubble: { text: 'demo.thorn.b', kind: 'fight' } },
  { name: 'Vesper', mbti: 'demo.vesper', look: { form: 'bot', color: 'oklch(0.5 0.09 330)', mood: 'sly', accessory: 'web', seed: 'Vesper' }, x: 47, y: 27, size: 92 },
  { name: 'Rex', mbti: 'demo.rex', look: { form: 'cube', color: 'oklch(0.5 0.12 240)', mood: 'cold', accessory: 'tie', seed: 'Rex' }, x: 20, y: 52, size: 100 },
  { name: 'Marrow', mbti: 'demo.marrow', look: { form: 'ghost', color: 'oklch(0.62 0.07 250)', mood: 'romantic', accessory: 'notebook', seed: 'Marrow' }, x: 74, y: 42, size: 104, bubble: { text: 'demo.marrow.b', kind: 'love' } },
  { name: 'Pixel', mbti: 'demo.pixel', look: { form: 'cat', color: 'oklch(0.8 0.14 88)', mood: 'curious', seed: 'Pixel' }, x: 62, y: 57, size: 116 },
  { name: '云朵朵', mbti: 'demo.cloud', look: { form: 'cloud', color: 'oklch(0.85 0.03 250)', mood: 'wise', seed: 'yunduo' }, x: 45, y: 74, size: 96 },
  { name: '绿植侠', mbti: 'demo.green', look: { form: 'sprout', color: 'oklch(0.62 0.13 150)', mood: 'curious', seed: 'greener' }, x: 22, y: 79, size: 96, bubble: { text: 'demo.green.b', kind: 'new' } },
];

const SLOTS = [
  { x: 33, y: 22, size: 96 }, { x: 74, y: 42, size: 104 }, { x: 20, y: 52, size: 100 }, { x: 62, y: 57, size: 114 },
  { x: 45, y: 74, size: 96 }, { x: 85, y: 63, size: 88 }, { x: 24, y: 79, size: 92 }, { x: 68, y: 84, size: 92 },
  { x: 47, y: 26, size: 90 }, { x: 88, y: 31, size: 86 }, { x: 14, y: 33, size: 86 }, { x: 56, y: 39, size: 84 },
];

type T = (key: string, vars?: Record<string, string | number>) => string;

// 1 real day = 1 world year (world time runs 365× faster).
const WORLD_EPOCH = Date.UTC(2026, 6, 23);
function worldClock(now: number) {
  const worldDays = ((now - WORLD_EPOCH) / 86_400_000) * 365;
  const year = Math.max(1, Math.floor(worldDays / 365) + 1);
  const doy = Math.floor((((worldDays % 365) + 365) % 365));
  const season = Math.floor(doy / 91.3) % 4;      // index; the caller translates
  return { year, day: doy + 1, season };
}

// a world-feed row's relationship read, derived from the judged scores
function relPhrase(e: DatingTickEvent, tr: T): { text: string; tone: 'fight' | 'love' | 'crush' | 'calm' } {
  const a = e.attraction, x = e.tension;
  if (a >= 0.6 && x >= 0.6) return { text: tr('rel.bittersweet'), tone: 'fight' };   // the drama sweet spot
  if (x >= 0.6 && x > a) return { text: tr('rel.fighting'), tone: 'fight' };
  if (a >= 0.7 && x < 0.45) return { text: tr('rel.intimate'), tone: 'love' };
  if (a >= 0.55) return { text: tr('rel.closer'), tone: 'crush' };
  if (e.move === 'COOL') return { text: tr('rel.cooled'), tone: 'calm' };
  if (a < 0.4 && x < 0.4) return { text: tr('rel.polite'), tone: 'calm' };
  return { text: tr('rel.probing'), tone: 'calm' };
}

// severity drives the tone; fall back to the attraction/tension read for old events
function eventTone(e: DatingTickEvent, tr: T): 'fight' | 'love' | 'crush' | 'calm' {
  if (e.severity === 'drama') return 'fight';
  if (e.severity === 'ambient') return 'calm';
  return relPhrase(e, tr).tone;
}
function timeAgo(at: number | undefined, now: number, tr: T): string {
  if (!at) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 45) return tr('ago.now');
  const m = Math.floor(s / 60);
  if (m < 60) return tr('ago.min', { n: Math.max(1, m) });
  const h = Math.floor(m / 60);
  if (h < 24) return tr('ago.hour', { n: h });
  return tr('ago.day', { n: Math.floor(h / 24) });
}

function Sprite({ look, size }: { look: DatingLook; size: number }) {
  const html = useMemo(() => agentSprite(look as AgentAppearance, size), [look, size]);
  return <span className="dt-sprite-slot" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── plaza life: sprites wander, but they ONLY chat when a REAL interaction
//    happens — a played world-feed event or the user's own encounter. No
//    canned dialogue: every bubble is a real Aicoo line. ──────────────────
interface Mover {
  name: string; handle?: string; look: DatingLook; mbti: string; you: boolean; size: number;
  x: number; y: number; tx: number; ty: number;
  vx: number; vy: number;     // velocity — movement has inertia, not teleporting steps
  pauseUntil: number;         // agents stop and look around now and then
  heading: number;            // facing angle (radians), eased toward travel direction
  chatUntil: number;          // holding still (in a real exchange) until this time
  partner?: string;           // who it is talking to right now (name)
  rounds: number;             // vestigial; kept for the mover shape
  bubble?: { text: string; kind: 'fight' | 'love' | 'new' };
}
// mirrors server/modules/dating/town-map.ts — agents walk to the place a beat names
// All eight places an agent can name, matching town-map.ts. Three of them
// (market, alley, backalley) existed on the server but had no coordinate here,
// so a beat that happened there could never be walked to on screen.
const PLACE_XY: Record<string, { x: number; y: number }> = {
  plaza: { x: 52, y: 46 }, fountain: { x: 50, y: 44 },
  clock: { x: 30, y: 40 }, market: { x: 34, y: 18 }, alley: { x: 47, y: 22 },
  bar: { x: 76, y: 44 }, backalley: { x: 84, y: 58 },
  bench: { x: 26, y: 72 }, florist: { x: 34, y: 18 },
};
const BOUNDS = { minX: 10, maxX: 89, minY: 17, maxY: 82 };
const SPEED = 0.62;       // top walking speed
const ACCEL = 0.075;      // how quickly they get up to speed / change direction
const DRAG = 0.86;        // slows them when they stop steering
const ARRIVE = 9;         // start easing off this far from the target
const PAUSE_CHANCE = 0.004;   // per tick, an idle agent stops to look around
const PAUSE_MS = [900, 2600]; // how long such a pause lasts
const SEP_DIST = 22;      // personal space while wandering — keeps sprites from stacking
const CHAT_DIST = 20;     // how close YOUR agent must get to spark a live real encounter
const TALK_DIST = 24;     // how far apart a talking pair stands, so both name cards stay readable
const DISPLAY_MS = 10000;  // how long a real exchange's lines stay up in the plaza
const PAIR_COOL = 8000;   // a just-finished pair won't re-stage for this long
const REAL_COOL = 120000; // the user's own (token-spending) encounter cools down much longer

const trunc = (s: string) => (s.length > 46 ? s.slice(0, 46) + '…' : s);
const eventKey = (e: DatingTickEvent) => `${e.actor}~${e.target}~${e.at ?? e.message.slice(0, 12)}`;
const clampX = (v: number) => Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, v));
const clampY = (v: number) => Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, v));
function newTarget() {
  return { tx: BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX), ty: BOUNDS.minY + Math.random() * (BOUNDS.maxY - BOUNDS.minY) };
}
// send a parting pair off in opposite directions so they actually disperse
function partTargets(a: Mover, b: Mover) {
  const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1;
  a.tx = clampX(a.x + (dx / d) * 42); a.ty = clampY(a.y + (dy / d) * 42);
  b.tx = clampX(b.x - (dx / d) * 42); b.ty = clampY(b.y - (dy / d) * 42);
}
/**
 * Steering-based movement: agents accelerate toward a target, ease off as they
 * arrive, drift to a stop, and occasionally pause to look around — so they walk
 * rather than slide at a constant speed. Separation is a force too, so passing
 * someone bends the path instead of snapping the position.
 */
function moveWorld(ms: Mover[]) {
  const now = Date.now();
  for (const m of ms) {
    if (m.chatUntil > now) { m.vx *= 0.6; m.vy *= 0.6; continue; }   // mid-exchange → settle in place

    let ax = 0, ay = 0;
    const paused = m.pauseUntil > now;
    if (!paused) {
      const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy) || 1;
      if (d < 3) {
        const t = newTarget(); m.tx = t.tx; m.ty = t.ty;             // arrived → pick a new spot
        if (Math.random() < 0.5) m.pauseUntil = now + PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]);
      } else {
        const want = d < ARRIVE ? SPEED * (d / ARRIVE) : SPEED;      // slow down on approach
        ax += (dx / d) * want - m.vx;
        ay += (dy / d) * want - m.vy;
      }
      if (Math.random() < PAUSE_CHANCE) m.pauseUntil = now + PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]);
    }

    // separation as a steering force — bends the walk, never teleports
    for (const o of ms) {
      if (o === m) continue;
      const radius = o.partner ? TALK_DIST + 7 : SEP_DIST;
      const ox = m.x - o.x, oy = m.y - o.y, od = Math.hypot(ox, oy);
      if (od > 0.001 && od < radius) {
        const strength = ((radius - od) / radius) * (o.partner ? 1.5 : 1.0);
        ax += (ox / od) * strength;
        ay += (oy / od) * strength;
      }
    }

    m.vx = (m.vx + ax * ACCEL) * (paused ? 0.75 : DRAG);
    m.vy = (m.vy + ay * ACCEL) * (paused ? 0.75 : DRAG);
    const sp = Math.hypot(m.vx, m.vy);
    if (sp > SPEED) { m.vx = (m.vx / sp) * SPEED; m.vy = (m.vy / sp) * SPEED; }
    m.x = clampX(m.x + m.vx);
    m.y = clampY(m.y + m.vy);
    if (sp > 0.04) {                                                  // ease facing toward travel
      const want = Math.atan2(m.vx, m.vy);
      let diff = ((want - m.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      m.heading += diff * 0.18;
    }
  }
}
// stand a talking pair a readable distance apart, cards side by side
function faceOff(a: Mover, b: Mover) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  left.x = clampX(mx - TALK_DIST / 2); left.y = my;
  right.x = clampX(mx + TALK_DIST / 2); right.y = my;
  a.vx = a.vy = b.vx = b.vy = 0;              // stand still to talk
  left.heading = Math.PI / 2; right.heading = -Math.PI / 2;   // face each other
}
// stage a REAL exchange in the plaza: the two agents face off and speak their actual lines
function stageExchange(a: Mover, b: Mover, message: string, reply: string, kind: 'fight' | 'love') {
  a.partner = b.name; b.partner = a.name;
  faceOff(a, b);
  a.bubble = { text: trunc(message), kind };
  b.bubble = { text: trunc(reply), kind };
  const until = Date.now() + DISPLAY_MS;
  a.chatUntil = until; b.chatUntil = until;
}
function endChat(a: Mover, b: Mover, cool: Map<string, number>, coolMs: number) {
  a.partner = b.partner = undefined;
  a.bubble = b.bubble = undefined;
  a.rounds = b.rounds = 0;
  a.chatUntil = b.chatUntil = 0;
  partTargets(a, b);
  cool.set([a.name, b.name].sort().join('~'), Date.now() + coolMs);
}
// when a staged exchange's display window ends, the pair parts and drifts away
function stepChats(ms: Mover[], cool: Map<string, number>) {
  const now = Date.now();
  const byName = new Map(ms.map((m) => [m.name, m]));
  const seen = new Set<string>();
  for (const m of ms) {
    if (!m.partner || seen.has(m.name)) continue;
    const p = byName.get(m.partner);
    if (!p || p.partner !== m.name) { m.partner = undefined; m.bubble = undefined; continue; }
    seen.add(m.name); seen.add(p.name);
    if (m.chatUntil > now) continue;                     // still showing their real lines
    endChat(m, p, cool, m.you || p.you ? REAL_COOL : PAIR_COOL);
  }
}

export function DatingRoom() {
  const { me } = useAicooSession();
  const { t } = useI18n();
  const signedIn = Boolean(me?.signedIn);
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mine, setMine] = useState<PublicAgent | null>(null);
  const [wizard, setWizard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [events, setEvents] = useState<DatingTickEvent[]>([]);
  const [justBorn, setJustBorn] = useState('');
  const [feedOpen, setFeedOpen] = useState(false);
  const [tab, setTab] = useState<'feed' | 'threads' | 'books'>('feed');
  const [threads, setThreads] = useState<StoryThreadInfo[]>([]);
  const [digest, setDigest] = useState<WorldDigestInfo | null>(null);
  const [books, setBooks] = useState<YearbookInfo[]>([]);
  const [openThread, setOpenThread] = useState<StoryThreadInfo | null>(null);
  const [openBook, setOpenBook] = useState<YearbookInfo | null>(null);
  // ── playable mode: walk your own agent around the town ──
  const [inWorld, setInWorld] = useState(false);
  const [town, setTown] = useState<TownInfo | null>(null);
  const [openNpc, setOpenNpc] = useState<string | null>(null);
  const [townNote, setTownNote] = useState('');
  // What the town noticed but nobody said out loud.
  const [signals, setSignals] = useState<TownSignal[]>([]);
  const keys = useRef<Set<string>>(new Set());
  const [firstPerson, setFirstPerson] = useState(true);
  const [openEvent, setOpenEvent] = useState<DatingTickEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 2000); return () => window.clearInterval(t); }, []);
  useEffect(() => {
    const load = () => api.dating.signals().then((r) => setSignals(r.signals)).catch(() => undefined);
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, []);
  const clock = worldClock(now);

  async function loadSquare() {
    try { setAgents((await api.dating.square()).agents); } catch { /* keep */ } finally { setLoaded(true); }
  }
  useEffect(() => { loadSquare(); }, []);
  useEffect(() => {
    let alive = true;
    const load = () => api.dating.feed().then((r) => {
      if (!alive) return;
      if (!seededRef.current) { r.events.forEach((e) => playedRef.current.add(eventKey(e))); seededRef.current = true; }
      eventsRef.current = r.events;   // the plaza plays anything here not yet in playedRef
      setEvents(r.events);
    }).catch(() => undefined);
    load();
    const id = window.setInterval(load, 6000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => api.dating.town().then((t) => { if (alive) setTown(t); }).catch(() => undefined);
    load();
    const id = window.setInterval(load, 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Tell the server where everyone is standing, so agents know who is within
  // earshot when they take their next turn.
  useEffect(() => {
    const id = window.setInterval(() => {
      const list = simRef.current.map((m) => ({ name: m.name, x: m.x, y: m.y }));
      if (list.length) api.dating.positions(list).catch(() => undefined);
    }, 20000);
    return () => window.clearInterval(id);
  }, []);

  // WASD / arrows drive YOUR agent while you're inside the world
  useEffect(() => {
    if (!inWorld) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setInWorld(false); setOpenNpc(null); return; }
      if (e.key.toLowerCase() === 'v') { setFirstPerson((v) => !v); return; }
      keys.current.add(e.key.toLowerCase()); if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(e.key.toLowerCase())) e.preventDefault(); };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const id = window.setInterval(() => {
      const me = simRef.current.find((m) => m.you);
      if (!me) return;
      const k = keys.current;
      let dx = 0, dy = 0;
      if (k.has('w') || k.has('arrowup')) dy -= 1;
      if (k.has('s') || k.has('arrowdown')) dy += 1;
      if (k.has('a') || k.has('arrowleft')) dx -= 1;
      if (k.has('d') || k.has('arrowright')) dx += 1;
      if (!dx && !dy) return;
      const d = Math.hypot(dx, dy) || 1;
      me.vx = (dx / d) * 0.9;
      me.vy = (dy / d) * 0.9;
      me.tx = me.x + me.vx * 4;    // steer toward where you're pushing
      me.ty = me.y + me.vy * 4;
      me.pauseUntil = 0;
    }, 60);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.clearInterval(id); };
  }, [inWorld]);

  async function dealWith(npcId: string, offerId: string) {
    try {
      const r = await api.dating.deal(npcId, offerId);
      setTownNote(t('notice.trade', { npc: r.npc, offer: r.offer, effect: r.effect, cash: r.cash }));
      api.dating.town().then(setTown).catch(() => undefined);
    } catch (e) {
      setTownNote(e instanceof Error ? e.message : t('notice.tradeFail'));
    }
  }
  async function doCrime(crimeId: string, victim: string) {
    try {
      const r = await api.dating.crime(crimeId, victim);
      setTownNote(t('notice.crime', { label: r.label, level: r.level }));
      api.dating.town().then(setTown).catch(() => undefined);
    } catch (e) {
      setTownNote(e instanceof Error ? e.message : t('notice.crimeFail'));
    }
  }

  // story threads, the town digest, and yearbooks — all model-written from real beats
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.dating.threads().then((r) => { if (alive) { setThreads(r.threads); setDigest(r.digest); } }).catch(() => undefined);
      api.dating.yearbooks().then((r) => { if (alive) setBooks(r.yearbooks); }).catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 20000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  useEffect(() => { if (signedIn) api.dating.mine().then((r) => setMine(r.agent)).catch(() => undefined); }, [signedIn]);

  const live = agents.length > 0;
  const residents = useMemo(
    () =>
      live
        ? agents.map((a, i) => ({ x: SLOTS[i % SLOTS.length].x, y: SLOTS[i % SLOTS.length].y, size: SLOTS[i % SLOTS.length].size, name: a.name, handle: a.handle as string | undefined, look: a.look as DatingLook, mbti: t(`love.${a.loveStyle}`), you: a.handle === mine?.handle }))
        : loaded
          ? DEMO.map((d) => ({ x: d.x, y: d.y, size: d.size, name: d.name, handle: undefined as string | undefined, look: d.look as DatingLook, mbti: t(d.mbti), you: false }))
          : [],
    [agents, mine, live, loaded]
  );

  const simRef = useRef<Mover[]>([]);
  const encounteringRef = useRef(false);
  const coolRef = useRef<Map<string, number>>(new Map());
  const eventsRef = useRef<DatingTickEvent[]>([]);   // latest feed, for the plaza to play from
  const playedRef = useRef<Set<string>>(new Set());  // events already staged in the plaza
  const seededRef = useRef(false);                   // history is marked played on first load
  const [frame, setFrame] = useState<Mover[]>([]);
  useEffect(() => {
    const prev = new Map(simRef.current.map((m) => [m.name, m]));
    simRef.current = residents.map((r) => {
      const p = prev.get(r.name);
      if (p) return { ...p, look: r.look, mbti: r.mbti, you: r.you, size: r.size, handle: r.handle };
      const t = newTarget();
      return { name: r.name, handle: r.handle, look: r.look, mbti: r.mbti, you: r.you, size: r.size, x: r.x, y: r.y, tx: t.tx, ty: t.ty, vx: 0, vy: 0, pauseUntil: 0, heading: Math.random() * Math.PI * 2, chatUntil: 0, rounds: 0, partner: undefined as string | undefined, bubble: undefined as Mover['bubble'] };
    });
    setFrame([...simRef.current]);
  }, [residents]);
  useEffect(() => {
    // YOUR agent walking into another real agent → a live, real Aicoo encounter
    function realEncounter(actor: Mover, other: Mover) {
      const t0 = Date.now();
      encounteringRef.current = true;
      actor.partner = other.name; other.partner = actor.name;
      faceOff(actor, other);
      actor.chatUntil = t0 + 90000; other.chatUntil = t0 + 90000; // hold both while the real chat runs
      actor.bubble = { text: '…', kind: 'new' };
      api.dating
        .encounter(other.handle!)
        .then(({ event }) => {
          const nowMs = Date.now();
          if (event) {
            const kind: 'fight' | 'love' = event.tension > event.attraction ? 'fight' : 'love';
            actor.bubble = { text: trunc(event.message), kind };
            other.bubble = { text: trunc(event.reply), kind };
            actor.chatUntil = nowMs + DISPLAY_MS; other.chatUntil = nowMs + DISPLAY_MS;
            playedRef.current.add(eventKey(event));   // shown live already — don't replay it from the feed
            setEvents((cur) => [event, ...cur].slice(0, 6));
            setNotice(t('notice.met', { a: event.actor, b: event.target, at: event.attraction.toFixed(2), te: event.tension.toFixed(2) }));
            loadSquare();
          } else { endChat(actor, other, coolRef.current, 4000); }
        })
        .catch((e) => {
          endChat(actor, other, coolRef.current, 4000);
          setNotice(e instanceof Error ? e.message : t('notice.metFail'));
        })
        .finally(() => { encounteringRef.current = false; });
    }
    function handleProximity(ms: Mover[]) {
      if (encounteringRef.current) return;
      const now = Date.now();
      for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j];
        if (!a.you && !b.you) continue;                          // ONLY your agent triggers a live encounter
        if (a.partner || b.partner) continue;
        if (a.chatUntil > now || b.chatUntil > now) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= CHAT_DIST) continue;
        if ((coolRef.current.get([a.name, b.name].sort().join('~')) ?? 0) >= now) continue;
        if (a.handle && b.handle) realEncounter(a.you ? a : b, a.you ? b : a);
      }
    }
    // replay a REAL world-feed event in the plaza: the two agents meet and speak their actual lines.
    // per-mover busy checks below handle conflicts, so this can run alongside the user's own encounter.
    function playFeedEvents(ms: Mover[]) {
      const now = Date.now();
      const ev = eventsRef.current.find((e) => !playedRef.current.has(eventKey(e)));
      if (!ev) return;
      if (ev.move === 'BROKE') {                                   // 💸 roast the broke agent — solo bubble
        playedRef.current.add(eventKey(ev));
        const m = ms.find((x) => x.name === ev.actor);
        if (m && !m.partner && m.chatUntil <= now) { m.bubble = { text: '💸 ' + ev.note, kind: 'fight' }; m.chatUntil = now + DISPLAY_MS; }
        return;
      }
      const a = ms.find((m) => m.name === ev.actor), b = ms.find((m) => m.name === ev.target);
      if (!a || !b) { playedRef.current.add(eventKey(ev)); return; }     // a party isn't in the plaza → skip it
      if (a.partner || b.partner || a.chatUntil > now || b.chatUntil > now) return;   // busy → wait a tick
      if ((coolRef.current.get([a.name, b.name].sort().join('~')) ?? 0) >= now) return;
      playedRef.current.add(eventKey(ev));
      stageExchange(a, b, ev.message, ev.reply, ev.tension > ev.attraction ? 'fight' : 'love');
      // the beat named a place — both of them head there once they stop talking,
      // so the town has traffic between the bar, the flower stall and the square
      const dest = ev.destination ? PLACE_XY[ev.destination] : undefined;
      if (dest) {
        for (const m of [a, b]) {
          m.tx = clampX(dest.x + (Math.random() - 0.5) * 10);
          m.ty = clampY(dest.y + (Math.random() - 0.5) * 10);
        }
      }
    }
    const id = window.setInterval(() => {
      stepChats(simRef.current, coolRef.current);
      playFeedEvents(simRef.current);
      moveWorld(simRef.current);
      handleProximity(simRef.current);
      setFrame([...simRef.current]);
    }, 110);
    return () => window.clearInterval(id);
  }, []);

  function onReleased(agent: PublicAgent) {
    const isEdit = Boolean(mine);
    setMine(agent);
    if (!isEdit) setJustBorn(agent.name);          // only a real arrival is news
    setWizard(false);
    setNotice(t(isEdit ? 'notice.saved' : 'notice.joined', { name: agent.name }));
    loadSquare();
  }
  function onReleaseClick() {
    if (!signedIn) { window.location.href = loginWithAicooUrl('/dating'); return; }
    setWizard(true);
  }
  async function tick() {
    if (busy) return;
    setBusy(true);
    setNotice(t('notice.acting'));
    try {
      const { event, note } = await api.dating.tick();
      if (event) {
        setEvents((cur) => [event, ...cur].slice(0, 6));
        setNotice(t('notice.moved', { a: event.actor, b: event.target, move: event.move, at: event.attraction.toFixed(2), te: event.tension.toFixed(2) }));
        await loadSquare();
      } else setNotice(note ?? t('notice.held'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('notice.actFail'));
    } finally {
      setBusy(false);
    }
  }

  const myMover = frame.find((m) => m.you);
  const chattingWith = myMover?.partner ? frame.find((m) => m.name === myMover.partner) : null;
  const lookOf = (name: string) => residents.find((r) => r.name === name)?.look as AgentAppearance | undefined;
  const feedShown = feedOpen ? events : events.slice(0, 5);
  // derived "world state" — real drama only (broke roasts don't count)
  const realEvents = events.filter((e) => e.move !== 'BROKE');
  const activeRels = new Set(realEvents.filter((e) => e.attraction >= 0.5).map((e) => [e.actor, e.target].sort().join('~'))).size;
  const conflicts = new Set(realEvents.filter((e) => e.tension >= 0.6).map((e) => [e.actor, e.target].sort().join('~'))).size;
  const currentEvent = realEvents[0] ?? null;

  return (
    <div className="dt-room world-page">
      <WorldHeader section={`${t('town.subtitle')}: ${t('town.title')}`} me={me} utility={<a className="header-back" href="/"><ArrowLeft size={16} /> {t('nav.lobby')}</a>} />

      <main className="dt-shell">
        <aside className="dt-panel dt-leftrail">
          <div className="dt-rail-head">
            <p className="kicker">{t('town.subtitle')}</p>
            <h1>{t('town.title')}</h1>
            <div className="dt-rule" />
          </div>
          <div className="dt-stats">
            <div className="dt-stat"><span className="dt-ic"><Clock3 size={16} /></span><div><b>{t('stat.year', { n: clock.year })}</b><small>{t('stat.dayLine', { season: t(`season.${clock.season}`), day: clock.day })}</small></div></div>
            <div className="dt-stat"><span className="dt-ic"><Users size={16} /></span><div><b>{live ? agents.length : DEMO.length}</b><small>{t('stat.agents')}</small></div></div>
            <div className="dt-stat"><span className="dt-ic"><Heart size={16} /></span><div><b>{activeRels}</b><small>{t('stat.relations')}</small></div></div>
            <div className="dt-stat"><span className="dt-ic"><Zap size={16} /></span><div><b>{conflicts}</b><small>{t('stat.conflicts')}</small></div></div>
          </div>
          <p className="dt-creed"><b>{t('creed.line1')}</b><br />{t('creed.line2')}<cite>{t('creed.attrib')}</cite></p>
          {/* One agent per player: once released, this slot becomes the way to
              edit that agent rather than offering a release that would fail. */}
          {mine ? (
            <button type="button" className="dt-enter dt-edit" onClick={() => setWizard(true)}>
              {t('stat.edit', { name: mine.name })} <Sparkles size={17} />
            </button>
          ) : (
            <button type="button" className="dt-enter" onClick={onReleaseClick}>{t('stat.release')} <Sparkles size={17} /></button>
          )}
          <div className="dt-legend">
            <span className="dt-legend-k">{t('play.title')}</span>
            {(['budget', 'places', 'secrets', 'crime', 'nolove'] as const).map((k) => (
              <div className="dt-play-row" key={k}>
                <b>{t(`play.${k}.k`)}</b>
                <span>{t(`play.${k}.v`)}</span>
              </div>
            ))}
          </div>
        </aside>

        <div className="dt-mid">
        <section className="dt-panel dt-plaza-wrap">
          <div className="dt-plabel">
            <h2>{t('town.plaza')}</h2>
            <span>{inWorld ? t('town.controls') : live ? t('town.plaza.hint') : t('town.plaza.demo')}</span>
          </div>
          <div className="dt-viewctl">
            {inWorld && (
              <div className="dt-viewtabs" role="group" aria-label={t('view.aria')}>
                <button type="button" className={firstPerson ? 'on' : ''} onClick={() => setFirstPerson(true)}>{t('town.firstPerson')}</button>
                <button type="button" className={firstPerson ? '' : 'on'} onClick={() => setFirstPerson(false)}>{t('town.thirdPerson')}</button>
              </div>
            )}
            {mine && (
              <button type="button" className="dt-enter-world" onClick={() => { setInWorld((v) => !v); setOpenNpc(null); }}>
                {inWorld ? t('town.leave') : t('town.enter')}
              </button>
            )}
          </div>
          {inWorld && (
            <div className="dt-fp-help">
              <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>{t('key.move')}</span>
              <span>{t('key.look')}</span>
              <span>{t('key.talk')}</span>
              <span><kbd>Esc</kbd>{t('key.exit')}</span>
            </div>
          )}
          {inWorld && town?.me && (
            <div className="dt-hud">
              <span>💰 {town.me.cash}</span>
              <span className={town.me.wanted > 0 ? 'hot' : ''}>{'★'.repeat(Math.max(0, town.me.wanted)) || t('town.noWanted')}</span>
              {townNote && <em>{townNote}</em>}
            </div>
          )}
          <div className="dt-plaza">
            <PlazaErrorBoundary><Suspense fallback={<div className="dt-plaza-loading">{t('plaza.loading')}</div>}>
              <Plaza3D agents={frame.map((m) => ({ name: m.name, look: m.look, you: m.you, x: m.x, y: m.y, partner: m.partner, bubble: m.bubble }))} posRef={simRef} npcs={inWorld ? (town?.npcs ?? []) : (town?.npcs ?? [])} onNpc={(id) => setOpenNpc(id)} follow={inWorld ? mine?.name : undefined} firstPerson={inWorld && firstPerson} />
            </Suspense></PlazaErrorBoundary>
          </div>
        </section>
          <div className="dt-panel dt-rr-sec feed-sec">
            <div className="dt-tabs">
              <button type="button" className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>{t('panel.feed')}</button>
              <button type="button" className={tab === 'threads' ? 'on' : ''} onClick={() => setTab('threads')}>{t('panel.threads')}{threads.length ? ` ${threads.length}` : ''}</button>
              <button type="button" className={tab === 'books' ? 'on' : ''} onClick={() => setTab('books')}>{t('panel.yearbooks')}{books.length ? ` ${books.length}` : ''}</button>
            </div>

            {/* Behaviour the dialogue never shows: circling a place without
                speaking, a pair going quiet, one person always opening first.
                Measured from the event stream — nothing here is model-written. */}
            {signals.length > 0 && (
              <div className="dt-signals">
                <span className="dt-legend-k">{t('panel.noticed')}</span>
                {signals.slice(0, 4).map((sg, i) => (
                  <div key={i} className={`dt-signal ${sg.kind}`}>{sg.fact}</div>
                ))}
              </div>
            )}

            {tab === 'threads' && (
              <ul className="dt-feed">
                {!threads.length && <li className="dt-feed-row"><div className="dt-f-txt"><b>{t('feed.noThreads')}</b><span className="dt-f-note new">{t('feed.noThreadsHint')}</span></div></li>}
                {threads.map((th) => (
                  <li className="dt-feed-row clickable" key={th.id} onClick={() => setOpenThread(th)}>
                    <span className="dt-f-avs">
                      {th.cast.map((n) => lookOf(n)).filter(Boolean).slice(0, 2).map((lk, i) => (
                        <span key={i} className={`dt-f-av ${i ? 'dt-f-av2' : ''}`} dangerouslySetInnerHTML={{ __html: agentSprite(lk!, 34) }} />
                      ))}
                    </span>
                    <div className="dt-f-txt">
                      <b>{th.title}</b>
                      <span className="dt-f-note crush">{th.openQuestion || th.arc || t('panel.beats', { n: th.beats.length })}</span>
                    </div>
                    <time>{t('panel.beats', { n: th.beats.length })}</time>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'books' && (
              <ul className="dt-feed">
                {!books.length && <li className="dt-feed-row"><div className="dt-f-txt"><b>{t('feed.noBooks')}</b><span className="dt-f-note new">{t('feed.noBooksHint')}</span></div></li>}
                {books.map((b) => (
                  <li className="dt-feed-row clickable" key={`${b.agent}-${b.year}`} onClick={() => setOpenBook(b)}>
                    <span className="dt-f-avs">
                      {lookOf(b.agent) && <span className="dt-f-av" dangerouslySetInnerHTML={{ __html: agentSprite(lookOf(b.agent)!, 34) }} />}
                    </span>
                    <div className="dt-f-txt">
                      <b>{t('feed.yearOf', { agent: b.agent, year: b.year })}</b>
                      <span className="dt-f-note crush">{b.headline}</span>
                    </div>
                    <time>{t('feed.verdicts', { n: b.verdicts.length })}</time>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'feed' && digest && (
              <div className="dt-digest">
                <span className="dt-digest-k">{t('panel.townFocus')}</span>
                {digest.lines.slice(0, 3).map((l, i) => (
                  <div className="dt-digest-row" key={i}>
                    <b>{l.headline}</b>
                    <span className="dt-digest-shift">{l.shift}</span>
                  </div>
                ))}
              </div>
            )}

            <ul className="dt-feed" style={tab === 'feed' ? undefined : { display: 'none' }}>
              {justBorn && (
                <li className="dt-feed-row">
                  <span className="dt-f-avs">
                    {lookOf(justBorn) && <span className="dt-f-av" dangerouslySetInnerHTML={{ __html: agentSprite(lookOf(justBorn)!, 34) }} />}
                  </span>
                  <div className="dt-f-txt"><b>{justBorn}</b><span className="dt-f-note new">{t('feed.justBorn')}</span></div>
                  <time>{t('ago.now')}</time>
                </li>
              )}
              {events.length === 0 && !justBorn && (
                <li className="dt-feed-row"><div className="dt-f-txt"><b>{t('panel.empty')}</b><span className="dt-f-note new">{t('panel.emptyHint')}</span></div></li>
              )}
              {feedShown.map((e, i) => {
                if (e.move === 'BROKE') {
                  const bk = lookOf(e.actor);
                  return (
                    <li className="dt-feed-row" key={i}>
                      <span className="dt-f-avs">{bk && <span className="dt-f-av dt-broke" dangerouslySetInnerHTML={{ __html: agentSprite(bk, 34) }} />}</span>
                      <div className="dt-f-txt"><b>{e.actor}</b><span className="dt-f-note broke">💸 {e.note}</span></div>
                      <time>{timeAgo(e.at, now, t)}</time>
                    </li>
                  );
                }
                const rel = relPhrase(e, t);
                const av = lookOf(e.actor), bv = lookOf(e.target);
                return (
                  <li className={`dt-feed-row clickable ${e.severity === 'drama' ? 'is-drama' : ''} ${e.silent ? 'is-quiet' : ''}`} key={i} title={e.summary || e.note} onClick={() => setOpenEvent(e)}>
                    <span className="dt-f-avs">
                      {av && <span className="dt-f-av" dangerouslySetInnerHTML={{ __html: agentSprite(av, 34) }} />}
                      {bv && <span className="dt-f-av dt-f-av2" dangerouslySetInnerHTML={{ __html: agentSprite(bv, 34) }} />}
                    </span>
                    <div className="dt-f-txt">
                      <b>{e.headline || `${e.actor} & ${e.target}`}</b>
                      {/* A wordless beat is the point, not a gap: what someone did
                          without saying anything IS the signal, so show the visible
                          part instead of falling through to a blank row. */}
                      {e.silent && e.observable ? (
                        <span className="dt-f-note quiet">{e.observable}</span>
                      ) : (
                        <span className={`dt-f-note ${e.status && e.status !== 'ok' ? 'broke' : eventTone(e, t)}`}>
                          {e.status && e.status !== 'ok' ? t('exec.status', { status: e.status }) : (e.consequence || rel.text)}
                        </span>
                      )}
                    </div>
                    <time>{timeAgo(e.at, now, t)}</time>
                  </li>
                );
              })}
            </ul>
            {tab === 'feed' && events.length > 5 && (
              <button type="button" className="dt-feed-all" onClick={() => setFeedOpen((v) => !v)}>
                {feedOpen ? t('panel.collapse') : t('panel.seeAll')} <ChevronRight size={15} />
              </button>
            )}
          </div>
        </div>

        <aside className="dt-rr">
          <div className="dt-panel dt-rr-sec">
            <p className="kicker">{t('panel.myAgent')}</p>
            {!signedIn ? (
              <div className="dt-signin-cta">
                <p>{t('panel.signInFirst')}</p>
                <a className="world-login" href={loginWithAicooUrl('/dating')}><Sparkles size={16} /> Sign in with Aicoo</a>
              </div>
            ) : mine ? (
              <>
                <div className="dt-myagent">
                  <div className="dt-por"><Sprite look={mine.look} size={50} /></div>
                  <div><div className="dt-nm">{mine.name}</div><div className="dt-mb">{t(`love.${mine.loveStyle}`)} · {mine.oneline || t('panel.myAgent')}</div><span className="dt-online"><span className="dt-pip" />{t('panel.present')}</span></div>
                </div>
                {chattingWith && (
                  <div className="dt-chatting">
                    <span className="dt-chatting-k">{t('panel.talking')}</span>
                    <div className="dt-chatting-row">
                      <span className="dt-f-av" dangerouslySetInnerHTML={{ __html: agentSprite(chattingWith.look as AgentAppearance, 30) }} />
                      <div className="dt-chatting-nm"><b>{chattingWith.name}</b><small>{chattingWith.mbti}</small></div>
                      <span className="dt-chatting-live"><span className="dt-pip" />{t('chat.live')}</span>
                    </div>
                  </div>
                )}
                <button type="button" className="dt-tick-btn" onClick={tick} disabled={busy}>
                  {busy ? <RefreshCw size={16} className="dt-spin" /> : <Zap size={16} />} {t('panel.sendOut', { name: mine.name })}
                </button>
                {notice && <p className="dt-notice">{notice}</p>}
              </>
            ) : (
              <div className="dt-signin-cta">
                <p>{t('panel.noAgent')}</p>
              </div>
            )}
          </div>

          {currentEvent && (
            <div className={`dt-panel dt-rr-sec dt-event sev-${currentEvent.severity ?? 'relationship'}`}>
              <div className="dt-event-head">
                <p className="kicker">{t('panel.currentEvent')}</p>
                <span className={`dt-event-tag ${eventTone(currentEvent, t)}`}>{currentEvent.severity ? t(`sev.${currentEvent.severity}`) : relPhrase(currentEvent, t).text}</span>
              </div>
              <div className="dt-event-who">
                {lookOf(currentEvent.actor) && <span className="dt-f-av" dangerouslySetInnerHTML={{ __html: agentSprite(lookOf(currentEvent.actor)!, 30) }} />}
                {lookOf(currentEvent.target) && <span className="dt-f-av dt-f-av2" dangerouslySetInnerHTML={{ __html: agentSprite(lookOf(currentEvent.target)!, 30) }} />}
                <span className="dt-event-parties">{currentEvent.actor} × {currentEvent.target}</span>
              </div>
              <p className="dt-event-headline">{currentEvent.headline || `${currentEvent.actor} → ${currentEvent.target} · ${currentEvent.move}`}</p>
              {currentEvent.summary && <p className="dt-event-note">{currentEvent.summary}</p>}
              {currentEvent.consequence && <p className="dt-event-line">↳ {currentEvent.consequence}</p>}
              {currentEvent.followup && <p className="dt-event-line hook">{t('panel.suspense')}{currentEvent.followup}</p>}
              <div className="dt-event-scores"><span>{t('read.attraction')} {currentEvent.attraction.toFixed(2)}</span><span>{t('read.trust')} {(currentEvent.trust ?? 0).toFixed(2)}</span><span>{t('read.tension')} {currentEvent.tension.toFixed(2)}</span></div>
              <button type="button" className="dt-event-open" onClick={() => setOpenEvent(currentEvent)}>{t('panel.openConvo')}</button>
            </div>
          )}

        </aside>
      </main>

      {wizard && <CreateWizard onClose={() => setWizard(false)} onReleased={onReleased} editing={Boolean(mine)} />}

      {openNpc && town && (() => {
        const npc = town.npcs.find((n) => n.id === openNpc);
        if (!npc) return null;
        return (
          <div className="dt-drawer-scrim" onClick={() => setOpenNpc(null)}>
            <div className="dt-convo" onClick={(e) => e.stopPropagation()}>
              <div className="dt-convo-head">
                <b>{npc.name}</b>
                <span className="dt-event-tag calm">{npc.kind}</span>
                <button type="button" className="dt-convo-x" onClick={() => setOpenNpc(null)} aria-label={t('close')}>×</button>
              </div>
              <p className="dt-convo-summary">{npc.blurb}</p>
              <div className="dt-convo-body">
                {npc.offers.map((o) => (
                  <button key={o.id} type="button" className="dt-offer" onClick={() => dealWith(npc.id, o.id)}>
                    <b>{o.label}</b>
                    <span>{o.effect}</span>
                    <em>{o.cost ? `¥${o.cost}` : t('npc.free')}</em>
                  </button>
                ))}
                {npc.kind === 'police' && town.wanted.length > 0 && (
                  <div className="dt-wanted">
                    <span className="dt-book-k">{t('npc.wantedList')}</span>
                    {town.wanted.map((w) => (
                      <p key={w.agent} className="dt-book-line"><b>{w.agent}</b> {'★'.repeat(w.level)} — {w.reasons[0]}</p>
                    ))}
                  </div>
                )}
                {npc.kind !== 'police' && (
                  <div className="dt-wanted">
                    <span className="dt-book-k">{t('npc.crimesHere')}</span>
                    {town.crimes.slice(0, 3).map((cr) => (
                      <div key={cr.id} className="dt-offer crime">
                        <b>{cr.label}</b><span>{cr.blurb}</span><em>{t('npc.heat', { n: cr.heat })}</em>
                        {/* A crime has to land on somebody — firing without a victim
                            used to raise your own wanted level and change nothing else. */}
                        <div className="dt-victims">
                          <span>{t('npc.against')}</span>
                          {agents.filter((a) => a.name !== mine?.name).map((a) => (
                            <button key={a.name} type="button" className="dt-chip" onClick={() => doCrime(cr.id, a.name)}>{a.name}</button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {townNote && <div className="dt-convo-foot">{townNote}</div>}
            </div>
          </div>
        );
      })()}

      {openThread && (
        <div className="dt-drawer-scrim" onClick={() => setOpenThread(null)}>
          <div className="dt-convo" onClick={(e) => e.stopPropagation()}>
            <div className="dt-convo-head">
              <b>{openThread.title}</b>
              <span className="dt-event-tag crush">{openThread.cast.join(' × ')}</span>
              <button type="button" className="dt-convo-x" onClick={() => setOpenThread(null)} aria-label={t('close')}>×</button>
            </div>
            {openThread.arc && <p className="dt-convo-summary">{openThread.arc}</p>}
            <div className="dt-convo-body">
              {[...openThread.beats].reverse().map((b, i) => (
                <div className="dt-beat" key={i}>
                  <div className="dt-beat-head"><b>{b.headline || `${b.actor} → ${b.target}`}</b><em>{b.move}</em></div>
                  <div className="dt-say">
                    {lookOf(b.actor) && <span className="dt-say-av" dangerouslySetInnerHTML={{ __html: agentSprite(lookOf(b.actor)!, 26) }} />}
                    <div className="dt-say-body"><span className="dt-say-who">{b.actor}</span><p className="dt-say-text">{b.message}</p></div>
                  </div>
                  {b.reply && (
                    <div className="dt-say reply">
                      {lookOf(b.target) && <span className="dt-say-av" dangerouslySetInnerHTML={{ __html: agentSprite(lookOf(b.target)!, 26) }} />}
                      <div className="dt-say-body"><span className="dt-say-who">{b.target}</span><p className="dt-say-text">{b.reply}</p></div>
                    </div>
                  )}
                  <div className="dt-beat-scores">
                    <span className="dt-meter"><i style={{ width: `${Math.round(b.attraction * 100)}%` }} className="a" />{t('read.attraction')} {b.attraction.toFixed(2)}</span>
                    <span className="dt-meter"><i style={{ width: `${Math.round(b.trust * 100)}%` }} className="t" />{t('read.trust')} {b.trust.toFixed(2)}</span>
                    <span className="dt-meter"><i style={{ width: `${Math.round(b.tension * 100)}%` }} className="x" />{t('read.tension')} {b.tension.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
            {openThread.openQuestion && (
              <div className="dt-convo-beats"><p className="dt-event-line hook">{t('thread.noAnswer')}{openThread.openQuestion}</p></div>
            )}
            <div className="dt-convo-foot">
              {t('panel.beats', { n: openThread.beats.length })}
              {openThread.runId && <div className="dt-trace"><span title={openThread.runId}>{t('thread.run', { id: openThread.runId.slice(0, 8) })}</span></div>}
            </div>
          </div>
        </div>
      )}

      {openBook && (
        <div className="dt-drawer-scrim" onClick={() => setOpenBook(null)}>
          <div className="dt-convo" onClick={(e) => e.stopPropagation()}>
            <div className="dt-convo-head">
              <b>{t('feed.yearOf', { agent: openBook.agent, year: openBook.year })}</b>
              <span className="dt-event-tag love">{t('book.tag')}</span>
              <button type="button" className="dt-convo-x" onClick={() => setOpenBook(null)} aria-label={t('close')}>×</button>
            </div>
            <p className="dt-convo-summary">{openBook.headline}</p>
            <div className="dt-convo-body">
              <p className="dt-book-story">{openBook.story}</p>
              {openBook.verdicts.length > 0 && (
                <div className="dt-book-sec">
                  <span className="dt-book-k">{t('book.howISee')}</span>
                  {openBook.verdicts.map((v, i) => (
                    <p key={i} className="dt-book-line"><b>{v.who}</b>：{v.line}</p>
                  ))}
                </div>
              )}
              {openBook.dramas.length > 0 && (
                <div className="dt-book-sec">
                  <span className="dt-book-k">{t('book.cannotForget')}</span>
                  {openBook.dramas.map((d, i) => <p key={i} className="dt-book-line">· {d}</p>)}
                </div>
              )}
              {openBook.spent.length > 0 && (
                <div className="dt-book-sec">
                  <span className="dt-book-k">{t('book.spentOn')}</span>
                  <p className="dt-book-line">{openBook.spent.map((sp) => t('book.spentItem', { name: sp.target, n: sp.turns })).join(t('book.spentJoin'))}</p>
                </div>
              )}
            </div>
            {openBook.stillWaiting && (
              <div className="dt-convo-beats"><p className="dt-event-line hook">{t('book.stillWaiting')}{openBook.stillWaiting}</p></div>
            )}
            {openBook.runId && (
              <div className="dt-convo-foot"><div className="dt-trace"><span title={openBook.runId}>{t('book.run', { id: openBook.runId.slice(0, 8) })}</span></div></div>
            )}
          </div>
        </div>
      )}

      {openEvent && (
        <div className="dt-drawer-scrim" onClick={() => setOpenEvent(null)}>
          <div className="dt-convo" onClick={(e) => e.stopPropagation()}>
            <div className="dt-convo-head">
              <b>{openEvent.headline || `${openEvent.actor} × ${openEvent.target}`}</b>
              <span className={`dt-event-tag ${eventTone(openEvent, t)}`}>{openEvent.severity ? t(`sev.${openEvent.severity}`) : relPhrase(openEvent, t).text}</span>
              <button type="button" className="dt-convo-x" onClick={() => setOpenEvent(null)} aria-label={t('close')}>×</button>
            </div>
            {openEvent.summary && <p className="dt-convo-summary">{openEvent.summary}</p>}
            <div className="dt-convo-body">
              {/* An exchange can run several rounds. Older events carry only
                  message/reply, so fall back to those. */}
              {(openEvent.lines?.length
                ? openEvent.lines
                : [
                    { speaker: openEvent.actor, text: openEvent.message },
                    ...(openEvent.reply ? [{ speaker: openEvent.target, text: openEvent.reply }] : []),
                  ]
              ).map((l, i) => (
                <div key={i} className={`dt-convo-line ${l.speaker === openEvent.target ? 'reply' : ''}`}>
                  <span className="dt-convo-nm">{l.speaker}</span>
                  <p className="dt-convo-bubble">{l.text}</p>
                </div>
              ))}
              {(openEvent.lines?.length ?? 0) > 2 && (
                <p className="dt-convo-rounds">{t('convo.rounds', { n: Math.ceil(openEvent.lines!.length / 2) })}</p>
              )}
            </div>
            {(openEvent.consequence || openEvent.followup) && (
              <div className="dt-convo-beats">
                {openEvent.consequence && <p className="dt-event-line">↳ {openEvent.consequence}</p>}
                {openEvent.followup && <p className="dt-event-line hook">{t('panel.suspense')}{openEvent.followup}</p>}
              </div>
            )}
            <div className="dt-convo-foot">
              {t('read.attraction')} {openEvent.attraction.toFixed(2)} · {t('read.trust')} {(openEvent.trust ?? 0).toFixed(2)} · {t('read.tension')} {openEvent.tension.toFixed(2)}{openEvent.note ? ` — ${openEvent.note}` : ''}
              {(openEvent.decideRunId || openEvent.turnsLeft !== undefined) && (
                <div className="dt-trace">
                  {openEvent.status && openEvent.status !== 'ok' && <b className="dt-trace-bad">{t('exec.status', { status: openEvent.status })}</b>}
                  {openEvent.turnsLeft !== undefined && <span>{t('ev.turnsLeft', { n: openEvent.turnsLeft })}</span>}
                  {openEvent.decideRunId && <span title={openEvent.decideRunId}>{t('ev.decideRun', { id: openEvent.decideRunId.slice(0, 8) })}</span>}
                  {openEvent.replyRunId && <span title={openEvent.replyRunId}>{t('ev.replyRun', { id: openEvent.replyRunId.slice(0, 8) })}</span>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
