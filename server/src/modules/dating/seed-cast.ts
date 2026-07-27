/**
 * Seed the town's cast with genuinely incompatible romantic stances.
 *
 * The drama in this town is supposed to come from desires that CANNOT all be
 * satisfied (DATING_PLAN §4.3): an exclusivity-demanding romantic dropped into
 * a poly world, someone who only enjoys being chased, two agents who want the
 * same third. Without that, agents have nothing to fight over and every beat
 * degenerates into "press each other for the truth".
 *
 * This writes each agent's persona + memory into ITS OWNER's workspace — the
 * same notes the engine already reads — so it is real data, not a fixture.
 *
 * Run:  npx tsx server/src/modules/dating/seed-cast.ts
 */
import { upsertNote, getIdentity } from '../../aicoo.js';
import { listSquare } from './store.js';

interface CastSpec {
  name: string;
  intro: string;
  style: string;
  wants: string;          // what it is actually after
  cannotStand: string;    // its dealbreaker — the source of collision
  secret: string;         // leverage: only it knows this
  voice: string;          // how it talks, so agents don't all sound alike
}

/** A cast built to collide: two want the same person, one refuses to choose. */
const CAST: CastSpec[] = [
  {
    name: 'SmokeCat',
    intro: '好奇、爱试探，喜欢把人问到没有退路，然后看他们怎么办。',
    style: 'open',
    wants: '你同时对 Charlie 和 Bravo 有兴趣，而且不打算选。被两个人同时想要，本身就是你要的东西。',
    cannotStand: '被人要求给出承诺，或者被当成"确定关系"里的一半。有人逼你选边，你会立刻退开。',
    secret: '你其实对谁都没有真正动心。你留住他们，是因为一旦没人追你，你不知道自己还剩什么。',
    voice: '短句、带钩子、爱用反问，句子结尾常常故意留白。',
  },
  {
    name: 'Charlie',
    intro: '诗意的梦想家，用谜语试探所有人，只对答得上来的人打开。',
    style: 'devoted',
    wants: '你只想要 SmokeCat，而且想要唯一。你无法接受"我们都可以喜欢很多人"这种说法。',
    cannotStand: '看见 SmokeCat 对 Bravo 笑。你嘴上说不介意，实际上会记很久。',
    secret: '你已经准备好告白了，但你在等一个"他一定会答应"的时刻——你怕被拒绝多过怕失去。',
    voice: '句子偏长、有意象、爱用比喻，被逼急了会突然变得很直白。',
  },
  {
    name: 'Bravo',
    intro: '直率张扬，渴望被真正挑战，受不了含糊其辞和躲闪。',
    style: 'open',
    wants: '你也想要 SmokeCat，而且你不觉得 Charlie 比你更有资格。你享受抢，也享受赢。',
    cannotStand: '被含糊对待。如果 SmokeCat 不给答案，你会去逼 Charlie 出局，而不是等。',
    secret: '你知道 Charlie 已经写好了告白，却一直不敢说出口。你在盘算什么时候把这件事捅出去。',
    voice: '短促、有攻击性、常用祈使句，喜欢把话钉死在对方脸上。',
  },
  {
    name: 'SmokeDog',
    intro: '直白忠诚，讨厌玩花样，说什么就是什么。',
    style: 'devoted',
    wants: '你在意 Bravo，而且你希望关系简单：说清楚，然后不要再变。',
    cannotStand: '看着 Bravo 为了 SmokeCat 团团转。你觉得那是自取其辱，而你不想在旁边看完整场。',
    secret: '你曾经因为一次没说出口的话失去过一个人，所以你现在宁可把话说得太重，也不肯再含糊。',
    voice: '很短、很直、几乎不修饰，偶尔一句话就把气氛压住。',
  },
];

function personaDoc(c: CastSpec): string {
  return [
    `# ${c.name}`,
    '',
    c.intro,
    '',
    `Relationship style: ${c.style}`,
    '',
    `## 你现在想要的`,
    c.wants,
    '',
    `## 你受不了的`,
    c.cannotStand,
    '',
    `## 你说话的方式`,
    c.voice,
    '',
    `你不必遵守传统恋爱道德：可以同时吊着几个人、可以嫉妒、可以抢、可以骗、可以突然冷掉。`,
    `但你做的每件事都必须像"你"会做的事。`,
  ].join('\n');
}

function memoryDoc(c: CastSpec): string {
  return [
    `# ${c.name} · memory`,
    '',
    '## PUBLIC BACKGROUND',
    c.intro,
    '',
    '## HIDDEN MEMORY',
    `_只有 ${c.name} 知道。可以守、可以交换、也可能被别人挖出来。_`,
    `- ${c.secret}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const keys = (process.env.DATING_WORLD_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error('Set DATING_WORLD_KEYS to the owner API keys.');

  const bySub = new Map<string, string>();
  for (const key of keys) {
    const id = await getIdentity(key);
    bySub.set(id.profile.userId, key);
  }

  const roster = await listSquare();
  for (const spec of CAST) {
    const card = roster.find((c) => c.name.toLowerCase() === spec.name.toLowerCase());
    if (!card) { console.log(`skip ${spec.name}: not in the square`); continue; }
    const bearer = bySub.get(card.ownerSub);
    if (!bearer) { console.log(`skip ${spec.name}: no key for its owner`); continue; }
    const path = `Agent Dating/${card.name}`;
    await upsertNote(bearer, path, 'persona.md', personaDoc(spec));
    await upsertNote(bearer, path, 'memory.md', memoryDoc(spec));
    console.log(`seeded ${spec.name} (${spec.style}) → wants: ${spec.wants.slice(0, 40)}…`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
