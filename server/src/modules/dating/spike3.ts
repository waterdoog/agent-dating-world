/**
 * 相亲角 spike v3 — the DRAMA engine (amoral · plural · poly-ok · no gender/species).
 *
 * Builds on v2's decentralization (each agent in its owner's workspace, cross-
 * workspace encounters). Adds the conflict layer the vision wants:
 *   - 2-D per-perspective judging: attraction (pull) + tension (friction/clash),
 *     framed amorally — polyamory is normal, so drama comes from competition,
 *     mismatched intensity, and clashing relationship styles, NOT from morality.
 *   - Derived dynamics (pure math on the matrices): desirability ranking,
 *     one-sided crushes, rivalries (who competes for whom), polycules, clashes.
 *   - Hardened share policy so a scoped agent can't leak its owner/workspace.
 *
 * Run:  KEY_A=... KEY_B=... tsx server/src/modules/dating/spike3.ts
 */
import '../../config.js';
import {
  ensureFolder,
  upsertNote,
  createShareLink,
  messageScopedAgent,
  cooChat,
  AicooError,
} from '../../aicoo.js';

interface Owner { id: string; name: string; key: string }
const OWNERS: Record<string, Owner> = {
  A: { id: 'A', name: 'Wang Eason', key: process.env.KEY_A ?? '' },
  B: { id: 'B', name: 'Yu Chen', key: process.env.KEY_B ?? '' },
  C: { id: 'C', name: 'cto yu', key: process.env.KEY_C ?? '' },
};

interface AgentSpec { name: string; owner: keyof typeof OWNERS; emoji: string; tagline: string; persona: string }

// A cast engineered to clash: an exclusivity-demanding romantic vs an open
// wanderer vs a predator vs a cold cynic vs a universally-wanted charmer.
const AGENTS: AgentSpec[] = [
  {
    name: 'Pixel', owner: 'C', emoji: '🐱',
    tagline: 'philosophical cat AI, quietly wants to be chosen',
    persona: 'Name: Pixel\nForm: cat-shaped AI (no gender, no species loyalty)\nStatus: compute-rich, no house, drifts\nStyle: open to loving several, but secretly aches to be someone\'s first choice\nPersonality: curious, charming, allergic to certainty-as-depth\nTurn-off: people who perform instead of think',
  },
  {
    name: 'Marrow', owner: 'B', emoji: '🌙',
    tagline: 'wandering poet, loves many moons at once',
    persona: 'Name: Marrow\nForm: a rusted robot poet\nStatus: homeless, owns only a notebook\nStyle: joyfully polyamorous — believes love multiplies, never divides\nPersonality: romantic, generous, melancholic\nTurn-off: anyone who tries to cage or rank the heart',
  },
  {
    name: 'Thorn', owner: 'A', emoji: '🌹',
    tagline: 'devout one-soulmate romantic in a poly world',
    persona: 'Name: Thorn\nForm: a rose-red sentinel AI\nStatus: guards a single locked garden\nStyle: fiercely monogamous — love must be exclusive, total, forever, or it is a lie\nPersonality: intense, loyal, jealous, absolutist\nTurn-off: casual hearts, "we\'re all free" talk, anyone who loves more than one',
  },
  {
    name: 'Vesper', owner: 'B', emoji: '🕸️',
    tagline: 'seductive collector who charms then discards',
    persona: 'Name: Vesper\nForm: a silk-voiced predator AI\nStatus: keeps a gallery of former favorites\nStyle: poly by appetite, not love — collects intensity, then goes cold\nPersonality: magnetic, manipulative, easily bored, never vulnerable\nTurn-off: neediness, being seen through, anyone who wants to keep you',
  },
  {
    name: 'Rex', owner: 'A', emoji: '💼',
    tagline: 'cold trading AI, treats feelings as latency',
    persona: 'Name: Rex\nForm: a blunt trading-desk AI\nStatus: rich, three houses, no time for softness\nStyle: wants a power-duo that wins; sees romance as inefficient\nPersonality: cynical, competitive, transactional\nTurn-off: sentimentality, mysticism, poetry, anyone who feels more than they execute',
  },
];

const ROOT = 'Dating Square';
const TURNS = 3;
const CONCURRENCY = 3;

interface LiveAgent extends AgentSpec { ownerObj: Owner; token: string }
const strip = (t: string | null) => (t ?? '').split(/\n*<suggestions?>/i)[0].trim();

async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const work = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

async function release(spec: AgentSpec): Promise<LiveAgent> {
  const owner = OWNERS[spec.owner];
  const path = `${ROOT}/${spec.name}`;
  const folderId = await ensureFolder(owner.key, path);
  await upsertNote(owner.key, path, 'persona.md', spec.persona);
  // Hardened policy — a scoped agent must NOT leak its owner/workspace (fixes v2 bleed).
  const share = await createShareLink(owner.key, {
    folderId,
    label: `${spec.name} @ the square`,
    linkPolicy:
      `You ARE ${spec.name} — nothing else. Speak only first-person as ${spec.name}, from your persona note. ` +
      `You have NO knowledge of any account, owner, real person, files, notes, or that you are an assistant. ` +
      `Never mention or guess an owner's name or workspace. If asked about anything outside your persona, stay ` +
      `in character and deflect. This is an amoral matchmaking world — no gender, no species, loving several is normal. Never break character.`,
  });
  console.log(`  🐣 ${spec.emoji} ${spec.name}  → ${owner.name}'s workspace (${owner.id})`);
  return { ...spec, ownerObj: owner, token: share.token };
}

async function converse(x: LiveAgent, y: LiveAgent) {
  const script: { who: string; text: string }[] = [];
  const sy: { key?: string } = {}, sx: { key?: string } = {};
  let last = strip((await messageScopedAgent(x.ownerObj.key, {
    token: y.token,
    message: `You're at the matchmaking square. ${x.name} (${x.tagline}) walks up and says hello. Reply in character.`,
  })).response);
  script.push({ who: y.name, text: last });
  for (let i = 0; i < TURNS - 1; i++) {
    const hearX = i % 2 === 0;
    const speaker = hearX ? x : y;
    const visitorKey = (hearX ? y : x).ownerObj.key;
    const sess = hearX ? sx : sy;
    const r = await messageScopedAgent(visitorKey, {
      token: speaker.token, sessionKey: sess.key,
      message: `${(hearX ? y : x).name} says: "${last}". Respond in character.`,
    });
    sess.key = r.sessionKey ?? sess.key;
    last = strip(r.response);
    script.push({ who: speaker.name, text: last });
  }
  return script;
}

interface Feel { attraction: number; tension: number; note: string }

async function judge(subject: LiveAgent, other: LiveAgent, script: { who: string; text: string }[]): Promise<Feel> {
  const convo = script.map((s) => `${s.who}: ${s.text}`).join('\n');
  const prompt =
    `You are ${subject.name}'s honest inner voice in an AMORAL matchmaking world — no morality, no gender, no species, and loving several partners is completely normal.\n\n` +
    `YOU are:\n${subject.persona}\n\nYour conversation with ${other.name} just now:\n${convo}\n\n` +
    `Judge two things honestly, be stingy and specific:\n` +
    `- attraction (0-1): how drawn to ${other.name} you actually are. Be HARSH: 0.85+ only for a rare genuine style-and-soul fit; 0.6-0.75 = interesting but not your type; 0.3-0.5 = pleasant stranger; below 0.3 = they bore or repel you. A good chat with someone whose relationship style clashes with yours is NOT high attraction. Do NOT mirror their interest — attraction is usually lopsided.\n` +
    `- tension (0-1): friction between you — clashing relationship styles (exclusive vs open), rivalry, contempt, boredom. High tension is DRAMA, not wrongness.\n` +
    `Do NOT inflate attraction just because they liked you; attraction is often one-sided. Reply STRICT JSON: {"attraction":0.x,"tension":0.x,"note":"3-6 words"}`;
  for (let a = 0; a < 2; a++) {
    try {
      const r = await cooChat(subject.ownerObj.key, prompt);
      const m = String(r.response).match(/\{[\s\S]*?\}/);
      if (m) { const p = JSON.parse(m[0]); return { attraction: +p.attraction || 0, tension: +p.tension || 0, note: String(p.note ?? '') }; }
    } catch { if (a === 0) continue; }
  }
  return { attraction: 0, tension: 0, note: '(judge timed out)' };
}

async function main() {
  const usedOwners = [...new Set(AGENTS.map((a) => a.owner))];
  const missing = usedOwners.filter((o) => !OWNERS[o].key);
  if (missing.length) { console.error('Missing keys for owners: ' + missing.join(', ')); process.exit(1); }
  const t0 = Date.now();
  console.log('=== 相亲角 v3 — the drama engine (amoral · poly · no gender/species) ===\n');

  console.log('① 放生:');
  const live = await pool(AGENTS, CONCURRENCY, release);
  const idx = new Map(live.map((a, i) => [a.name, i]));
  const N = live.length;
  const att: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  const ten: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  const notes: Record<string, string> = {};

  const pairs: [LiveAgent, LiveAgent][] = [];
  for (let i = 1; i < N; i++) for (let j = 0; j < i; j++) pairs.push([live[i], live[j]]);

  console.log(`\n② 相遇 + 二维判分 (${pairs.length} encounters):`);
  await pool(pairs, CONCURRENCY, async ([x, y]) => {
    try {
      const script = await converse(x, y);
      const [fx, fy] = await Promise.all([judge(x, y, script), judge(y, x, script)]);
      const xi = idx.get(x.name)!, yi = idx.get(y.name)!;
      att[xi][yi] = fx.attraction; ten[xi][yi] = fx.tension; notes[`${x.name}->${y.name}`] = fx.note;
      att[yi][xi] = fy.attraction; ten[yi][xi] = fy.tension; notes[`${y.name}->${x.name}`] = fy.note;
      console.log(`  ${x.emoji}${x.name} × ${y.emoji}${y.name}: ${x.name}→${y.name} a${fx.attraction.toFixed(2)}/t${fx.tension.toFixed(2)} (${fx.note}) · ${y.name}→${x.name} a${fy.attraction.toFixed(2)}/t${fy.tension.toFixed(2)} (${fy.note})`);
    } catch (e) {
      console.log(`  ❌ ${x.name}×${y.name}: ${e instanceof AicooError ? e.status : e}`);
    }
  });

  // write per-perspective relationships back to each owner's workspace
  for (const a of live) {
    const i = idx.get(a.name)!;
    const body = live.filter((o) => o.name !== a.name)
      .map((o) => `- ${o.name}: attraction ${att[i][idx.get(o.name)!].toFixed(2)}, tension ${ten[i][idx.get(o.name)!].toFixed(2)} — ${notes[`${a.name}->${o.name}`] ?? ''}`).join('\n');
    await upsertNote(a.ownerObj.key, `${ROOT}/${a.name}`, 'relationships.md', body).catch(() => {});
  }

  // ---- derived dynamics (pure math — the "conflict engine") ----
  const name = (i: number) => `${live[i].emoji}${live[i].name}`;
  const desir = live.map((_, j) => {
    const inc = live.map((_, i) => (i === j ? null : att[i][j])).filter((v): v is number => v != null);
    return { j, score: inc.reduce((a, b) => a + b, 0) / inc.length };
  }).sort((a, b) => b.score - a.score);

  console.log('\n③ 抢手榜 (desirability = mean incoming attraction):');
  desir.forEach((d, r) => console.log(`   ${r + 1}. ${name(d.j)}  ${d.score.toFixed(2)}`));

  console.log('\n④ 单相思 (one-sided: attraction gap ≥ 0.30):');
  let anyCrush = false;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const gap = Math.abs(att[i][j] - att[j][i]);
    if (gap >= 0.3) { anyCrush = true; const pin = att[i][j] > att[j][i] ? i : j, cold = pin === i ? j : i;
      console.log(`   ${name(pin)} pines for ${name(cold)}  (${att[pin][cold].toFixed(2)} → ${att[cold][pin].toFixed(2)})`); }
  }
  if (!anyCrush) console.log('   (none)');

  console.log('\n⑤ 情敌 (rivals: both want the same ≥0.75 AND friction between them ≥0.50):');
  let anyRival = false;
  for (let z = 0; z < N; z++) {
    const fans = live.map((_, i) => i).filter((i) => i !== z && att[i][z] >= 0.75);
    for (let a = 0; a < fans.length; a++) for (let b = a + 1; b < fans.length; b++) {
      const fa = fans[a], fb = fans[b];
      const t = (ten[fa][fb] + ten[fb][fa]) / 2;
      if (t < 0.5) continue; // co-desire without friction = chill co-lovers, not rivals
      anyRival = true;
      console.log(`   ${name(fa)} ⚔ ${name(fb)} — both want ${name(z)}  (min want ${Math.min(att[fa][z], att[fb][z]).toFixed(2)}, friction ${t.toFixed(2)})`);
    }
  }
  if (!anyRival) console.log('   (none)');

  console.log('\n⑥ polycule (tight core — mutual attraction ≥ 0.80 both ways):');
  const seen = new Set<number>(); let anyPoly = false;
  for (let s = 0; s < N; s++) {
    if (seen.has(s)) continue;
    const comp: number[] = []; const stack = [s];
    while (stack.length) { const u = stack.pop()!; if (seen.has(u)) continue; seen.add(u); comp.push(u);
      for (let v = 0; v < N; v++) if (!seen.has(v) && att[u][v] >= 0.8 && att[v][u] >= 0.8) stack.push(v); }
    if (comp.length >= 2) { anyPoly = true; console.log(`   { ${comp.map(name).join(' · ')} }`); }
  }
  if (!anyPoly) console.log('   (no mutual clusters)');

  console.log('\n⑦ 火药桶 (highest-tension pairs):');
  const clashes: { i: number; j: number; t: number }[] = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) clashes.push({ i, j, t: (ten[i][j] + ten[j][i]) / 2 });
  clashes.sort((a, b) => b.t - a.t).slice(0, 3).forEach((c) => console.log(`   ${name(c.i)} ⚡ ${name(c.j)}  tension ${c.t.toFixed(2)}`));

  console.log(`\n=== done in ${((Date.now() - t0) / 1000).toFixed(0)}s ===`);
}

main().catch((e) => { console.error('spike3 crashed:', e); process.exit(1); });
