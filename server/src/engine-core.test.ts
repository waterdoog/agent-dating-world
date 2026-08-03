/**
 * The town's rules, tested.
 *
 * Every bug in the first group below reached production and was found by
 * running a real world round, waiting five minutes and reading Postgres
 * afterwards. Each is a pure function taking plain values. This is what it
 * costs to have had no test for them.
 *
 * No database, no network, no clock — if a test here needs any of those, the
 * function under test is in the wrong file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTS,
  ACT_OFFERS,
  asSeverity,
  castFor,
  CredentialBook,
  clampDelta,
  decayRel,
  desireOf,
  destinationOf,
  feelsLike,
  lastSaidBy,
  overTalked,
  pairBeats,
  parseMove,
  quietTooLong,
  resolveTarget,
  saturated,
  seedDimensions,
  situationFor,
  strip,
  tooSimilar,
  type Rel,
  type TickEvent,
} from './modules/dating/engine-core.js';
import type { AgentCard } from './modules/dating/store.js';

// ── fixtures ─────────────────────────────────────────────────────────

const rel = (over: Partial<Rel> = {}): Rel => ({
  handle: 'bravo', attraction: 0.5, trust: 0.3, tension: 0.2, note: '', ...over,
});

const beat = (over: Partial<TickEvent> = {}): TickEvent => ({
  actor: 'SmokeCat', target: 'Bravo', move: 'APPROACH',
  message: '一句话', reply: '', attraction: 0.5, trust: 0.3, tension: 0.2,
  note: '', severity: 'relationship', headline: '', summary: '',
  consequence: '', followup: '', ...over,
});

const card = (name: string): AgentCard => ({
  handle: name.toLowerCase(), name, ownerSub: `sub-${name}`, shareToken: 't',
  look: { form: 'cube', color: '#000', accessory: 'none', seed: name },
  loveStyle: 'open', oneline: '', persona: '',
} as AgentCard);

// ── the four that shipped ────────────────────────────────────────────

test('parseMove keeps a decision that names nobody out of the town', () => {
  // The model answered exactly this, repeatedly: a solitary act, aimed at
  // nobody, in neither vocabulary. It was discarded silently, so the agent
  // simply did nothing and the only trace was the scheduler guessing why.
  const solitary = parseMove('{"act":"GO_TO_WORK","move":"SELF","target":"","place":"florist"}');
  assert.equal(solitary, null, 'a beat with no target cannot happen — every beat is between two people');
});

test('seedDimensions reads `beats` as a write counter, not a conversation count', () => {
  // `beats` counts saveRel calls. A linear reading pinned curiosity at 0.00 and
  // attachment at its ceiling for EVERY relationship in the town at once —
  // which is no information at all, and it looked like working code.
  const old = seedDimensions(rel({ beats: 118, attraction: 0.5 }));
  assert.ok(old.curiosity! > 0, `an old pair still has some curiosity, got ${old.curiosity}`);
  assert.ok(old.attachment! < 1, `attachment must not saturate, got ${old.attachment}`);

  // And it has to keep early history apart from long history.
  const fresh = seedDimensions(rel({ beats: 1, attraction: 0.5 }));
  assert.ok(fresh.curiosity! > old.curiosity!, 'a new acquaintance is more interesting than an old one');
  assert.ok(fresh.attachment! < old.attachment!, 'attachment grows with real history');
});

test('tooSimilar works on a language without spaces', () => {
  // The original split on whitespace runs. Chinese does not use them, so a
  // whole clause came back as ONE token and two rewordings only matched when
  // they were character-identical — which is why the duplicate-promise
  // detector, the best drama trigger in the system, almost never fired.
  assert.equal(
    tooSimilar('酒馆后门九点，你站哪边', '九点酒馆后门，你到底偏谁'),
    true,
    'the same invitation reworded is the same invitation'
  );
  assert.equal(
    tooSimilar('我把花摊那束白花放你手边了', '你昨天没来，钟楼那阵风停了'),
    false,
    'two unrelated lines are not a repeat'
  );
});

test('destinationOf names the place a line points at', () => {
  // Defined, exported, and never once called — so every event carried a null
  // destination and the trajectory detector had no input at all.
  assert.equal(destinationOf('我在酒馆后门等你'), 'bar');
  assert.equal(destinationOf('花摊那束白花'), 'florist');
  assert.equal(destinationOf('今天天气不错'), undefined);
});

// ── parseMove, the rest ──────────────────────────────────────────────

test('parseMove coerces anything outside the vocabulary', () => {
  const m = parseMove('{"act":"INVENTED","move":"转向别人","target":"bravo","message":"嗨"}');
  assert.ok(m);
  assert.equal(m.act, 'SPEAK_ONLY', 'an unknown act degrades to plain speech');
  // `move` was never validated, so prose flowed into the feed and the thread
  // index as if it were an enum.
  assert.equal(m.move, 'APPROACH', 'an unknown move degrades to the neutral one');
});

test('parseMove allows silence, but only when something real happened', () => {
  const acted = parseMove('{"act":"LINGER","target":"bravo","message":""}');
  assert.ok(acted, 'acting without speaking is a legal, often stronger, beat');
  assert.equal(acted.message, '');

  const nothing = parseMove('{"act":"CHITCHAT","target":"bravo","message":""}');
  assert.equal(nothing, null, 'no words AND no real act is not a beat');
});

test('parseMove bounds what one beat may move', () => {
  const m = parseMove('{"act":"GIFT","target":"bravo","message":"给你","dAttraction":9,"dTension":-9}');
  assert.ok(m);
  assert.equal(m.dAttraction, 0.3, 'a single beat may only nudge a reading');
  assert.equal(m.dTension, -0.3);
});

test('parseMove finds the decision inside whatever the model wrapped it in', () => {
  const m = parseMove('好的，我这一拍这样走：\n{"act":"GIFT","target":"bravo","message":"给你"}\n希望有用');
  assert.ok(m);
  assert.equal(m.target, 'bravo');
  assert.equal(parseMove('完全没有 JSON'), null);
  assert.equal(parseMove('{"act": broken'), null, 'malformed JSON is not a crash');
});

test('parseMove drops a place the town does not have', () => {
  assert.equal(parseMove('{"act":"LINGER","target":"b","place":"月球"}')!.place, '');
  assert.equal(parseMove('{"act":"LINGER","target":"b","place":"bar"}')!.place, 'bar');
});

// ── decay ────────────────────────────────────────────────────────────

test('decayRel pulls a reading toward rest and never past it', () => {
  const now = 1_700_000_000_000;
  const hot = decayRel(rel({ tension: 0.9, at: now - 10 * 3_600_000 }), now);
  assert.ok(hot.tension < 0.9, 'friction fades once you stop seeing someone');
  assert.ok(hot.tension >= 0.15, 'but never below its resting value');

  const cold = decayRel(rel({ attraction: 0.05, at: now - 100 * 3_600_000 }), now);
  assert.ok(cold.attraction <= 0.25 && cold.attraction >= 0.05, 'and rises back toward rest from below');
});

test('decayRel leaves a live conversation alone', () => {
  const now = 1_700_000_000_000;
  const mid = rel({ tension: 0.9, at: now - 5 * 60_000 });
  assert.deepEqual(decayRel(mid, now), mid, 'five minutes in is still the same conversation');
  const never = rel({ tension: 0.9 });
  assert.deepEqual(decayRel(never, now), never, 'a reading with no timestamp is not decayed');
});

test('trust decays far slower than friction', () => {
  const now = 1_700_000_000_000;
  const day = decayRel(rel({ trust: 0.9, tension: 0.9, at: now - 24 * 3_600_000 }), now);
  const trustLost = 0.9 - day.trust;
  const tensionLost = 0.9 - day.tension;
  assert.ok(tensionLost > trustLost * 5, 'trust is broken by events, not forgotten by the calendar');
});

// ── the governors ────────────────────────────────────────────────────

test('pairBeats sees a pair from either side', () => {
  const feed = [
    beat({ actor: 'SmokeCat', target: 'Bravo' }),
    beat({ actor: 'Bravo', target: 'SmokeCat' }),
    beat({ actor: 'SmokeCat', target: 'Charlie' }),
  ];
  assert.equal(pairBeats('SmokeCat', 'Bravo', feed).length, 2, 'who spoke first does not change who the pair is');
  assert.equal(pairBeats('smokecat', 'bravo', feed).length, 2, 'and case does not either');
});

test('saturated only fires on a pair actually stuck at the ceiling', () => {
  const loud = Array.from({ length: 3 }, () => beat({ tension: 0.9 }));
  assert.equal(saturated(rel({ tension: 0.9 }), 'SmokeCat', 'Bravo', loud), true);
  // One calm beat in the window means the pair is not looping.
  const mixed = [beat({ tension: 0.9 }), beat({ tension: 0.4 }), beat({ tension: 0.9 })];
  assert.equal(saturated(rel({ tension: 0.9 }), 'SmokeCat', 'Bravo', mixed), false);
  assert.equal(saturated(undefined, 'SmokeCat', 'Bravo', loud), false, 'no relationship, nothing to saturate');
});

test('overTalked counts spoken beats only', () => {
  const spoken = Array.from({ length: 3 }, () => beat({ message: '说了话' }));
  assert.equal(overTalked('SmokeCat', 'Bravo', spoken), true);
  const silent = Array.from({ length: 5 }, () => beat({ silent: true, message: '' }));
  assert.equal(overTalked('SmokeCat', 'Bravo', silent), false, 'silence is not talking');
});

test('quietTooLong lets silence run out', () => {
  // Both agents settled into WITHDRAW forever — 25 wordless beats in a row,
  // none of them forced. Capping speech without capping silence did that.
  const quiet = [beat({ silent: true }), beat({ silent: true })];
  assert.equal(quietTooLong('SmokeCat', 'Bravo', quiet), true);
  assert.equal(quietTooLong('SmokeCat', 'Bravo', [beat({ silent: true })]), false, 'one quiet beat is just a quiet beat');
  assert.equal(quietTooLong('SmokeCat', 'Bravo', [beat({ silent: true }), beat({})]), false);
});

// ── how it reads to the agent ────────────────────────────────────────

test('feelsLike names the combination, not the numbers', () => {
  // Agents were handed "心动 0.72, 信任 0.08, 张力 0.99" and started talking
  // around the bookkeeping. The point of five dimensions is what sits together.
  assert.match(feelsLike(rel({ attraction: 0.7, trust: 0.2 })), /患得患失/);
  assert.match(feelsLike(rel({ attraction: 0.2, trust: 0.7 })), /更像朋友/);
  assert.match(feelsLike(rel({ attraction: 0.4, trust: 0.4, possessiveness: 0.6 })), /和别人在一起/);
  assert.doesNotMatch(feelsLike(rel()), /0\.\d/, 'no decimals ever reach the character');
});

test('feelsLike stays silent about a guess it has not made', () => {
  assert.doesNotMatch(feelsLike(rel()), /你觉得他|你猜他/);
  assert.match(feelsLike(rel({ guessAttraction: 0.8 })), /也想要你/);
});

test('desireOf leaves room for a life that is not about people', () => {
  // Every want used to point at another agent, so the only available behaviour
  // was pursuit.
  assert.match(desireOf([]).desire, /过你自己的日子/);
  assert.match(desireOf([rel({ attraction: 0.1 })]).desire, /你自己的事情/);
  assert.match(desireOf([rel({ handle: 'bravo', attraction: 0.9 })]).desire, /bravo/);
});

test('lastSaidBy shows an agent its own recent lines', () => {
  const feed = [
    beat({ actor: 'SmokeCat', target: 'Bravo', message: '第一句' }),
    beat({ actor: 'SmokeCat', target: 'Bravo', message: '第二句' }),
    beat({ actor: 'SmokeCat', target: 'Bravo', message: '第三句' }),
    beat({ actor: 'Bravo', target: 'SmokeCat', message: '别人说的' }),
  ];
  const out = lastSaidBy('SmokeCat', feed);
  assert.match(out, /第一句/);
  assert.match(out, /第二句/);
  assert.doesNotMatch(out, /第三句/, 'at most two lines per person, or the prompt bloats');
  assert.doesNotMatch(out, /别人说的/, 'only its own lines');
  assert.equal(lastSaidBy('Nobody', feed), '');
});

// ── situational awareness, now that it can be tested ─────────────────

const NO_FACTS = { knows: [], wanted: 0, duplicates: [] };

test('situationFor forces a change of partner after two beats on one person', () => {
  const feed = [
    beat({ actor: 'SmokeCat', target: 'Bravo', headline: '一' }),
    beat({ actor: 'SmokeCat', target: 'Bravo', headline: '二' }),
  ];
  assert.match(situationFor('SmokeCat', [], feed, NO_FACTS), /必须换人/);
});

test('situationFor calls out endless waiting but not a single wait', () => {
  const twice = [beat({ actor: 'SmokeCat', move: 'WAIT' }), beat({ actor: 'SmokeCat', move: 'WAIT' })];
  assert.match(situationFor('SmokeCat', [], twice, NO_FACTS), /连着等了两拍/);
  // WAIT spends no turn and is a documented choice; only endless waiting is the
  // problem, so one must pass clean.
  const once = [beat({ actor: 'SmokeCat', move: 'WAIT' }), beat({ actor: 'SmokeCat', move: 'APPROACH' })];
  assert.doesNotMatch(situationFor('SmokeCat', [], once, NO_FACTS), /连着等了两拍/);
});

test('situationFor tells an agent it heard a line someone else also heard', () => {
  const facts = { ...NO_FACTS, duplicates: [{ speaker: 'SmokeDog', a: 'SmokeCat', b: 'Charlie' }] };
  assert.match(situationFor('SmokeCat', [], [], facts), /SmokeDog 对 Charlie 说过/);
  // …and does not leak it to someone the promise had nothing to do with.
  assert.doesNotMatch(situationFor('Kehan', [], [], facts), /说过几乎和对你一样的话/);
});

test('situationFor reports heat only when there is heat', () => {
  assert.match(situationFor('SmokeCat', [], [], { ...NO_FACTS, wanted: 3 }), /通缉度是 3\/5/);
  assert.doesNotMatch(situationFor('SmokeCat', [], [], NO_FACTS), /通缉度/);
});

// ── targets and cast ─────────────────────────────────────────────────

test('resolveTarget accepts a handle or a name, and refuses the actor itself', () => {
  const roster = [card('SmokeCat'), card('Bravo')];
  assert.equal(resolveTarget('bravo', 'SmokeCat', roster)?.name, 'Bravo', 'by handle');
  assert.equal(resolveTarget('Bravo', 'SmokeCat', roster)?.name, 'Bravo', 'by display name');
  assert.equal(resolveTarget('SmokeCat', 'SmokeCat', roster), null, 'nobody talks to themselves');
  assert.equal(resolveTarget('Ghost', 'SmokeCat', roster), null, 'a target must exist');
  assert.equal(resolveTarget('', 'SmokeCat', roster), null);
});

test('castFor excludes the actor', () => {
  const names = castFor('SmokeCat', [card('SmokeCat'), card('Bravo')]).map((c) => c.name);
  assert.deepEqual(names, ['Bravo']);
});

// ── credentials ──────────────────────────────────────────────────────

test('CredentialBook matches an agent by either identifier', () => {
  // An agent released through the interface carries a pairwise OAuth sub that
  // no API key can resolve, so it is reachable by account name and not by sub.
  // Four call sites had drifted into three different rules about this: under
  // the scheduler's it could take a turn, under the reply path's it could never
  // answer one. Same agent, same town, two verdicts.
  const book = new CredentialBook(new Map([['sub-1', 'key-a'], ['eason', 'key-b']]));
  assert.equal(book.of({ ownerSub: 'sub-1' }), 'key-a', 'by pairwise sub');
  assert.equal(book.of({ ownerSub: 'unknown', ownerName: 'eason' }), 'key-b', 'by account name');
  assert.equal(book.of({ ownerSub: 'sub-1', ownerName: 'eason' }), 'key-a', 'sub wins when both resolve');
});

test('CredentialBook returns null, not undefined, for an agent it cannot act as', () => {
  // The type is the point. `undefined` invites `?? someoneElsesBearer`, and
  // that line put one agent's dialogue into another owner's private chat —
  // Aicoo's guest endpoint runs the CALLER's agent, so the conversation belongs
  // to whoever lent the token.
  const book = new CredentialBook(new Map([['sub-1', 'key-a']]));
  assert.equal(book.of({ ownerSub: 'nobody' }), null);
  assert.equal(book.of({ ownerSub: 'nobody', ownerName: 'also-nobody' }), null);
  assert.equal(book.canAct({ ownerSub: 'sub-1' }), true);
  assert.equal(book.canAct({ ownerSub: 'nobody' }), false);
});

test('CredentialBook offers no way to ask for someone else', () => {
  // A regression guard on the shape itself: any method that took two agents, or
  // returned the whole map, would let the borrowing bug back in.
  const book = new CredentialBook(new Map());
  const surface = Object.getOwnPropertyNames(CredentialBook.prototype).filter((k) => k !== 'constructor');
  assert.deepEqual(surface.sort(), ['canAct', 'of', 'size'], 'the whole surface, deliberately');
  assert.equal(book.size, 0);
});

// ── small pieces that everything else leans on ───────────────────────

test('every costly act the vocabulary offers has a price', () => {
  // An act the model may choose but the town cannot execute is a turn thrown
  // away, and the two lists drifting apart is how that happens.
  for (const act of Object.keys(ACT_OFFERS)) {
    assert.ok(ACTS.has(act), `${act} has a price but is not in the vocabulary`);
    assert.ok(ACT_OFFERS[act].cost > 0, `${act} is meant to be costly`);
  }
});

test('clampDelta and asSeverity survive whatever the model sends', () => {
  assert.equal(clampDelta('nonsense'), 0);
  assert.equal(clampDelta(undefined), 0);
  assert.equal(clampDelta(0.15), 0.15);
  assert.equal(asSeverity('drama'), 'drama');
  assert.equal(asSeverity('catastrophic'), 'relationship', 'an invented severity falls back, it does not throw');
});

test('strip removes the assistant scaffolding around a reply', () => {
  assert.equal(strip('我在酒馆等你\n<suggestions>要不要…</suggestions>'), '我在酒馆等你');
  assert.equal(strip(null), '');
});
