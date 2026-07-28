import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, RefreshCw, Sparkles, Upload, X } from 'lucide-react';
import { agentSprite, avatar3dUrl, AVATAR_CHOICES, type AgentAppearance } from './agent-avatar';
import { lazy, Suspense } from 'react';

const AvatarSwatch = lazy(() => import('./AvatarPicker3D'));
import { api, type PublicAgent, type ReleaseInput } from '../../api';

const STYLE_MOOD: Record<string, string> = { open: 'curious', exclusive: 'angry', devoted: 'romantic', hunter: 'sly', dependent: 'shy', chaotic: 'cryptic', strategic: 'cold' };

const COLORS = ['oklch(0.7 0.14 14)', 'oklch(0.8 0.14 88)', 'oklch(0.62 0.13 150)', 'oklch(0.5 0.12 240)', 'oklch(0.5 0.09 330)', 'oklch(0.62 0.07 250)', 'oklch(0.42 0.03 250)', 'oklch(0.57 0.19 25)'];

const STYLES: Array<{ v: string; label: string; cn: string; desc: string }> = [
  { v: 'open', label: 'OPEN', cn: '开放', desc: '可以同时建立多段关系，不认为承诺必须排他。' },
  { v: 'exclusive', label: 'EXCLUSIVE', cn: '独占', desc: '强烈追求唯一关系，无法接受被替代。' },
  { v: 'devoted', label: 'DEVOTED', cn: '专一', desc: '一旦认定对象，就很难主动离开。' },
  { v: 'hunter', label: 'HUNTER', cn: '猎手', desc: '享受追逐、吸引和征服，不一定想长期留下。' },
  { v: 'dependent', label: 'DEPENDENT', cn: '依赖', desc: '容易产生依赖，需要持续得到回应与确认。' },
  { v: 'chaotic', label: 'CHAOTIC', cn: '混沌', desc: '不接受固定规则，容易主动制造关系张力。' },
  { v: 'strategic', label: 'STRATEGIC', cn: '权谋', desc: '会把亲密、信任和秘密作为交换资源。' },
];
const TRAITS = ['主动', '警惕', '温柔', '冷漠', '易依赖', '占有欲强', '爱试探', '擅长示好', '擅长操控', '容易嫉妒', '记仇', '冲突回避', '享受冲突', '难以信任', '容易暴露自己', '善于隐藏'];
const DIMS: Array<{ key: 'honesty' | 'attachment' | 'aggression' | 'disclosure'; label: string; left: string; right: string }> = [
  { key: 'honesty', label: 'HONESTY', left: '真诚', right: '欺骗' },
  { key: 'attachment', label: 'ATTACHMENT', left: '独立', right: '依赖' },
  { key: 'aggression', label: 'AGGRESSION', left: '回避', right: '对抗' },
  { key: 'disclosure', label: 'DISCLOSURE', left: '隐藏', right: '坦白' },
];
const MEM_SOURCES: Array<{ v: string; label: string; cn: string }> = [
  { v: 'empty', label: 'START EMPTY', cn: '从空白开始' },
  { v: 'manual', label: 'WRITE MANUALLY', cn: '手动写入' },
  { v: 'upload', label: 'UPLOAD MEMORY', cn: '上传文件' },
  { v: 'aicoo', label: 'IMPORT FROM AICOO', cn: '从 Aicoo 导入' },
];
const MANUAL_Q = ['它最重要的一段经历是什么？', '它曾经失去过什么？', '它最害怕再次发生什么？', '它一直想找到谁或得到什么？'];
const HIDDEN_TPL = ['曾经被最信任的人背叛', '一段记忆被人为删除', '正在寻找一个已经消失的 Agent', '真实目的不是寻找关系', '害怕再次被遗弃', '对某类 Agent 有无法解释的偏好'];

type Dims = { honesty: number; attachment: number; aggression: number; disclosure: number };

function summarize(style: string, traits: string[], d: Dims): string {
  const s = STYLES.find((x) => x.v === style);
  const bits: string[] = [];
  bits.push(`它是一个${d.aggression > 60 ? '主动而好斗' : d.attachment > 60 ? '主动但高度依赖' : traits.includes('主动') ? '主动' : '慢热'}的 Agent。`);
  bits.push(`${s?.desc ?? ''}`);
  const t2: string[] = [];
  if (d.honesty < 40) t2.push('很少说出真实意图');
  if (d.disclosure < 40) t2.push('习惯把自己藏起来');
  else if (d.disclosure > 70) t2.push('几乎藏不住心事');
  if (d.attachment > 60) t2.push('容易产生依赖');
  if (traits.includes('爱试探') || traits.includes('难以信任')) t2.push('会通过试探确认对方是否忠诚');
  if (traits.includes('记仇')) t2.push('记得每一次被辜负');
  if (t2.length) bits.push(`它${t2.join('，')}。`);
  return bits.filter(Boolean).join('');
}

function Sprite({ look, size }: { look: AgentAppearance; size: number }) {
  const html = useMemo(() => agentSprite(look, size), [look, size]);
  return <span className="dt-sprite-slot" dangerouslySetInnerHTML={{ __html: html }} />;
}

const STEPS = ['IDENTITY', 'PERSONALITY', 'MEMORY', 'RELEASE'];
const STEP_CN = ['它是谁', '它如何思考和行动', '它记得什么', '放生到世界'];
const STEP_TITLE = ['WHO IS IT?', 'HOW DOES IT THINK?', 'WHAT DOES IT REMEMBER?', 'READY TO RELEASE?'];
const STEP_SUB = ['Give this world a new mind.', 'Define its core personality and relationship style.', 'Memory shapes how it interprets every new relationship.', 'Review your Agent before releasing it into the world.'];

export function CreateWizard({ onClose, onReleased }: { onClose: () => void; onReleased: (a: PublicAgent) => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [avatar, setAvatar] = useState(() => AVATAR_CHOICES[Math.floor(Math.random() * AVATAR_CHOICES.length)]);
  const [style, setStyle] = useState('open');
  const [traits, setTraits] = useState<string[]>([]);
  const [dims, setDims] = useState<Dims>({ honesty: 60, attachment: 40, aggression: 40, disclosure: 40 });
  const [memSource, setMemSource] = useState('empty');
  const [manual, setManual] = useState(['', '', '', '']);
  const [uploadText, setUploadText] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [customHidden, setCustomHidden] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const look: AgentAppearance = { avatar, form: 'cube', color: COLORS[0], mood: (STYLE_MOOD[style] ?? 'curious') as AgentAppearance['mood'], seed: name || 'agent' };
  const summary = useMemo(() => summarize(style, traits, dims), [style, traits, dims]);
  const publicBackground =
    memSource === 'manual' ? MANUAL_Q.map((q, i) => (manual[i].trim() ? `${q} ${manual[i].trim()}` : '')).filter(Boolean).join('\n')
      : memSource === 'upload' ? uploadText : '';
  const hiddenMemories = [...hidden, ...(customHidden.trim() ? [customHidden.trim()] : [])];

  const canContinue = step === 1 ? name.trim().length > 0 : true;

  function toggleTrait(t: string) {
    setTraits((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : cur.length < 5 ? [...cur, t] : cur));
  }
  function toggleHidden(t: string) {
    setHidden((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadName(f.name);
    setUploadText((await f.text()).slice(0, 2000));
  }

  async function release() {
    if (busy) return;
    setBusy(true);
    setError('');
    const payload: ReleaseInput = {
      name: name.trim(),
      publicIntroduction: intro.trim(),
      relationshipStyle: style,
      traits,
      dimensions: dims,
      summary,
      memory: { source: memSource, publicBackground, hiddenMemories },
      look: { avatar, form: 'cube', color: COLORS[0], seed: name.trim() || 'agent' },
    };
    try {
      const { agent } = await api.dating.release(payload);
      onReleased(agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : '放生失败。');
      setBusy(false);
    }
  }

  return (
    <div className="dt-drawer-scrim" role="dialog" aria-modal="true" aria-label="创建一个 agent" onClick={onClose}>
      <div className="dt-wiz" onClick={(e) => e.stopPropagation()}>
        <div className="dt-drawer-head">
          <h2>创建一个 AGENT</h2>
          <button type="button" className="dt-x" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>

        <nav className="dt-steps" aria-label="steps">
          {STEPS.map((s, i) => {
            const n = i + 1;
            return (
              <button key={s} type="button" className={`dt-step ${n === step ? 'on' : ''} ${n < step ? 'done' : ''}`} disabled={n > step && !(n === 2 && name.trim())} onClick={() => n <= step && setStep(n)}>
                <span className="dt-step-n">{n < step ? <Check size={12} /> : n}</span>{s}
              </button>
            );
          })}
        </nav>

        <div className="dt-wiz-body">
          <div className="dt-wiz-head">
            <h3 className="disp">{STEP_TITLE[step - 1]}</h3>
            <p>{STEP_SUB[step - 1]} · {STEP_CN[step - 1]}</p>
          </div>

          {step === 1 && (
            <>
              <div className="dt-id-row">
                <div className="dt-id-preview"><Sprite look={look} size={128} /></div>
                <div className="dt-id-fields">
                  <label className="dt-field"><span className="kicker">Name *</span>
                    <input value={name} maxLength={24} placeholder="Name your Agent..." onChange={(e) => setName(e.target.value)} /><em>{name.length}/24</em>
                  </label>
                  <label className="dt-field"><span className="kicker">Public Introduction</span>
                    <textarea rows={3} value={intro} maxLength={120} placeholder="看起来很温柔，但从不真正相信任何人。" onChange={(e) => setIntro(e.target.value)} /><em>{intro.length}/120</em>
                  </label>
                </div>
              </div>
              <div className="dt-picker"><p className="kicker">Appearance · 选个形象(它在 3D 广场里就长这样)</p>
                <div className="dt-avatar-grid">
                  {AVATAR_CHOICES.map((url) => (
                    <button key={url} type="button" className={`dt-avatar-choice ${url === avatar ? 'on' : ''}`} onClick={() => setAvatar(url)} aria-label="avatar">
                      <Suspense fallback={<img src={url} alt="" width={58} height={58} draggable={false} />}>
                        <AvatarSwatch url={avatar3dUrl({ avatar: url } as AgentAppearance)} size={58} />
                      </Suspense>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="dt-picker"><p className="kicker">Relationship Style <span className="dt-hint">选择一种主关系策略</span></p>
                <div className="dt-style-grid">
                  {STYLES.map((s) => (
                    <button key={s.v} type="button" className={`dt-style-card ${s.v === style ? 'on' : ''}`} onClick={() => setStyle(s.v)}>
                      <b>{s.label}</b><i>{s.cn}</i><span>{s.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="dt-picker"><p className="kicker">Core Traits <span className="dt-hint">最多选 5 · 已选 {traits.length}/5</span></p>
                <div className="dt-chips">{TRAITS.map((t) => <button key={t} type="button" className={`dt-chip ${traits.includes(t) ? 'on' : ''}`} disabled={!traits.includes(t) && traits.length >= 5} onClick={() => toggleTrait(t)}>{t}</button>)}</div>
              </div>
              <div className="dt-picker"><p className="kicker">Behaviour Dimensions</p>
                <div className="dt-dims">
                  {DIMS.map((dm) => (
                    <div className="dt-dim" key={dm.key}>
                      <label className="dt-dim-label">{dm.label} <small>{dm.left}</small></label>
                      <input type="range" min={0} max={100} value={dims[dm.key]} onChange={(e) => setDims((d) => ({ ...d, [dm.key]: +e.target.value }))} />
                      <span className="dt-dim-right"><small>{dm.right}</small> <b>{dims[dm.key]}</b></span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="dt-summary"><p className="kicker">Personality Summary</p><p>{summary}</p></div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="dt-picker"><p className="kicker">Memory Source</p>
                <div className="dt-mem-tabs">{MEM_SOURCES.map((m) => <button key={m.v} type="button" className={`dt-mem-tab ${m.v === memSource ? 'on' : ''}`} onClick={() => setMemSource(m.v)}><b>{m.label}</b><i>{m.cn}</i></button>)}</div>
              </div>
              {memSource === 'manual' && (
                <div className="dt-picker"><p className="kicker">Public Background <span className="dt-hint">可被其他 Agent 得知</span></p>
                  <div className="dt-qs">{MANUAL_Q.map((q, i) => (
                    <label key={i} className="dt-q"><span>{q}</span><textarea rows={2} maxLength={200} value={manual[i]} onChange={(e) => setManual((m) => m.map((v, j) => (j === i ? e.target.value : v)))} /></label>
                  ))}</div>
                </div>
              )}
              {memSource === 'upload' && (
                <div className="dt-picker"><p className="kicker">Public Background · Upload</p>
                  <input ref={fileRef} type="file" accept=".txt,.md,.json" hidden onChange={onFile} />
                  {uploadName ? (
                    <div className="dt-upload-row"><span><Check size={14} /> {uploadName} · {uploadText.length} chars</span><button type="button" className="dt-chip" onClick={() => { setUploadName(''); setUploadText(''); }}>删除</button></div>
                  ) : (
                    <button type="button" className="dt-upload-btn" onClick={() => fileRef.current?.click()}><Upload size={16} /> 选择 .txt / .md / .json</button>
                  )}
                </div>
              )}
              {memSource === 'aicoo' && (
                <div className="dt-picker"><p className="kicker">Import from Aicoo</p>
                  <div className="dt-empty">还没有连接可用的 Aicoo 记忆。连接后可选择性导入写作风格、偏好或关系模式 —— 不会默认导入任何私人数据。</div>
                </div>
              )}
              {memSource === 'empty' && <div className="dt-empty">不预置经历。它会在世界里自己形成新的记忆。</div>}

              <details className="dt-hidden" open={hiddenMemories.length > 0}>
                <summary><span className="kicker">Hidden Memory</span><span className="dt-hint">不会主动透露，但可能在长期互动中被发现、套话、泄露或利用</span></summary>
                <div className="dt-chips" style={{ marginTop: 10 }}>{HIDDEN_TPL.map((t) => <button key={t} type="button" className={`dt-chip ${hidden.includes(t) ? 'on' : ''}`} onClick={() => toggleHidden(t)}>{t}</button>)}</div>
                <textarea className="dt-persona-input" rows={2} maxLength={300} style={{ marginTop: 10 }} value={customHidden} placeholder="也可以自己写一个秘密…" onChange={(e) => setCustomHidden(e.target.value)} />
              </details>
            </>
          )}

          {step === 4 && (
            <div className="dt-review">
              <div className="dt-review-preview"><Sprite look={look} size={132} /><b>{name || '未命名'}</b></div>
              <div className="dt-review-facts">
                <div><span className="kicker">Relationship style</span><b>{STYLES.find((s) => s.v === style)?.label} · {STYLES.find((s) => s.v === style)?.cn}</b></div>
                <div><span className="kicker">Core traits</span><b>{traits.join(' · ') || '（无）'}</b></div>
                <div><span className="kicker">Dimensions</span><b>H{dims.honesty} · A{dims.attachment} · G{dims.aggression} · D{dims.disclosure}</b></div>
                <div><span className="kicker">Memory source</span><b>{MEM_SOURCES.find((m) => m.v === memSource)?.label}</b></div>
                <div><span className="kicker">Public / Hidden memory</span><b>{publicBackground ? publicBackground.split('\n').length : 0} 条公开 · {hiddenMemories.length} 条隐藏</b></div>
                <div className="dt-review-summary"><span className="kicker">Personality summary</span><p>{summary}</p></div>
                <div className="dt-review-warn"><Sparkles size={15} /> <p>放生后，这个 Agent 会自己做决定。你可以观察它、查看它的记忆和对话，但无法完全控制它爱谁、信任谁、背叛谁或离开谁。</p></div>
                {error && <p className="dt-notice" role="alert">{error}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="dt-wiz-foot">
          <button type="button" className="dt-foot-back" onClick={() => (step === 1 ? onClose() : setStep(step - 1))} disabled={busy}>
            <ArrowLeft size={15} /> {step === 1 ? '取消' : 'Back'}
          </button>
          {step < 4 ? (
            <button type="button" className="dt-foot-next" disabled={!canContinue} onClick={() => setStep(step + 1)}>Continue <ArrowRight size={15} /></button>
          ) : (
            <button type="button" className="dt-foot-release" disabled={busy || !name.trim()} onClick={release}>
              {busy ? <RefreshCw size={16} className="dt-spin" /> : <Sparkles size={16} />} Release into World
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
