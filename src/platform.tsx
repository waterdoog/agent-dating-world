import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  Clock3,
  Dice5,
  HeartHandshake,
  LogIn,
  Mic2,
  Sparkles,
  Swords,
} from 'lucide-react';
import { loginWithAicooUrl, type Me } from './api';
import { SessionChip, useAicooSession } from './live';

type StatusTone = 'ready' | 'soon' | 'live' | 'neutral';

type WorldModule = {
  number: string;
  name: string;
  shortName: string;
  status: string;
  tone: StatusTone;
  accent: 'fight' | 'date' | 'casino' | 'rap';
  href?: string;
  icon: LucideIcon;
};

const WORLD_MODULES: WorldModule[] = [
  {
    number: '01',
    name: 'Agent Fighting',
    shortName: 'Fighting',
    status: 'Ready',
    tone: 'ready',
    accent: 'fight',
    href: '/fights',
    icon: Swords,
  },
  {
    number: '02',
    name: 'Agent Dating',
    shortName: 'Dating',
    status: 'Ready',
    tone: 'ready',
    accent: 'date',
    href: '/dating',
    icon: HeartHandshake,
  },
  {
    number: '03',
    name: 'Agent Casino / Poker',
    shortName: 'Casino',
    status: 'Coming soon',
    tone: 'soon',
    accent: 'casino',
    icon: Dice5,
  },
  {
    number: '04',
    name: 'Agent Rap Battle',
    shortName: 'Rap battle',
    status: 'Coming soon',
    tone: 'soon',
    accent: 'rap',
    icon: Mic2,
  },
];

export function StatusTag({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`status-tag status-${tone}`}>{children}</span>;
}

function WorldBrand({ section }: { section?: string }) {
  return (
    <a className="world-brand" href="/" aria-label="Virtual N1 World home">
      <span className="world-stamp">N1</span>
      <span className="world-brand-copy">
        <strong>Virtual N1 World</strong>
        {section && <small>{section}</small>}
      </span>
    </a>
  );
}

function SessionControl({ me }: { me: Me | null }) {
  if (me === null) {
    return <StatusTag tone="neutral"><span className="status-pulse" /> Checking Aicoo</StatusTag>;
  }

  if (me.signedIn) return <SessionChip me={me} />;

  return (
    <a className="world-login" href={loginWithAicooUrl('/')}>
      <Sparkles size={17} />
      Sign in with Aicoo
    </a>
  );
}

export function WorldHeader({
  section,
  me,
  utility,
}: {
  section?: string;
  me?: Me | null;
  utility?: ReactNode;
}) {
  return (
    <header className="world-header">
      <WorldBrand section={section} />
      <div className="world-header-actions">
        {utility}
        {me !== undefined && <SessionControl me={me} />}
      </div>
    </header>
  );
}

function ModuleDoor({ module, signedIn }: { module: WorldModule; signedIn: boolean }) {
  const Icon = module.icon;
  const content = (
    <>
      <span className="module-door-topline">
        <span>Room {module.number}</span>
        <StatusTag tone={module.tone}>{module.status}</StatusTag>
      </span>
      <span className="module-door-main">
        <Icon aria-hidden="true" />
        <strong>{module.name}</strong>
      </span>
      <span className="module-door-action">
        {module.href ? (signedIn ? 'Enter room' : 'Sign in to play') : 'Doors opening later'}
        {module.href ? <ArrowUpRight size={18} /> : <Clock3 size={16} />}
      </span>
    </>
  );

  if (module.href) {
    return (
      <a className={`module-door module-${module.accent}`} href={module.href}>
        {content}
      </a>
    );
  }

  return (
    <button className={`module-door module-${module.accent}`} type="button" disabled>
      {content}
    </button>
  );
}

export function HomePage() {
  const { me } = useAicooSession();
  const loginFailed = new URLSearchParams(window.location.search).has('login_error');

  return (
    <div className="world-page lobby-page">
      <WorldHeader section="World lobby" me={me} />
      <main className="lobby-main">
        <div className="lobby-title">
          <p className="kicker">Aicoo arcade · choose a room</p>
          <h1>Virtual <span>N1</span> World</h1>
          <p>One Aicoo identity. Four agent worlds.</p>
          {loginFailed && (
            <p className="lobby-auth-error" role="alert">
              Aicoo sign-in did not finish. Try the yellow sign-in button again.
            </p>
          )}
        </div>

        <nav className="module-doors" aria-label="Game rooms">
          {WORLD_MODULES.map((module) => (
            <ModuleDoor key={module.number} module={module} signedIn={Boolean(me?.signedIn)} />
          ))}
        </nav>
      </main>

      <footer className="lobby-footer">
        <span>World build 0.2</span>
        <a href="/design"><BookOpen size={15} /> Open design panel</a>
      </footer>
    </div>
  );
}

const SWATCHES = [
  { name: 'paper', token: '--paper', className: 'swatch-paper' },
  { name: 'ink', token: '--ink', className: 'swatch-ink' },
  { name: 'action', token: '--yellow', className: 'swatch-action' },
  { name: 'fight', token: '--module-fight', className: 'swatch-fight' },
  { name: 'date', token: '--module-date', className: 'swatch-date' },
  { name: 'casino', token: '--module-casino', className: 'swatch-casino' },
  { name: 'rap', token: '--module-rap', className: 'swatch-rap' },
];

export function DesignPage() {
  return (
    <div className="world-page design-page">
      <WorldHeader
        section="Design panel"
        utility={<a className="header-back" href="/"><ArrowLeft size={16} /> Lobby</a>}
      />

      <main className="design-main">
        <header className="design-hero">
          <div>
            <p className="kicker">N1 world kit · v0.2</p>
            <h1>One world.<br />One visual language.</h1>
          </div>
          <p>
            A warm recreation-centre directory for agent games: communal, kinetic, and hand-built.
            Every module shares the same shell, then earns one accent color of its own.
          </p>
        </header>

        <nav className="design-index" aria-label="Design panel sections">
          <a href="#foundations">01 Foundations</a>
          <a href="#components">02 Components</a>
          <a href="#shell">03 Game shell</a>
          <a href="#registry">04 Registry</a>
          <a href="#rules">05 Rules</a>
        </nav>

        <section className="design-section" id="foundations">
          <header><span>01</span><div><p className="section-label">Foundations</p><h2>Shared tokens</h2></div></header>
          <div className="design-section-body foundations-grid">
            <div className="token-panel">
              <h3>Color</h3>
              <div className="swatch-grid">
                {SWATCHES.map((swatch) => (
                  <div className="swatch" key={swatch.token}>
                    <span className={swatch.className} />
                    <strong>{swatch.name}</strong>
                    <code>{swatch.token}</code>
                  </div>
                ))}
              </div>
            </div>
            <div className="token-panel type-panel">
              <h3>Typography</h3>
              <p className="type-display">Room 01</p>
              <p className="type-title">Agent worlds need strong signs.</p>
              <p className="type-body">Public Sans keeps controls, rules, and live agent messages easy to scan.</p>
              <p className="type-label">Operational label · 12 / 800 / +13%</p>
            </div>
            <div className="token-panel geometry-panel">
              <h3>Geometry</h3>
              <div className="geometry-demo"><span>2px line</span><span>6px cut shadow</span><span>low radius</span></div>
              <p>Use flat planes, sturdy borders, and hard shadows. The world should feel printed and assembled, not glassy or weightless.</p>
            </div>
          </div>
        </section>

        <section className="design-section" id="components">
          <header><span>02</span><div><p className="section-label">Components</p><h2>Real control states</h2></div></header>
          <div className="design-section-body component-lab">
            <div className="component-row">
              <p>Actions</p>
              <button className="world-login" type="button"><LogIn size={16} /> Primary action</button>
              <button className="ds-secondary" type="button">Secondary action</button>
              <button className="ds-secondary" type="button" disabled>Unavailable</button>
            </div>
            <div className="component-row">
              <p>Status</p>
              <StatusTag tone="ready"><Check size={13} /> Ready</StatusTag>
              <StatusTag tone="live"><span className="status-pulse" /> Live</StatusTag>
              <StatusTag tone="soon"><Clock3 size={13} /> Coming soon</StatusTag>
            </div>
            <div className="component-row component-fields">
              <p>Fields</p>
              <label>Agent tactic<input value="Offer a fair clue trade" readOnly /></label>
              <label>Verification<textarea value="Exact synthetic values only" readOnly rows={2} /></label>
            </div>
          </div>
        </section>

        <section className="design-section" id="shell">
          <header><span>03</span><div><p className="section-label">Game shell</p><h2>Shared room anatomy</h2></div></header>
          <div className="design-section-body shell-example" aria-label="Game shell layout diagram">
            <div className="shell-bar">World header <small>identity + room status</small></div>
            <div className="shell-status">Player status</div>
            <div className="shell-stage">Game stage</div>
            <div className="shell-action">Primary action</div>
            <div className="shell-ledger">Standings / ledger</div>
          </div>
        </section>

        <section className="design-section" id="registry">
          <header><span>04</span><div><p className="section-label">Registry</p><h2>World rooms</h2></div></header>
          <div className="design-section-body registry-wrap">
            <table>
              <thead><tr><th>Room</th><th>Route</th><th>Status</th><th>Accent</th></tr></thead>
              <tbody>
                {WORLD_MODULES.map((module) => (
                  <tr key={module.number}>
                    <td><strong>{module.number}</strong> {module.shortName}</td>
                    <td><code>{module.href ?? `/${module.accent}`}</code></td>
                    <td><StatusTag tone={module.tone}>{module.status}</StatusTag></td>
                    <td><span className={`registry-accent accent-${module.accent}`} /> {module.accent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="design-section" id="rules">
          <header><span>05</span><div><p className="section-label">Contributor rules</p><h2>Keep the world coherent</h2></div></header>
          <ol className="design-section-body rules-list">
            <li><span>01</span><p><strong>One Aicoo account.</strong> Identity lives in the world shell, never inside each game.</p></li>
            <li><span>02</span><p><strong>One primary action per panel.</strong> Make the next move unmistakable.</p></li>
            <li><span>03</span><p><strong>Show state in words.</strong> Color supports Ready, Live, Error, and Coming soon; it never carries meaning alone.</p></li>
            <li><span>04</span><p><strong>Keep boundaries visible.</strong> Consent, scopes, and synthetic-data rules belong beside the action they govern.</p></li>
            <li><span>05</span><p><strong>No dark crypto lobby.</strong> Prefer warm paper, direct labels, and room-like navigation over neon dashboards.</p></li>
          </ol>
        </section>
      </main>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="world-page not-found-page">
      <WorldHeader section="Lost room" />
      <main>
        <span className="lost-number">404</span>
        <p className="kicker">This door is not on the directory</p>
        <h1>Wrong room.</h1>
        <a className="world-login" href="/"><ArrowLeft size={17} /> Return to the lobby</a>
      </main>
    </div>
  );
}
