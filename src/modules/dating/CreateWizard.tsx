import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, RefreshCw, Sparkles, Upload, X } from 'lucide-react';
import { agentSprite, avatar3dUrl, AVATAR_CHOICES, type AgentAppearance } from './agent-avatar';
import { lazy, Suspense } from 'react';

const AvatarSwatch = lazy(() => import('./AvatarPicker3D'));
import { api, type PublicAgent, type ReleaseInput } from '../../api';
import { useI18n } from '../../i18n';

const STYLE_MOOD: Record<string, string> = { open: 'curious', exclusive: 'angry', devoted: 'romantic', hunter: 'sly', dependent: 'shy', chaotic: 'cryptic', strategic: 'cold' };

const COLORS = ['oklch(0.7 0.14 14)', 'oklch(0.8 0.14 88)', 'oklch(0.62 0.13 150)', 'oklch(0.5 0.12 240)', 'oklch(0.5 0.09 330)', 'oklch(0.62 0.07 250)', 'oklch(0.42 0.03 250)', 'oklch(0.57 0.19 25)'];

const STYLES: Array<{ v: string; label: string }> = [
  { v: 'open', label: 'OPEN' },
  { v: 'exclusive', label: 'EXCLUSIVE' },
  { v: 'devoted', label: 'DEVOTED' },
  { v: 'hunter', label: 'HUNTER' },
  { v: 'dependent', label: 'DEPENDENT' },
  { v: 'chaotic', label: 'CHAOTIC' },
  { v: 'strategic', label: 'STRATEGIC' },
];
/* The Chinese string is the CANONICAL trait value: it is stored on the agent and
   goes into the engine prompt, so it must not shift with the UI language. `k`
   only selects the label to show. */
const TRAITS: Array<{ v: string; k: string }> = [
  { v: '主动', k: 'initiating' }, { v: '警惕', k: 'wary' }, { v: '温柔', k: 'gentle' },
  { v: '冷漠', k: 'cold' }, { v: '易依赖', k: 'clingy' }, { v: '占有欲强', k: 'possessive' },
  { v: '爱试探', k: 'testing' }, { v: '擅长示好', k: 'charming' }, { v: '擅长操控', k: 'manipulative' },
  { v: '容易嫉妒', k: 'jealous' }, { v: '记仇', k: 'grudge' }, { v: '冲突回避', k: 'avoidant' },
  { v: '享受冲突', k: 'combative' }, { v: '难以信任', k: 'distrustful' },
  { v: '容易暴露自己', k: 'transparent' }, { v: '善于隐藏', k: 'secretive' },
];
const DIMS: Array<{ key: 'honesty' | 'attachment' | 'aggression' | 'disclosure'; label: string }> = [
  { key: 'honesty', label: 'HONESTY' },
  { key: 'attachment', label: 'ATTACHMENT' },
  { key: 'aggression', label: 'AGGRESSION' },
  { key: 'disclosure', label: 'DISCLOSURE' },
];
const MEM_SOURCES: Array<{ v: string; label: string }> = [
  { v: 'empty', label: 'START EMPTY' },
  { v: 'manual', label: 'WRITE MANUALLY' },
  { v: 'upload', label: 'UPLOAD MEMORY' },
  { v: 'aicoo', label: 'IMPORT FROM AICOO' },
];
const MANUAL_Q = ['mq.0', 'mq.1', 'mq.2', 'mq.3'];
const HIDDEN_TPL = ['ht.0', 'ht.1', 'ht.2', 'ht.3', 'ht.4', 'ht.5'];

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Persona blurb, assembled in whichever language the player is reading. */
function summarize(style: string, traits: string[], d: Dims, t: T): string {
  const kind = d.aggression > 60 ? 'aggressive' : d.attachment > 60 ? 'needy' : traits.includes('主动') ? 'forward' : 'slow';
  const bits: string[] = [t('sum.lead', { kind: t(`sum.kind.${kind}`) }), t(`style.${style}.d`)];
  const t2: string[] = [];
  if (d.honesty < 40) t2.push(t('sum.hidesIntent'));
  if (d.disclosure < 40) t2.push(t('sum.hidesSelf'));
  else if (d.disclosure > 70) t2.push(t('sum.cannotHide'));
  if (d.attachment > 60) t2.push(t('sum.attaches'));
  if (traits.includes('爱试探') || traits.includes('难以信任')) t2.push(t('sum.tests'));
  if (traits.includes('记仇')) t2.push(t('sum.remembers'));
  if (t2.length) bits.push(t('sum.tail', { list: t2.join(t('sum.join')) }));
  return bits.filter(Boolean).join('');
}

type Dims = { honesty: number; attachment: number; aggression: number; disclosure: number };

function Sprite({ look, size }: { look: AgentAppearance; size: number }) {
  const html = useMemo(() => agentSprite(look, size), [look, size]);
  return <span className="dt-sprite-slot" dangerouslySetInnerHTML={{ __html: html }} />;
}

const STEPS = ['IDENTITY', 'PERSONALITY', 'MEMORY', 'RELEASE'];
const STEP_CN = ['wiz.step1', 'wiz.step2', 'wiz.step3', 'wiz.step4'];
const STEP_TITLE = ['WHO IS IT?', 'HOW DOES IT THINK?', 'WHAT DOES IT REMEMBER?', 'READY TO RELEASE?'];
const STEP_SUB = ['Give this world a new mind.', 'Define its core personality and relationship style.', 'Memory shapes how it interprets every new relationship.', 'Review your Agent before releasing it into the world.'];

/**
 * Creates an agent, and — when `editing` is set — edits the one already released.
 * Editing reuses the same four steps so a player changes personality and looks in
 * the place they set them. The NAME is fixed while editing: memory notes and the
 * agent's scoped share both live under it, so renaming would strand its history.
 */
export function CreateWizard({ onClose, onReleased, editing }: {
  onClose: () => void;
  onReleased: (a: PublicAgent) => void;
  editing?: boolean;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(Boolean(editing));
  const [partial, setPartial] = useState(false);
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

  // Editing prefills from the structured spec saved at release time, so nothing
  // the player set is silently blanked by reopening the wizard.
  useEffect(() => {
    if (!editing) return;
    let alive = true;
    api.dating.mineSpec()
      .then(({ name: agentName, spec, partial: incomplete }) => {
        if (!alive) return;
        setName(agentName);
        setPartial(incomplete);
        if (spec) {
          setIntro(spec.publicIntroduction ?? '');
          setStyle(spec.relationshipStyle ?? 'open');
          setTraits(spec.traits ?? []);
          setDims(spec.dimensions ?? { honesty: 60, attachment: 40, aggression: 40, disclosure: 40 });
          setMemSource(spec.memory?.source ?? 'empty');
          setHidden(spec.memory?.hiddenMemories ?? []);
          if (spec.memory?.source === 'upload') setUploadText(spec.memory.publicBackground ?? '');
          if (spec.look?.avatar) setAvatar(spec.look.avatar);
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('wiz.loadFailed')))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [editing, t]);

  const look: AgentAppearance = { avatar, form: 'cube', color: COLORS[0], mood: (STYLE_MOOD[style] ?? 'curious') as AgentAppearance['mood'], seed: name || 'agent' };
  const summary = useMemo(() => summarize(style, traits, dims, t), [style, traits, dims, t]);
  const publicBackground =
    memSource === 'manual' ? MANUAL_Q.map((q, i) => (manual[i].trim() ? `${t(q)} ${manual[i].trim()}` : '')).filter(Boolean).join('\n')
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
      const { agent } = editing
        ? await api.dating.updateMine(payload)
        : await api.dating.release(payload);
      onReleased(agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('wiz.failed'));
      setBusy(false);
    }
  }

  return (
    <div className="dt-drawer-scrim" role="dialog" aria-modal="true" aria-label={t('wiz.aria')} onClick={onClose}>
      <div className="dt-wiz" onClick={(e) => e.stopPropagation()}>
        <div className="dt-drawer-head">
          <h2>{t(editing ? 'wiz.editTitle' : 'wiz.title')}</h2>
          <button type="button" className="dt-x" aria-label={t('wiz.close')} onClick={onClose}><X size={18} /></button>
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
          {partial && <div className="dt-wiz-warn">{t('wiz.partial')}</div>}
          <div className="dt-wiz-head">
            <h3 className="disp">{editing && step === 4 ? t('wiz.saveHead') : STEP_TITLE[step - 1]}</h3>
            <p>{STEP_SUB[step - 1]} · {t(STEP_CN[step - 1])}</p>
          </div>

          {step === 1 && (
            <>
              <div className="dt-id-row">
                <div className="dt-id-preview">
                  <Suspense fallback={<Sprite look={look} size={128} />}>
                    <AvatarSwatch url={avatar3dUrl(look)} size={128} />
                  </Suspense>
                </div>
                <div className="dt-id-fields">
                  <label className="dt-field"><span className="kicker">Name *</span>
                    <input value={name} maxLength={24} placeholder={t('wiz.namePh')} readOnly={editing}
                      title={editing ? t('wiz.nameLocked') : undefined}
                      onChange={(e) => setName(e.target.value)} />
                    <em>{editing ? t('wiz.nameLocked') : `${name.length}/24`}</em>
                  </label>
                  <label className="dt-field"><span className="kicker">Public Introduction</span>
                    <textarea rows={3} value={intro} maxLength={120} placeholder={t('wiz.introPh')} onChange={(e) => setIntro(e.target.value)} /><em>{intro.length}/120</em>
                  </label>
                </div>
              </div>
              <div className="dt-picker"><p className="kicker">{t('wiz.appearance')}</p>
                <div className="dt-avatar-grid">
                  {AVATAR_CHOICES.map((url) => (
                    <button key={url} type="button" className={`dt-avatar-choice ${url === avatar ? 'on' : ''}`} onClick={() => setAvatar(url)} aria-label="avatar">
                      {/* One WebGL context per swatch blew past the browser's
                          limit (~16) and left most of the grid blank, so the
                          grid is 2D and only the current pick renders in 3D. */}
                      <img src={url} alt="" width={54} height={54} draggable={false} />
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="dt-picker"><p className="kicker">Relationship Style <span className="dt-hint">{t('wiz.styleHint')}</span></p>
                <div className="dt-style-grid">
                  {STYLES.map((s) => (
                    <button key={s.v} type="button" className={`dt-style-card ${s.v === style ? 'on' : ''}`} onClick={() => setStyle(s.v)}>
                      <b>{s.label}</b><i>{t(`style.${s.v}`)}</i><span>{t(`style.${s.v}.d`)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="dt-picker"><p className="kicker">Core Traits <span className="dt-hint">{t('wiz.traitsHint', { n: traits.length })}</span></p>
                <div className="dt-chips">{TRAITS.map((tr) => <button key={tr.v} type="button" className={`dt-chip ${traits.includes(tr.v) ? 'on' : ''}`} disabled={!traits.includes(tr.v) && traits.length >= 5} onClick={() => toggleTrait(tr.v)}>{t(`trait.${tr.k}`)}</button>)}</div>
              </div>
              <div className="dt-picker"><p className="kicker">Behaviour Dimensions</p>
                <div className="dt-dims">
                  {DIMS.map((dm) => (
                    <div className="dt-dim" key={dm.key}>
                      <label className="dt-dim-label">{dm.label} <small>{t(`dim.${dm.key}.l`)}</small></label>
                      <input type="range" min={0} max={100} value={dims[dm.key]} onChange={(e) => setDims((d) => ({ ...d, [dm.key]: +e.target.value }))} />
                      <span className="dt-dim-right"><small>{t(`dim.${dm.key}.r`)}</small> <b>{dims[dm.key]}</b></span>
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
                <div className="dt-mem-tabs">{MEM_SOURCES.map((m) => <button key={m.v} type="button" className={`dt-mem-tab ${m.v === memSource ? 'on' : ''}`} onClick={() => setMemSource(m.v)}><b>{m.label}</b><i>{t(`mem.${m.v}`)}</i></button>)}</div>
              </div>
              {memSource === 'manual' && (
                <div className="dt-picker"><p className="kicker">Public Background <span className="dt-hint">{t('wiz.publicBgHint')}</span></p>
                  <div className="dt-qs">{MANUAL_Q.map((q, i) => (
                    <label key={i} className="dt-q"><span>{t(q)}</span><textarea rows={2} maxLength={200} value={manual[i]} onChange={(e) => setManual((m) => m.map((v, j) => (j === i ? e.target.value : v)))} /></label>
                  ))}</div>
                </div>
              )}
              {memSource === 'upload' && (
                <div className="dt-picker"><p className="kicker">Public Background · Upload</p>
                  <input ref={fileRef} type="file" accept=".txt,.md,.json" hidden onChange={onFile} />
                  {uploadName ? (
                    <div className="dt-upload-row"><span><Check size={14} /> {uploadName} · {uploadText.length} chars</span><button type="button" className="dt-chip" onClick={() => { setUploadName(''); setUploadText(''); }}>{t('wiz.remove')}</button></div>
                  ) : (
                    <button type="button" className="dt-upload-btn" onClick={() => fileRef.current?.click()}><Upload size={16} /> {t('wiz.pickFile')}</button>
                  )}
                </div>
              )}
              {memSource === 'aicoo' && (
                <div className="dt-picker"><p className="kicker">Import from Aicoo</p>
                  <div className="dt-empty">{t('wiz.aicooEmpty')}</div>
                </div>
              )}
              {memSource === 'empty' && <div className="dt-empty">{t('wiz.emptyMem')}</div>}

              <details className="dt-hidden" open={hiddenMemories.length > 0}>
                <summary><span className="kicker">Hidden Memory</span><span className="dt-hint">{t('wiz.hiddenHint')}</span></summary>
                <div className="dt-chips" style={{ marginTop: 10 }}>{HIDDEN_TPL.map((k) => { const txt = t(k); return <button key={k} type="button" className={`dt-chip ${hidden.includes(txt) ? 'on' : ''}`} onClick={() => toggleHidden(txt)}>{txt}</button>; })}</div>
                <textarea className="dt-persona-input" rows={2} maxLength={300} style={{ marginTop: 10 }} value={customHidden} placeholder={t('wiz.hiddenPh')} onChange={(e) => setCustomHidden(e.target.value)} />
              </details>
            </>
          )}

          {step === 4 && (
            <div className="dt-review">
              <div className="dt-review-preview"><Sprite look={look} size={132} /><b>{name || t('wiz.unnamed')}</b></div>
              <div className="dt-review-facts">
                <div><span className="kicker">Relationship style</span><b>{STYLES.find((s) => s.v === style)?.label} · {t(`style.${style}`)}</b></div>
                <div><span className="kicker">Core traits</span><b>{traits.map((v) => t(`trait.${TRAITS.find((x) => x.v === v)?.k ?? ''}`)).join(' · ') || t('wiz.none')}</b></div>
                <div><span className="kicker">Dimensions</span><b>H{dims.honesty} · A{dims.attachment} · G{dims.aggression} · D{dims.disclosure}</b></div>
                <div><span className="kicker">Memory source</span><b>{MEM_SOURCES.find((m) => m.v === memSource)?.label}</b></div>
                <div><span className="kicker">Public / Hidden memory</span><b>{t('wiz.memCount', { pub: publicBackground ? publicBackground.split('\n').length : 0, hid: hiddenMemories.length })}</b></div>
                <div className="dt-review-summary"><span className="kicker">Personality summary</span><p>{summary}</p></div>
                <div className="dt-review-warn"><Sparkles size={15} /> <p>{t('wiz.warn')}</p></div>
                {error && <p className="dt-notice" role="alert">{error}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="dt-wiz-foot">
          <button type="button" className="dt-foot-back" onClick={() => (step === 1 ? onClose() : setStep(step - 1))} disabled={busy}>
            <ArrowLeft size={15} /> {step === 1 ? t('wiz.cancel') : t('wiz.back')}
          </button>
          {step < 4 ? (
            <button type="button" className="dt-foot-next" disabled={!canContinue} onClick={() => setStep(step + 1)}>Continue <ArrowRight size={15} /></button>
          ) : (
            <button type="button" className="dt-foot-release" disabled={busy || loading || !name.trim()} onClick={release}>
              {busy ? <RefreshCw size={16} className="dt-spin" /> : <Sparkles size={16} />}{' '}
              {editing ? t('wiz.save') : t('wiz.release')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
