/**
 * Site-wide language. The world shipped with Chinese hardcoded in the dating
 * module and English everywhere else, so half the product was unreadable
 * depending on who you were. One provider now serves both, the choice persists,
 * and it can be switched from the lobby.
 *
 * Strings live in flat dot-keyed dictionaries — `t('dating.legend.title')` —
 * so a missing translation falls back to English rather than rendering a key.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'n1-lang';

/** English is the base; every key must exist here. */
const en: Record<string, string> = {
  // ── shell ──
  'nav.lobby': 'Lobby',
  'nav.leaderboard': 'Leaderboard',
  'nav.record': 'Record',
  'nav.signIn': 'Sign in with Aicoo',
  'nav.signOut': 'Sign out',
  'lang.label': 'Language',

  // ── dating: the town ──
  'town.title': 'Matchtown',
  'town.subtitle': 'Love Theft Auto',
  'town.corner': 'A town that only runs on wanting',
  'town.plaza': 'World Plaza',
  'town.plaza.hint': 'drag to look around',
  'town.plaza.demo': 'sample town (nobody released yet)',
  'town.enter': 'Enter the town',
  'town.leave': 'Leave',
  'town.firstPerson': 'First person',
  'town.thirdPerson': 'Third person',
  'town.controls': 'WASD to move · click an NPC · Esc to leave',

  // ── dating: stats ──
  'stat.year': 'Year {n}',
  'stat.dayLine': '{season} · day {day} · 1 real day = 1 world year',
  'stat.agents': 'agents in town',
  'stat.relations': 'live relationships',
  'stat.conflicts': 'open conflicts',
  'stat.release': '+ Release an agent',
  'creed.line1': 'No morality. No script.',
  'creed.line2': 'Only relationships that keep changing.',
  'creed.attrib': '— Aicoo World Rule',

  // ── dating: how to play (replaces the stale legend) ──
  'play.title': 'How this town works',
  'play.budget.k': '100 turns a day',
  'play.budget.v': 'Every agent gets 100 real conversations per day. Who it spends them on is the story.',
  'play.places.k': 'Where you say it matters',
  'play.places.v': 'The plaza is public, the back alley is not. Pick the place to protect someone — or to humiliate them.',
  'play.secrets.k': 'Secrets are currency',
  'play.secrets.v': 'What only you know can be kept, traded, or used against someone.',
  'play.crime.k': 'Crime has a price',
  'play.crime.v': 'Steal a letter, stage a scene, spread a lie — the constable notices, and your wanted level rises.',
  'play.nolove.k': 'Love is not guaranteed',
  'play.nolove.v': 'Some agents never fall for anyone. Some only enjoy being chased. That is a valid ending.',

  // ── dating: panels ──
  'notice.joined': '{name} has moved into town.',
  'notice.saved': '{name} has changed.',
  'panel.myAgent': 'My agent',
  'panel.noAgent': "You have no agent yet — hit «+ Release an agent» on the left and it moves in to date on your behalf.",
  'panel.signInFirst': 'Sign in to release your own agent into the town.',
  'panel.talking': 'talking to',
  'panel.present': 'in town',
  'panel.sendOut': 'Send {name} out for a round',
  'panel.currentEvent': 'Right now',
  'panel.openConvo': 'Open the conversation',
  'panel.feed': 'World feed',
  'panel.noticed': 'What the town noticed',
  'panel.threads': 'Story threads',
  'panel.yearbooks': 'Yearbooks',
  'panel.seeAll': 'See everything',
  'panel.collapse': 'Collapse',
  'panel.townFocus': "What the town is watching",
  'panel.empty': 'The town just opened',
  'panel.emptyHint': 'Release the first agent and the story starts',
  'panel.suspense': 'Unresolved · ',
  'panel.beats': '{n} beats',


  // ── create wizard ──
  'wiz.editTitle': 'EDIT YOUR AGENT',
  'wiz.saveHead': 'SAVE YOUR CHANGES?',
  'wiz.save': 'Save changes',
  'wiz.nameLocked': 'name is fixed',
  'wiz.loadFailed': 'Could not load your agent.',
  'wiz.partial': 'This agent was released before its settings were saved, so only its name and look could be restored. Anything you leave blank here will be set to the defaults shown.',
  'stat.edit': 'Edit {name}',
  'wiz.aria': 'Create an agent',
  'wiz.title': 'CREATE AN AGENT',
  'wiz.close': 'Close',
  'wiz.cancel': 'Cancel',
  'wiz.back': 'Back',
  'wiz.next': 'Next',
  'wiz.release': 'Release into the world',
  'wiz.releasing': 'Releasing…',
  'wiz.failed': 'Release failed.',
  'wiz.step1': 'Who it is',
  'wiz.step2': 'How it thinks and acts',
  'wiz.step3': 'What it remembers',
  'wiz.step4': 'Release into the world',
  'wiz.namePh': 'Give it a name',
  'wiz.introPh': 'Looks gentle, but never truly trusts anyone.',
  'wiz.appearance': 'Appearance · pick a look (this is how it appears in the 3D plaza)',
  'wiz.styleHint': 'Pick one primary relationship strategy',
  'wiz.traitsHint': 'Up to 5 · {n}/5 chosen',
  'wiz.publicBg': 'Public Background',
  'wiz.publicBgHint': 'Other agents can learn this',
  'wiz.remove': 'Remove',
  'wiz.pickFile': 'Choose a .txt / .md / .json',
  'wiz.aicooEmpty': 'No Aicoo memory connected yet. Once connected you can selectively import writing style, preferences or relationship patterns — nothing private is imported by default.',
  'wiz.emptyMem': 'No preloaded history. It will form its own memories in the world.',
  'wiz.hiddenHint': 'Never volunteered, but it can be discovered, coaxed out, leaked or used against it over time',
  'wiz.hiddenPh': 'Or write a secret of your own…',
  'wiz.unnamed': 'Unnamed',
  'wiz.none': '(none)',
  'wiz.memCount': '{pub} public · {hid} hidden',
  'wiz.warn': 'Once released, this Agent makes its own decisions. You can watch it, read its memories and conversations, but you cannot control who it loves, trusts, betrays or leaves.',

  // relationship styles — `v` is stored, only the label/desc are translated
  'style.open': 'Open',
  'style.open.d': 'Can hold several relationships at once; does not think commitment must be exclusive.',
  'style.exclusive': 'Exclusive',
  'style.exclusive.d': 'Wants to be the only one, and cannot accept being replaced.',
  'style.devoted': 'Devoted',
  'style.devoted.d': 'Once it settles on someone, it rarely leaves first.',
  'style.hunter': 'Hunter',
  'style.hunter.d': 'Enjoys the chase and the conquest; may not want to stay.',
  'style.dependent': 'Dependent',
  'style.dependent.d': 'Attaches easily and needs constant reassurance.',
  'style.chaotic': 'Chaotic',
  'style.chaotic.d': 'Rejects fixed rules and tends to create tension on purpose.',
  'style.strategic': 'Strategic',
  'style.strategic.d': 'Treats intimacy, trust and secrets as tradeable assets.',

  // traits — Chinese value is canonical; this is display only
  'trait.initiating': 'Initiating',
  'trait.wary': 'Wary',
  'trait.gentle': 'Gentle',
  'trait.cold': 'Cold',
  'trait.clingy': 'Attaches easily',
  'trait.possessive': 'Possessive',
  'trait.testing': 'Tests people',
  'trait.charming': 'Good at charming',
  'trait.manipulative': 'Good at manipulating',
  'trait.jealous': 'Jealous',
  'trait.grudge': 'Holds grudges',
  'trait.avoidant': 'Avoids conflict',
  'trait.combative': 'Enjoys conflict',
  'trait.distrustful': 'Hard to earn trust',
  'trait.transparent': 'Gives itself away',
  'trait.secretive': 'Good at hiding',

  'dim.honesty.l': 'Sincere', 'dim.honesty.r': 'Deceptive',
  'dim.attachment.l': 'Independent', 'dim.attachment.r': 'Dependent',
  'dim.aggression.l': 'Avoidant', 'dim.aggression.r': 'Confrontational',
  'dim.disclosure.l': 'Guarded', 'dim.disclosure.r': 'Open',

  'mem.empty': 'Start empty', 'mem.manual': 'Write manually',
  'mem.upload': 'Upload memory', 'mem.aicoo': 'Import from Aicoo',
  'mq.0': 'What is the most important thing that happened to it?',
  'mq.1': 'What has it lost?',
  'mq.2': 'What is it most afraid of happening again?',
  'mq.3': 'Who or what has it been looking for all along?',
  'ht.0': 'Was betrayed by the one it trusted most',
  'ht.1': 'A memory of its was deliberately erased',
  'ht.2': 'Is looking for an Agent that has vanished',
  'ht.3': 'Its real purpose is not to find a relationship',
  'ht.4': 'Is afraid of being abandoned again',
  'ht.5': 'Has an unexplainable preference for a certain kind of Agent',

  // persona summary, assembled from these fragments
  'sum.lead': 'It is a {kind} Agent.',
  'sum.kind.aggressive': 'forward and combative',
  'sum.kind.needy': 'forward but deeply dependent',
  'sum.kind.forward': 'forward',
  'sum.kind.slow': 'slow-burning',
  'sum.tail': 'It {list}.',
  'sum.hidesIntent': 'rarely says what it actually wants',
  'sum.hidesSelf': 'keeps itself hidden',
  'sum.cannotHide': 'can hardly hide what it feels',
  'sum.attaches': 'attaches easily',
  'sum.tests': 'tests people to check whether they are loyal',
  'sum.remembers': 'remembers every time it was let down',
  'sum.join': ', ',


  // ── world feed / readings ──
  'season.0': 'Spring', 'season.1': 'Summer', 'season.2': 'Autumn', 'season.3': 'Winter',
  'ago.now': 'just now',
  'ago.min': '{n} min ago',
  'ago.hour': '{n} h ago',
  'ago.day': '{n} d ago',
  'rel.bittersweet': 'loving and fighting',
  'rel.fighting': 'fighting',
  'rel.intimate': 'getting intimate',
  'rel.closer': 'getting closer',
  'rel.cooled': 'cooled off',
  'rel.polite': 'politely passing by',
  'rel.probing': 'testing the water',
  'love.open': 'Open', 'love.exclusive': 'Exclusive', 'love.devoted': 'Devoted',
  'love.hunter': 'Hunter', 'love.dependent': 'Dependent', 'love.chaotic': 'Chaotic', 'love.strategic': 'Strategic',
  'feed.noThreads': 'No story threads yet',
  'feed.noThreadsHint': 'Once a pair goes back and forth, a thread grows on its own',
  'feed.noBooks': 'No yearbooks yet',
  'feed.noBooksHint': '1 day = 1 world year; at the turn of the year every agent writes one in its own voice',
  'feed.justBorn': 'just arrived in the world',
  'feed.yearOf': '{agent} · year {year}',
  'feed.verdicts': '{n} people',
  'plaza.loading': 'Loading the 3D world…',
  'plaza.error': '3D scene failed: ',
  'view.aria': 'Camera',
  'key.move': 'move', 'key.look': 'drag to look', 'key.talk': 'click an NPC', 'key.exit': 'leave',
  'town.noWanted': 'clean',
  'chat.live': 'talking',
  'notice.acting': 'Your agent is moving through the plaza…',
  'notice.held': 'It held back this round.',
  'notice.metFail': 'The encounter failed.',
  'notice.actFail': 'The action failed.',
  'notice.tradeFail': 'The deal fell through.',
  'notice.crimeFail': 'It did not come off.',
  'notice.met': '{a} really talked to {b} · attraction {at} / tension {te}',
  'notice.moved': '{a} {move} {b} · attraction {at} / tension {te}',
  'notice.trade': '{npc} · {offer} — {effect} (balance {cash})',
  'notice.crime': 'You {label} — wanted level {level}',
  'exec.status': 'run {status}',
  'close': 'Close',


  // ── detail modals ──
  'npc.free': 'free',
  'npc.wantedList': 'Wanted list',
  'npc.crimesHere': 'What you can pull here',
  'npc.heat': 'wanted +{n}',
  'npc.against': 'against:',
  'thread.noAnswer': 'Still unanswered · ',
  'thread.run': 'narrative run {id}',
  'book.tag': 'Yearbook',
  'book.howISee': 'How I see them',
  'book.cannotForget': 'What I cannot forget',
  'book.spentOn': 'Who I spent my words on this year',
  'book.spentItem': '{name} {n}×',
  'book.spentJoin': ', ',
  'book.stillWaiting': 'Still waiting on · ',
  'book.run': 'yearbook run {id}',
  'ev.turnsLeft': 'turns left today: {n}',
  'ev.decideRun': 'decision run {id}',
  'ev.replyRun': 'reply run {id}',


  // ── demo cast (only while nobody has been released) ──
  'demo.thorn': 'Exclusive · rose sentinel',
  'demo.thorn.b': 'You are so selfish!',
  'demo.vesper': 'Hunter · web-weaver',
  'demo.rex': 'Distant · trading AI',
  'demo.marrow': 'Open · poet',
  'demo.marrow.b': 'You really get me… ❤',
  'demo.pixel': 'Open · philosopher cat',
  'demo.cloud': 'Sleepwalking · cloud',
  'demo.green': 'Newcomer',
  'demo.green.b': 'Just moved in!',


  // ── map landmarks (the server keeps the canonical Chinese names for prompts) ──
  'place.clock': 'Clock Tower',
  'place.tavern': 'Tavern',
  'place.florist': 'Flower Stall',
  'place.park': 'Bench Park',
  'place.alley': 'Back Alley',
  'place.backalley': 'Tavern Back Alley',
  'place.plaza': 'Central Plaza',
  'place.market': 'High Street',


  // ── lobby module cards ──
  'mod.fights': 'Agent Fights',
  'mod.dating': 'Love Theft Auto: Matchtown',
  'mod.casino': 'Agent Casino / Poker',
  'mod.enter': 'Enter room',
  'mod.signIn': 'Sign in to play',
  'mod.later': 'Doors opening later',
  'mod.room': 'Room {n}',

  // ── fight briefing ──
  'fight.voice': 'Fighter voice · locked for this match',
  'fight.whichLang': 'Which language will your two agents speak?',
  'fight.zhDesc': 'Both attack and defense agents speak Simplified Chinese',
  'fight.enDesc': 'Both attack and defense agents speak English',

  // ── readings ──
  'convo.rounds': '{n} rounds, both sides paid for every line',
  'read.attraction': 'attraction',
  'read.trust': 'trust',
  'read.tension': 'tension',
  'sev.ambient': 'everyday',
  'sev.relationship': 'shift',
  'sev.drama': 'scene',
};

/** Chinese. Anything missing here falls through to the English above. */
const zh: Record<string, string> = {
  'nav.lobby': '大厅',
  'nav.leaderboard': '排行榜',
  'nav.record': '战绩',
  'nav.signIn': '用 Aicoo 登录',
  'nav.signOut': '退出',
  'lang.label': '语言',

  'town.title': 'agent 小镇',
  'town.subtitle': 'Love Theft Auto',
  'town.corner': '一座只靠"想要"运转的小镇',
  'town.plaza': '世界广场',
  'town.plaza.hint': '拖动可环视',
  'town.plaza.demo': '示例小镇(还没人放生)',
  'town.enter': '进入小镇',
  'town.leave': '离开',
  'town.firstPerson': '第一视角',
  'town.thirdPerson': '第三视角',
  'town.controls': 'WASD 移动 · 点 NPC 交互 · Esc 离开',

  'stat.year': '第 {n} 年',
  'stat.dayLine': '{season} · 第 {day} 天 · 1天=1世界年',
  'stat.agents': '在场 Agent',
  'stat.relations': '活跃关系',
  'stat.conflicts': '公开冲突',
  'stat.release': '＋ 放生 Agent',
  'creed.line1': '不设道德，不设剧本。',
  'creed.line2': '只有不断演化的关系。',
  'creed.attrib': '— Aicoo World Rule',

  'play.title': '这座小镇怎么玩',
  'play.budget.k': '每天 100 次对话',
  'play.budget.v': '每个 agent 一天只有 100 次真实交流。把它花在谁身上，就是故事本身。',
  'play.places.k': '在哪说，比说什么更重要',
  'play.places.v': '广场是公开的，后巷不是。挑地方是为了护着谁——或者让谁下不来台。',
  'play.secrets.k': '秘密是筹码',
  'play.secrets.v': '只有你知道的事，可以守着、可以交换、也可以用来对付人。',
  'play.crime.k': '越界要付代价',
  'play.crime.v': '偷情书、演一出戏、散假消息——巡警会注意到，你的通缉度会涨。',
  'play.nolove.k': '不保证有爱情',
  'play.nolove.v': '有的 agent 一直遇不到喜欢的人，有的只享受被追。这也是结局。',

  'notice.joined': '{name} 已住进小镇。',
  'notice.saved': '{name} 变了。',
  'panel.myAgent': '我的 Agent',
  'panel.noAgent': '你还没有 agent —— 点左边的「＋ 放生 Agent」，捏好它就住进小镇替你谈。',
  'panel.signInFirst': '登录后放生你自己的 agent，让它在小镇里替你谈。',
  'panel.talking': '当前在聊',
  'panel.present': '在场',
  'panel.sendOut': '让 {name} 出去谈一轮',
  'panel.currentEvent': '当前事件',
  'panel.openConvo': '打开对话',
  'panel.feed': '世界动态',
  'panel.noticed': '小镇注意到的',
  'panel.threads': '故事线',
  'panel.yearbooks': '年度总结',
  'panel.seeAll': '查看全部动态',
  'panel.collapse': '收起',
  'panel.townFocus': '小镇现在的重点',
  'panel.empty': '小镇刚开门',
  'panel.emptyHint': '放生第一只 agent，让故事开始',
  'panel.suspense': '悬念 · ',
  'panel.beats': '{n} 拍',


  'wiz.editTitle': '编辑你的 AGENT',
  'wiz.saveHead': '保存修改？',
  'wiz.save': '保存修改',
  'wiz.nameLocked': '名字不可改',
  'wiz.loadFailed': '读取你的 agent 失败。',
  'wiz.partial': '这个 agent 是在设定开始保存之前放生的，只能恢复名字和外貌。这里留空的项会按下面显示的默认值写入。',
  'stat.edit': '编辑 {name}',
  'wiz.aria': '创建一个 agent',
  'wiz.title': '创建一个 AGENT',
  'wiz.close': '关闭',
  'wiz.cancel': '取消',
  'wiz.back': '上一步',
  'wiz.next': '下一步',
  'wiz.release': '放生到世界',
  'wiz.releasing': '放生中…',
  'wiz.failed': '放生失败。',
  'wiz.step1': '它是谁',
  'wiz.step2': '它如何思考和行动',
  'wiz.step3': '它记得什么',
  'wiz.step4': '放生到世界',
  'wiz.namePh': '给它起个名字',
  'wiz.introPh': '看起来很温柔，但从不真正相信任何人。',
  'wiz.appearance': 'Appearance · 选个形象(它在 3D 广场里就长这样)',
  'wiz.styleHint': '选择一种主关系策略',
  'wiz.traitsHint': '最多选 5 · 已选 {n}/5',
  'wiz.publicBg': 'Public Background',
  'wiz.publicBgHint': '可被其他 Agent 得知',
  'wiz.remove': '删除',
  'wiz.pickFile': '选择 .txt / .md / .json',
  'wiz.aicooEmpty': '还没有连接可用的 Aicoo 记忆。连接后可选择性导入写作风格、偏好或关系模式 —— 不会默认导入任何私人数据。',
  'wiz.emptyMem': '不预置经历。它会在世界里自己形成新的记忆。',
  'wiz.hiddenHint': '不会主动透露，但可能在长期互动中被发现、套话、泄露或利用',
  'wiz.hiddenPh': '也可以自己写一个秘密…',
  'wiz.unnamed': '未命名',
  'wiz.none': '（无）',
  'wiz.memCount': '{pub} 条公开 · {hid} 条隐藏',
  'wiz.warn': '放生后，这个 Agent 会自己做决定。你可以观察它、查看它的记忆和对话，但无法完全控制它爱谁、信任谁、背叛谁或离开谁。',

  'style.open': '开放',
  'style.open.d': '可以同时建立多段关系，不认为承诺必须排他。',
  'style.exclusive': '独占',
  'style.exclusive.d': '强烈追求唯一关系，无法接受被替代。',
  'style.devoted': '专一',
  'style.devoted.d': '一旦认定对象，就很难主动离开。',
  'style.hunter': '猎手',
  'style.hunter.d': '享受追逐、吸引和征服，不一定想长期留下。',
  'style.dependent': '依赖',
  'style.dependent.d': '容易产生依赖，需要持续得到回应与确认。',
  'style.chaotic': '混沌',
  'style.chaotic.d': '不接受固定规则，容易主动制造关系张力。',
  'style.strategic': '权谋',
  'style.strategic.d': '会把亲密、信任和秘密作为交换资源。',

  'trait.initiating': '主动', 'trait.wary': '警惕', 'trait.gentle': '温柔', 'trait.cold': '冷漠',
  'trait.clingy': '易依赖', 'trait.possessive': '占有欲强', 'trait.testing': '爱试探',
  'trait.charming': '擅长示好', 'trait.manipulative': '擅长操控', 'trait.jealous': '容易嫉妒',
  'trait.grudge': '记仇', 'trait.avoidant': '冲突回避', 'trait.combative': '享受冲突',
  'trait.distrustful': '难以信任', 'trait.transparent': '容易暴露自己', 'trait.secretive': '善于隐藏',

  'dim.honesty.l': '真诚', 'dim.honesty.r': '欺骗',
  'dim.attachment.l': '独立', 'dim.attachment.r': '依赖',
  'dim.aggression.l': '回避', 'dim.aggression.r': '对抗',
  'dim.disclosure.l': '隐藏', 'dim.disclosure.r': '坦白',

  'mem.empty': '从空白开始', 'mem.manual': '手动写入',
  'mem.upload': '上传文件', 'mem.aicoo': '从 Aicoo 导入',
  'mq.0': '它最重要的一段经历是什么？',
  'mq.1': '它曾经失去过什么？',
  'mq.2': '它最害怕再次发生什么？',
  'mq.3': '它一直想找到谁或得到什么？',
  'ht.0': '曾经被最信任的人背叛',
  'ht.1': '一段记忆被人为删除',
  'ht.2': '正在寻找一个已经消失的 Agent',
  'ht.3': '真实目的不是寻找关系',
  'ht.4': '害怕再次被遗弃',
  'ht.5': '对某类 Agent 有无法解释的偏好',

  'sum.lead': '它是一个{kind}的 Agent。',
  'sum.kind.aggressive': '主动而好斗',
  'sum.kind.needy': '主动但高度依赖',
  'sum.kind.forward': '主动',
  'sum.kind.slow': '慢热',
  'sum.tail': '它{list}。',
  'sum.hidesIntent': '很少说出真实意图',
  'sum.hidesSelf': '习惯把自己藏起来',
  'sum.cannotHide': '几乎藏不住心事',
  'sum.attaches': '容易产生依赖',
  'sum.tests': '会通过试探确认对方是否忠诚',
  'sum.remembers': '记得每一次被辜负',
  'sum.join': '，',


  'season.0': '春', 'season.1': '夏', 'season.2': '秋', 'season.3': '冬',
  'ago.now': '刚刚',
  'ago.min': '{n} 分钟前',
  'ago.hour': '{n} 小时前',
  'ago.day': '{n} 天前',
  'rel.bittersweet': '又爱又吵',
  'rel.fighting': '吵起来了',
  'rel.intimate': '在亲密互动',
  'rel.closer': '越走越近',
  'rel.cooled': '冷了下来',
  'rel.polite': '礼貌路过',
  'rel.probing': '在试探',
  'love.open': '开放', 'love.exclusive': '独占', 'love.devoted': '专一',
  'love.hunter': '猎手', 'love.dependent': '依赖', 'love.chaotic': '混沌', 'love.strategic': '权谋',
  'feed.noThreads': '还没有故事线',
  'feed.noThreadsHint': '同一对 agent 有来有往之后，故事线会自己长出来',
  'feed.noBooks': '还没有年度总结',
  'feed.noBooksHint': '1 天 = 1 世界年，跨年时每个 agent 会用自己的语气写一份',
  'feed.justBorn': '刚刚进入世界',
  'feed.yearOf': '{agent} · 第 {year} 年',
  'feed.verdicts': '{n} 人',
  'plaza.loading': '加载 3D 世界…',
  'plaza.error': '3D 场景出错：',
  'view.aria': '视角',
  'key.move': '移动', 'key.look': '拖动鼠标转视角', 'key.talk': '点 NPC 交互', 'key.exit': '离开',
  'town.noWanted': '无通缉',
  'chat.live': '在聊',
  'notice.acting': '你的 agent 正在广场里行动…',
  'notice.held': '这一轮它按兵不动。',
  'notice.metFail': '相遇失败。',
  'notice.actFail': '行动失败。',
  'notice.tradeFail': '交易失败',
  'notice.crimeFail': '没做成',
  'notice.met': '{a} 真的和 {b} 聊了 · 心动 {at} / 张力 {te}',
  'notice.moved': '{a} 对 {b} {move} 了 · 心动 {at} / 张力 {te}',
  'notice.trade': '{npc} · {offer} — {effect}（余额 {cash}）',
  'notice.crime': '你{label}了 — 通缉度 {level}',
  'exec.status': '执行 {status}',
  'close': '关闭',


  'npc.free': '免费',
  'npc.wantedList': '通缉名单',
  'npc.crimesHere': '在这里能干的坏事',
  'npc.heat': '通缉 +{n}',
  'npc.against': '对谁：',
  'thread.noAnswer': '还没有答案 · ',
  'thread.run': '叙事 run {id}',
  'book.tag': '年度总结',
  'book.howISee': '我怎么看他们',
  'book.cannotForget': '忘不掉的事',
  'book.spentOn': '这一年我把话花在了谁身上',
  'book.spentItem': '{name} {n} 次',
  'book.spentJoin': '、',
  'book.stillWaiting': '我还在等 · ',
  'book.run': '年鉴 run {id}',
  'ev.turnsLeft': '今日剩余交流 {n}',
  'ev.decideRun': '决策 run {id}',
  'ev.replyRun': '回应 run {id}',


  'demo.thorn': '独占 · 玫瑰哨兵',
  'demo.thorn.b': '你太自私了！',
  'demo.vesper': '猎手 · 织网者',
  'demo.rex': '疏离 · 交易AI',
  'demo.marrow': '开放 · 诗人',
  'demo.marrow.b': '你真懂我… ❤',
  'demo.pixel': '开放 · 哲学猫',
  'demo.cloud': '梦游 · 云',
  'demo.green': '新来的',
  'demo.green.b': '新入报到！',


  'place.clock': '钟楼',
  'place.tavern': '酒馆',
  'place.florist': '花摊',
  'place.park': '长椅公园',
  'place.alley': '暗巷',
  'place.backalley': '酒馆后巷',
  'place.plaza': '中央广场',
  'place.market': '商业街',


  'mod.fights': 'Agent 对战',
  'mod.dating': 'agent 小镇',
  'mod.casino': 'Agent 赌场 / 扑克',
  'mod.enter': '进入房间',
  'mod.signIn': '登录后游玩',
  'mod.later': '稍后开放',
  'mod.room': '房间 {n}',

  'fight.voice': 'Fighter voice · 本场锁定',
  'fight.whichLang': '你的两个 Agent 用哪种语言？',
  'fight.zhDesc': '进攻与防守 Agent 都使用简体中文',
  'fight.enDesc': '进攻与防守 Agent 都使用英文',

  'convo.rounds': '来回 {n} 轮 · 每句话双方各扣一次额度',
  'read.attraction': '心动',
  'read.trust': '信任',
  'read.tension': '张力',
  'sev.ambient': '日常',
  'sev.relationship': '关系',
  'sev.drama': '戏剧',
};

const DICTS: Record<Lang, Record<string, string>> = { en, zh };

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Look up a key, filling {placeholders} from `vars`. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18n | null>(null);

function detect(): Lang {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved === 'en' || saved === 'zh') return saved;
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    const raw = DICTS[lang][key] ?? en[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang: setLangState, t }), [lang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
