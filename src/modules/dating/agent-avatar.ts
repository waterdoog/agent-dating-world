/**
 * Parametric agent avatars — chunky "square-head little person" figures:
 * an isometric cube head on a stubby humanoid body. Deterministic from the
 * agent's appearance spec; ink-outlined so it stays in the N1 board dialect.
 *
 * form     → a head topper (cat ears, bunny ears, antenna, sprout…) so agents
 *            keep their flavour while sharing one body.
 * color    → body + head colour.
 * mood     → the face on the cube.
 * accessory→ a worn item (tie, crown, halo…).
 */

export type Form = 'cube' | 'cat' | 'bunny' | 'bot' | 'sprout' | 'cloud' | 'ghost';
export type Mood = 'curious' | 'cold' | 'romantic' | 'cryptic' | 'sly' | 'angry' | 'shy' | 'wise';
export type Accessory = 'none' | 'tie' | 'crown' | 'halo' | 'antenna' | 'web' | 'notebook';

export interface AgentAppearance {
  form: Form;
  color: string;
  mood: Mood;
  accessory?: Accessory;
  seed?: string;
}

const INK = 'oklch(0.24 0.04 45)';
const PAPER = 'oklch(0.97 0.015 84)';
const BLUSH = 'oklch(0.7 0.15 8 / 0.7)';

function parts(color: string): { l: number; c: number; h: number } | null {
  const m = color.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  return m ? { l: +m[1], c: +m[2], h: +m[3] } : null;
}
function withL(color: string, dl: number): string {
  const p = parts(color);
  if (!p) return color;
  const l = Math.max(0.12, Math.min(0.97, p.l + dl));
  return `oklch(${l.toFixed(3)} ${p.c} ${p.h})`;
}
/** Face features read on any body: white on dark bodies, ink on light. */
function faceInk(color: string): string {
  const p = parts(color);
  return p && p.l < 0.58 ? PAPER : INK;
}
const O = (extra = 2.4) => `stroke="${INK}" stroke-width="${extra}" stroke-linejoin="round" stroke-linecap="round"`;

function face(mood: Mood, fc: string): string {
  const eL = 44, eR = 56, ey = 35;
  const eye = (x: number, y: number, r = 2.7) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${fc}"/>`;
  const brow = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${fc}" stroke-width="2.6" stroke-linecap="round"/>`;
  const dash = (x: number, y: number) => `<rect x="${x - 3.4}" y="${y - 1}" width="6.8" height="2.2" rx="1.1" fill="${fc}"/>`;
  const mouth = (d: string) => `<path d="${d}" fill="none" stroke="${fc}" stroke-width="2.1" stroke-linecap="round"/>`;
  const blush = () =>
    `<ellipse cx="37" cy="42" rx="3.4" ry="2.2" fill="${BLUSH}"/><ellipse cx="63" cy="42" rx="3.4" ry="2.2" fill="${BLUSH}"/>`;

  switch (mood) {
    case 'angry':
      return brow(39, 30, 47, 33.5) + brow(61, 30, 53, 33.5) + eye(eL, 37, 2.3) + eye(eR, 37, 2.3) +
        `<rect x="43" y="43" width="14" height="6" rx="2" fill="${fc}"/><rect x="47.5" y="43" width="1.6" height="6" fill="${INK}" opacity="0.35"/><rect x="51" y="43" width="1.6" height="6" fill="${INK}" opacity="0.35"/>`;
    case 'cold':
      return dash(eL, ey) + dash(eR, ey) + mouth(`M45 45 L55 45`);
    case 'romantic':
      return eye(eL, ey) + eye(eR, ey) + blush() + mouth(`M45 44 Q50 49 55 44`) +
        `<path d="M50 24 q-3 -3 -5 0 q-1.5 2.5 5 5 q6.5 -2.5 5 -5 q-2 -3 -5 0z" fill="oklch(0.62 0.19 12)"/>`;
    case 'sly':
      return `<path d="M40 35 Q44 31 48 35" stroke="${fc}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M52 35 Q56 31 60 35" stroke="${fc}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
        mouth(`M44 45 Q50 48 57 43`);
    case 'cryptic':
      return `<path d="M${eL - 3} ${ey} L${eL + 3} ${ey} M${eL} ${ey - 3} L${eL} ${ey + 3}" stroke="${fc}" stroke-width="2"/>` + eye(eR, ey, 2.2) + mouth(`M45 45 L55 45`);
    case 'shy':
      return eye(eL, ey, 2.2) + eye(eR, ey, 2.2) + blush() + mouth(`M47 45 Q50 47 53 45`);
    case 'wise':
      return `<path d="M40 36 Q44 32 48 36" stroke="${fc}" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M52 36 Q56 32 60 36" stroke="${fc}" stroke-width="2" fill="none" stroke-linecap="round"/>` + mouth(`M45 45 Q50 47 55 45`);
    default: // curious
      return eye(eL, ey) + eye(eR, ey) + `<circle cx="${eL - 1}" cy="${ey - 1}" r="0.9" fill="${PAPER}"/><circle cx="${eR - 1}" cy="${ey - 1}" r="0.9" fill="${PAPER}"/>` + mouth(`M46 44 Q50 48 54 44`);
  }
}

function topper(form: Form, color: string): string {
  const dk = withL(color, -0.1);
  switch (form) {
    case 'cat':
      return `<path d="M35 24 L34 12 L45 20 Z" fill="${dk}" ${O(2.2)}/><path d="M65 24 L66 12 L55 20 Z" fill="${dk}" ${O(2.2)}/>`;
    case 'bunny':
      return `<rect x="40" y="1" width="7" height="20" rx="3.5" fill="${color}" ${O(2.2)}/><rect x="53" y="1" width="7" height="20" rx="3.5" fill="${color}" ${O(2.2)}/><rect x="42.5" y="5" width="2" height="11" rx="1" fill="${BLUSH}"/><rect x="55.5" y="5" width="2" height="11" rx="1" fill="${BLUSH}"/>`;
    case 'bot':
      return `<line x1="50" y1="14" x2="50" y2="5" stroke="${INK}" stroke-width="2.2"/><circle cx="50" cy="3.5" r="3.2" fill="oklch(0.82 0.15 88)" ${O(1.8)}/>`;
    case 'sprout':
      return `<path d="M50 15 q-2 -12 -11 -14 q-1 10 11 14z" fill="oklch(0.6 0.13 150)" ${O(2)}/><path d="M50 14 q2 -9 10 -10 q1 8 -10 10z" fill="oklch(0.66 0.13 150)" ${O(2)}/>`;
    case 'cloud':
      return `<path d="M38 15 a6 6 0 0 1 3 -11 a6 6 0 0 1 11 -1 a6 6 0 0 1 6 9z" fill="${PAPER}" ${O(2)}/>`;
    case 'ghost':
      return `<path d="M33 24 q17 -16 34 0" fill="none" ${O(2.4)}/>`;
    default:
      return '';
  }
}

function accessory(kind: Accessory, color: string): string {
  switch (kind) {
    case 'tie':
      return `<path d="M50 55 l-3.5 4 3.5 9 3.5 -9z" fill="oklch(0.55 0.19 29)" ${O(1.6)}/>`;
    case 'crown':
      return `<path d="M40 12 l3 7 4 -9 3 9 4 -7 v6 h-14z" fill="oklch(0.82 0.15 88)" ${O(1.8)}/>`;
    case 'halo':
      return `<ellipse cx="50" cy="9" rx="13" ry="3.6" fill="none" stroke="oklch(0.82 0.15 88)" stroke-width="3"/>`;
    case 'antenna':
      return `<line x1="50" y1="14" x2="50" y2="6" stroke="${INK}" stroke-width="2.2"/><circle cx="50" cy="4" r="3" fill="oklch(0.51 0.12 150)" ${O(1.6)}/>`;
    case 'web':
      return `<g stroke="${INK}" stroke-width="1.1" fill="none" opacity="0.45"><path d="M18 62 l14 6 M18 62 l3 14 M18 62 l-2 -8"/><path d="M12 66 q9 2 15 7"/></g>`;
    case 'notebook':
      return `<g transform="rotate(-12 72 66)"><rect x="66" y="58" width="13" height="16" rx="2" fill="${PAPER}" ${O(1.8)}/><line x1="69" y1="63" x2="76" y2="63" stroke="${INK}" stroke-width="1.2"/><line x1="69" y1="67" x2="76" y2="67" stroke="${INK}" stroke-width="1.2"/></g>`;
    default:
      return '';
  }
}

/** A self-contained <svg> for one square-head agent. */
// ── Kenney 2D avatar art (blocky characters + cube pets) — replaces the
//    old parametric squares the user found too ugly. ──────────────────────
const PET_FILES = ['animal-beaver', 'animal-bee', 'animal-bunny', 'animal-cat', 'animal-caterpillar', 'animal-chick', 'animal-cow', 'animal-crab', 'animal-deer', 'animal-dog', 'animal-elephant', 'animal-fish', 'animal-fox', 'animal-giraffe', 'animal-hog', 'animal-koala', 'animal-lion', 'animal-monkey', 'animal-panda', 'animal-parrot'];
const CHAR_FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r'];
export const AVATAR_CHOICES = [
  ...PET_FILES.map((f) => `/avatars/pets/${f}.png`),
  ...CHAR_FILES.map((f) => `/avatars/characters/character-${f}.png`),
];
const FORM_AVATAR: Record<string, string> = {
  cat: '/avatars/pets/animal-cat.png',
  bunny: '/avatars/pets/animal-bunny.png',
  sprout: '/avatars/pets/animal-caterpillar.png',
  cloud: '/avatars/pets/animal-chick.png',
  ghost: '/avatars/pets/animal-fox.png',
  bot: '/avatars/characters/character-a.png',
  cube: '/avatars/characters/character-b.png',
};
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
/** The picture an agent wears — an explicit `avatar`, else its form, else hashed from its seed. */
export function avatarUrl(a: AgentAppearance): string {
  const explicit = (a as { avatar?: string }).avatar;
  if (explicit) return explicit;
  if (a.form && FORM_AVATAR[a.form]) return FORM_AVATAR[a.form];
  return AVATAR_CHOICES[hashStr(a.seed || a.color || a.form || 'x') % AVATAR_CHOICES.length];
}

export function agentSprite(a: AgentAppearance, size = 96): string {
  return `<img src="${avatarUrl(a)}" width="${size}" height="${size}" class="agent-sprite" alt="" draggable="false" />`;
}

export function agentSpriteSvg(a: AgentAppearance, size = 96): string {
  const body = a.color;
  const top = withL(body, 0.12);
  const limb = withL(body, -0.09);
  const leg = withL(body, -0.2);
  const fc = faceInk(body);

  return (
    `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" class="agent-sprite" aria-hidden="true">` +
    `<ellipse cx="50" cy="91" rx="22" ry="4.6" fill="${INK}" opacity="0.15"/>` +
    // legs
    `<rect x="42" y="73" width="7" height="15" rx="3" fill="${leg}" ${O()}/>` +
    `<rect x="51" y="73" width="7" height="15" rx="3" fill="${leg}" ${O()}/>` +
    // arms
    `<rect x="29" y="53" width="8" height="18" rx="4" fill="${limb}" ${O()}/><circle cx="33" cy="72" r="4.4" fill="${limb}" ${O()}/>` +
    `<rect x="63" y="53" width="8" height="18" rx="4" fill="${limb}" ${O()}/><circle cx="67" cy="72" r="4.4" fill="${limb}" ${O()}/>` +
    // torso (symmetric)
    `<rect x="37" y="50" width="26" height="26" rx="7" fill="${body}" ${O()}/>` +
    // head — front-facing, upright, symmetric
    `<rect x="32" y="21" width="36" height="33" rx="7" fill="${body}" ${O()}/>` +
    `<rect x="37" y="25" width="26" height="7" rx="3.5" fill="${top}" opacity="0.5"/>` +
    face(a.mood, fc) +
    topper(a.form, body) +
    accessory(a.accessory ?? 'none', body) +
    `</svg>`
  );
}
