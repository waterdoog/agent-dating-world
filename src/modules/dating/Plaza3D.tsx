import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Clone, Html, OrbitControls, ContactShadows, Merged } from '@react-three/drei';
import { Suspense, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { DatingLook } from '../../api';
import { useI18n } from '../../i18n';
import { avatar3dUrl, type AgentAppearance } from './agent-avatar';

// Kenney city tiles are 1×1 units and buildings are ~1–2 units tall, so agents
// must be small: a character model is ~1.8 units before scaling.
const AGENT_SCALE = 0.42;
/**
 * Sim field (0–100) → world space. It used to squeeze everyone onto the paving,
 * so the whole cast milled in the middle no matter where they meant to be.
 * The band now covers the TOWN, so walking to the tavern or the park is a real
 * journey across the map. Kept as separate axes because the town is wider than
 * it is deep.
 */
const mapX = (v: number) => ((v - 8) / 84 - 0.5) * 15;
const mapZ = (v: number) => ((v - 8) / 84 - 0.5) * 14;
const map = mapX;   // legacy single-axis helper for square-ish uses

// live positions come from the sim ref (read every frame — React re-renders do
// NOT reliably reach inside the r3f Canvas); identity + bubbles come from props.
export interface LivePos { name: string; x: number; y: number; vx?: number; vy?: number; heading?: number }
export interface Npc3D {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  doing?: string;
}

export interface Mover3D {
  name: string;
  look: DatingLook;
  you: boolean;
  x: number;   // snapshot for initial placement (before useFrame's first tick)
  y: number;
  partner?: string;
  bubble?: { text: string; kind: 'fight' | 'love' | 'new' };
}

function Prop({ url, position, rotation, scale = 1, scaleY }: { url: string; position: [number, number, number]; rotation?: [number, number, number]; scale?: number; scaleY?: number }) {
  const { scene } = useGLTF(url);
  const s3: [number, number, number] = [scale, scale * (scaleY ?? 1), scale];
  return <Clone object={scene} position={position} rotation={rotation} scale={s3} castShadow receiveShadow />;
}

const _v = new THREE.Vector3();

// stagger name tags per agent so neighbours' cards don't sit on top of each other
function tagLift(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % 4) * 0.17;
}

function Agent({ agent, posRef }: { agent: Mover3D; posRef: RefObject<LivePos[]> }) {
  const { scene } = useGLTF(avatar3dUrl(agent.look as AgentAppearance));
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const inited = useRef(false);
  const step = useRef(0);
  useFrame((_s, dt) => {
    const p = posRef.current?.find((m) => m.name === agent.name);
    if (!p || !g.current) return;
    _v.set(mapX(p.x), 0, mapZ(p.y));
    if (inited.current) g.current.position.lerp(_v, 0.16);
    else { g.current.position.copy(_v); inited.current = true; }
    // turn the BODY to face where it's walking (tags stay screen-facing)
    if (typeof p.heading === 'number' && body.current) {
      const cur = body.current.rotation.y;
      const diff = ((p.heading - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      body.current.rotation.y = cur + diff * 0.15;
    }
    // a small bob + lean while actually moving, so walking reads as walking
    const speed = Math.hypot(p.vx ?? 0, p.vy ?? 0);
    if (body.current) {
      step.current += Math.min(dt, 0.05) * speed * 26;
      const walking = speed > 0.05;
      body.current.position.y = walking ? Math.abs(Math.sin(step.current)) * 0.055 : 0;
      body.current.rotation.z = walking ? Math.sin(step.current * 2) * 0.05 : 0;
    }
  });
  return (
    <group ref={g} position={[mapX(agent.x), 0, mapZ(agent.y)]}>
      <group ref={body}>
        <Clone object={scene} scale={AGENT_SCALE} castShadow />
      </group>
      {agent.you && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.34, 0.44, 24]} />
          <meshBasicMaterial color="#e0b53a" />
        </mesh>
      )}
      <Html position={[0, 1.15 + tagLift(agent.name), 0]} center distanceFactor={12} zIndexRange={[10, 0]}>
        <div className={`dt3d-tag ${agent.you ? 'you' : ''}`}>{agent.name}</div>
      </Html>

    </group>
  );
}

const R = Math.PI / 2;   // one quarter turn

/**
 * Landmarks. The town was a field of identical coloured boxes, so the bar and
 * the florist were indistinguishable and "meet me at the bar" pointed nowhere.
 * These mirror town-map.ts: same ids, same 0–100 coordinates — scaled up, given
 * their own model, and captioned so each is recognisable from across the square.
 */
const LANDMARKS: Array<{ id: string; name: string; pos: [number, number]; url: string; scale: number; rot?: number; scaleY?: number }> = [
  // world-space positions chosen to sit ON their district, fronting a street
  { id: 'clock', name: 'place.clock', pos: [-5.6, 0.6], url: `/city/building-small-d.glb`, scale: 1.5, scaleY: 2.6, rot: R },
  { id: 'tavern', name: 'place.tavern', pos: [6.9, 1.1], url: `/city/building-small-b.glb`, scale: 1.7, rot: -R },
  { id: 'florist', name: 'place.florist', pos: [-3.4, -6.9], url: `/city/building-small-c.glb`, scale: 1.25, rot: Math.PI },
  { id: 'park', name: 'place.park', pos: [-7.2, 6.4], url: '/city/grass-trees-tall.glb', scale: 1.3 },
  { id: 'alley', name: 'place.alley', pos: [0.9, -6.1], url: '/city/building-garage.glb', scale: 0.75, rot: R },
  { id: 'backalley', name: 'place.backalley', pos: [10.2, 3.4], url: '/city/building-garage.glb', scale: 0.8, rot: -R },
];

/** A landmark building plus a standing sign, so the place reads from a distance. */
function Landmark({ mark }: { mark: (typeof LANDMARKS)[number] }) {
  const { t } = useI18n();
  const { scene } = useGLTF(mark.url);
  const s = mark.scale;
  return (
    <group position={[mark.pos[0], 0, mark.pos[1]]} rotation={[0, mark.rot ?? 0, 0]}>
      <Clone object={scene} scale={[s, s * (mark.scaleY ?? 1), s]} castShadow receiveShadow />
      <Html position={[0, 1.4 * s * (mark.scaleY ?? 1), 0]} center distanceFactor={22} zIndexRange={[6, 0]}>
        <div className="dt3d-landmark">{t(mark.name)}</div>
      </Html>
    </group>
  );
}

const NPC_MODEL: Record<string, string> = {
  vendor: '/characters3d/character-f.glb',
  bartender: '/characters3d/character-h.glb',
  police: '/characters3d/character-c.glb',
  gossip: '/characters3d/character-k.glb',
};

/** A townsfolk NPC: stands its post, click to deal with it. */
function NpcFigure({ npc, onPick }: { npc: Npc3D; onPick?: (id: string) => void }) {
  const { scene } = useGLTF(NPC_MODEL[npc.kind] ?? NPC_MODEL.vendor);
  return (
    <group position={[mapX(npc.x), 0, mapZ(npc.y)]} onClick={(e) => { e.stopPropagation(); onPick?.(npc.id); }}>
      <Clone object={scene} scale={AGENT_SCALE} castShadow />
      {/* an invisible collider: the model itself is a thin figure and easy to
          miss, so give the click a body-sized target */}
      <mesh position={[0, 0.38, 0]} visible={false}>
        <boxGeometry args={[0.55, 0.8, 0.55]} />
      </mesh>
      <Html position={[0, 0.86, 0]} center distanceFactor={17} zIndexRange={[8, 0]}>
        {/* the label is HTML, so it needs its own handler — clicking the name
            used to hit nothing and also shadowed the model behind it */}
        <div
          className={`dt3d-npc ${npc.kind}`}
          onPointerDown={(e) => { e.stopPropagation(); onPick?.(npc.id); }}
        >
          {npc.name}{npc.doing ? <em>{npc.doing}</em> : null}
        </div>
      </Html>
    </group>
  );
}

/** A single line above one agent — used when nobody is answering. */
function SoloBubble({ agent, posRef }: { agent: Mover3D; posRef: RefObject<LivePos[]> }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = posRef.current?.find((m) => m.name === agent.name);
    if (!p || !g.current) return;
    g.current.position.set(mapX(p.x), 1.72 + tagLift(agent.name), mapZ(p.y));
  });
  if (!agent.bubble) return null;
  return (
    <group ref={g}>
      <Html center distanceFactor={11} zIndexRange={[20, 0]}>
        <div className={`dt3d-bubble ${agent.bubble.kind}`}>{agent.bubble.text}</div>
      </Html>
    </group>
  );
}

/** One shared chat box floating between two agents who are talking. */
function ChatBox({ a, b, posRef }: { a: Mover3D; b: Mover3D; posRef: RefObject<LivePos[]> }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const pa = posRef.current?.find((m) => m.name === a.name);
    const pb = posRef.current?.find((m) => m.name === b.name);
    if (!pa || !pb || !g.current) return;
    g.current.position.set((mapX(pa.x) + mapX(pb.x)) / 2, 1.5, (mapZ(pa.y) + mapZ(pb.y)) / 2);
  });
  const kind = a.bubble?.kind ?? b.bubble?.kind ?? 'new';
  return (
    <group ref={g}>
      <Html center distanceFactor={11} zIndexRange={[20, 0]}>
        <div className={`dt3d-chat ${kind}`}>
          {a.bubble && <p><b>{a.name}</b>{a.bubble.text}</p>}
          {b.bubble && <p className="reply"><b>{b.name}</b>{b.bubble.text}</p>}
        </div>
      </Html>
    </group>
  );
}

type TownPiece = { url: string; pos: [number, number, number]; rot?: [number, number, number]; scale?: number; scaleY?: number };

/**
 * Draws the town in batches. Every tile used to be its own <Clone>, which meant
 * hundreds of loads and draw calls and a scene that never finished appearing.
 * Identical models now share one instanced mesh each.
 */
function TownGeometry({ pieces }: { pieces: TownPiece[] }) {
  const urls = [...new Set(pieces.map((p) => p.url))];
  const gltfs = useGLTF(urls) as unknown as Array<{ scene: THREE.Group }>;
  const meshes: Record<string, THREE.Mesh> = {};
  urls.forEach((url, i) => {
    const scene = gltfs[i]?.scene;
    scene?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !meshes[url]) meshes[url] = o as THREE.Mesh;
    });
  });
  if (Object.keys(meshes).length !== urls.length) return null;
  return (
    <Merged meshes={meshes} castShadow receiveShadow>
      {(models: Record<string, React.FC<Record<string, unknown>>>) => (
        <>
          {pieces.map((p, i) => {
            const M = models[p.url];
            if (!M) return null;
            const s = p.scale ?? 1;
            return <M key={i} position={p.pos} rotation={p.rot} scale={[s, s * (p.scaleY ?? 1), s]} />;
          })}
        </>
      )}
    </Merged>
  );
}

function Scene({ agents, posRef, npcs, onNpc }: { agents: Mover3D[]; posRef: RefObject<LivePos[]>; npcs: Npc3D[]; onNpc?: (id: string) => void }) {
  // pair up talking agents so each conversation gets ONE box, not two ribbons
  const seen = new Set<string>();
  const chats: Array<[Mover3D, Mover3D]> = [];
  for (const a of agents) {
    if (!a.partner || seen.has(a.name)) continue;
    const b = agents.find((m) => m.name === a.partner);
    if (!b || b.partner !== a.name) continue;
    if (!a.bubble && !b.bubble) continue;
    seen.add(a.name); seen.add(b.name);
    chats.push([a, b]);
  }

  const B = '/city/building-small-';
  const KINDS = [`${B}a.glb`, `${B}b.glb`, `${B}c.glb`, `${B}d.glb`];
  const hashAt = (x: number, z: number) => Math.abs(Math.round(x * 73856093 + z * 19349663)) % 997;

  type Piece = { url: string; pos: [number, number, number]; rot?: [number, number, number]; scale?: number; scaleY?: number };
  const roads: Piece[] = [];
  const blocks: Piece[] = [];
  const props: Piece[] = [];
  const paving: [number, number][] = [];

  const road = (x: number, z: number, rot = 0, lamp = false) =>
    roads.push({ url: lamp ? '/city/road-straight-lightposts.glb' : '/city/road-straight.glb', pos: [x, 0, z], rot: [0, rot, 0] });

  // ── three streets, meeting off-centre ─────────────────────────────
  // Kenney's road tile runs along Z, so a street laid out along X needs the
  // quarter turn — these were the wrong way round and the tarmac ran across
  // the direction of travel.
  // ① the shopping street runs east–west across the north
  for (let x = -9; x <= 4; x++) road(x, -6, R, x % 4 === 0);
  // ② the main road runs north–south, east of the plaza
  for (let z = -6; z <= 8; z++) road(5, z, 0, z % 4 === 0);
  // ③ a southern road cuts back west toward the park
  for (let x = -8; x <= 5; x++) road(x, 8, R, x % 5 === 0);
  // short connectors: plaza to each street, so the square isn't sealed
  for (let z = -5; z <= -2; z++) road(-1, z, 0);
  for (let x = -7; x <= -5; x++) road(x, 2, R);
  roads.push({ url: '/city/road-intersection.glb', pos: [5, 0, -6] });
  roads.push({ url: '/city/road-intersection.glb', pos: [5, 0, 8] });
  roads.push({ url: '/city/road-corner.glb', pos: [-9, 0, -6], rot: [0, R, 0] });
  roads.push({ url: '/city/road-split.glb', pos: [-1, 0, -6], rot: [0, Math.PI, 0] });

  // ── the plaza: wide, open to the south, NOT ringed by buildings ────
  for (let x = -4; x <= 3; x++) for (let z = -3; z <= 5; z++) paving.push([x, z]);

  /** A row of shops along a street edge — varied heights, small gaps. */
  const row = (from: number, to: number, fixed: number, axis: 'x' | 'z', rot: number, gapAt: number[] = []) => {
    let i = 0;
    for (let v = from; v <= to; v += 1.15, i++) {
      if (gapAt.includes(i)) continue;
      const x = axis === 'x' ? v : fixed;
      const z = axis === 'x' ? fixed : v;
      const h = hashAt(x, z);
      blocks.push({ url: KINDS[h % KINDS.length], pos: [x, 0, z], rot: [0, rot, 0], scaleY: 0.85 + (h % 4) * 0.25 });
    }
  };

  // ── the commercial street (north-west), with a gap that IS the alley ──
  row(-9, 3.5, -7.6, 'x', Math.PI, [5]);          // shops facing the street
  row(-9, 1, -4.4, 'x', 0, [3, 4]);               // opposite side, broken up
  row(-10.5, -6, -10.4, 'x', Math.PI);            // a second, quieter parade behind it
  // ── homes east of the main road, set back, different orientation ─────
  row(-4, 6, 7.4, 'z', -R);
  row(-1, 7, 10.2, 'z', -R, [2]);                 // a deeper eastern block
  // ── the southern edge: two staggered residential rows ───────────────
  row(-7, 3, 10.4, 'x', 0, [2, 5]);
  row(-4, 6, 12.8, 'x', 0, [1, 4]);
  // ── western homes closing the park's back ───────────────────────────
  row(0, 7, -11.6, 'z', R, [3]);

  // ── landmark surroundings ───────────────────────────────────────────
  // tavern block (east): the building itself is a Landmark; give it neighbours
  blocks.push({ url: `${B}c.glb`, pos: [8.4, 0, -1.2], rot: [0, -R, 0], scaleY: 1.1 });
  blocks.push({ url: `${B}a.glb`, pos: [8.4, 0, 3.4], rot: [0, -R, 0], scaleY: 0.95 });
  // back alley walls behind the tavern
  blocks.push({ url: '/city/building-garage.glb', pos: [10.6, 0, 1.2], rot: [0, -R, 0], scaleY: 0.7 });

  // ── park (south-west): grass, trees, no buildings ───────────────────
  const greens: Array<[number, number, string]> = [
    [-7.5, 5.5, 'grass'], [-6, 6.6, 'grass'], [-8.5, 7, 'grass'],
    [-7, 4.4, 'grass-trees'], [-5.4, 5.8, 'grass-trees-tall'], [-8.6, 5.6, 'grass-trees'],
    [-6.2, 8.2, 'grass-trees'], [-9, 8.6, 'grass-trees-tall'],
    // green edges elsewhere, thinning toward the map's border
    [-11, -2, 'grass-trees'], [-11, 2, 'grass'], [-11.5, -7, 'grass-trees-tall'],
    [7.5, -7.5, 'grass-trees'], [11, -4, 'grass-trees'], [11.5, 5, 'grass-trees-tall'],
    [1, 11.5, 'grass-trees'], [-3, 11.5, 'grass'], [7, 10.5, 'grass-trees'],
    [-12, 10, 'grass-trees'], [12, 10, 'grass-trees'],
  ];

  // ── street furniture: lamps along the shopping street, plaza fixtures ──
  for (let x = -8; x <= 3; x += 3) props.push({ url: '/city/road-straight-lightposts.glb', pos: [x, 0, -5.2], rot: [0, R, 0], scale: 0.8 });
  props.push({ url: '/city/grass-trees.glb', pos: [-3.2, 0, 4.6], scale: 0.6 });
  props.push({ url: '/city/grass-trees.glb', pos: [2.6, 0, 4.6], scale: 0.6 });
  props.push({ url: '/city/road-straight-lightposts.glb', pos: [-2.6, 0, 0], rot: [0, R, 0], scale: 0.85 });
  props.push({ url: '/city/road-straight-lightposts.glb', pos: [2.2, 0, 0], rot: [0, -R, 0], scale: 0.85 });

  return (
    <>
      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[52, 52]} />
        <meshStandardMaterial color="#c4cf9c" />
      </mesh>
      <TownGeometry
        pieces={[
          ...paving.map(([x, z]) => ({ url: '/city/pavement.glb', pos: [x, 0, z] as [number, number, number] })),
          { url: '/city/pavement-fountain.glb', pos: [0, 0, 1] as [number, number, number] },
          ...roads, ...blocks, ...props,
          ...greens.map(([x, z, kind]) => ({ url: `/city/${kind}.glb`, pos: [x, 0, z] as [number, number, number] })),
        ]}
      />
      {agents.map((a) => (
        <Agent key={a.name} agent={a} posRef={posRef} />
      ))}
      {LANDMARKS.map((m) => (
        <Landmark key={m.id} mark={m} />
      ))}
      {npcs.map((n) => (
        <NpcFigure key={n.id} npc={n} onPick={onNpc} />
      ))}
      {chats.map(([a, b]) => (
        <ChatBox key={`${a.name}~${b.name}`} a={a} b={b} posRef={posRef} />
      ))}
      {/* a solo line (e.g. someone waiting, or broke) still needs somewhere to go */}
      {agents.filter((a) => a.bubble && !seen.has(a.name)).map((a) => (
        <SoloBubble key={`s${a.name}`} agent={a} posRef={posRef} />
      ))}
    </>
  );
}

/** Camera that rides your agent: over-the-shoulder, or through its eyes. */
/** Frames the whole town once on mount, so the view isn't hand-tuned numbers. */
function FitTown() {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update: () => void } | null };
  const done = useRef(false);
  useFrame(() => {
    if (done.current || !controls) return;
    done.current = true;
    controls.target.set(0, 0, 1.5);
    camera.position.set(32, 28, 34);
    controls.update();
  });
  return null;
}


function FollowCam({ name, posRef, firstPerson }: { name: string; posRef: RefObject<LivePos[]>; firstPerson?: boolean }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3());
  useFrame(() => {
    const p = posRef.current?.find((m) => m.name === name);
    if (!p) return;
    const tx = mapX(p.x), tz = mapZ(p.y);
    const h = p.heading ?? 0;
    if (firstPerson) {
      // eye height, just in front of the head, facing the way it walks
      _v.set(tx - Math.sin(h) * 0.12, 0.78, tz - Math.cos(h) * 0.12);
      camera.position.lerp(_v, 0.35);
      look.current.set(tx + Math.sin(h) * 6, 0.7, tz + Math.cos(h) * 6);
      camera.lookAt(look.current);
    } else {
      _v.set(tx + 4.5, 4.2, tz + 4.5);
      camera.position.lerp(_v, 0.06);
      camera.lookAt(tx, 0.4, tz);
    }
  });
  return null;
}

export default function Plaza3D({ agents, posRef, npcs = [], onNpc, follow, firstPerson }: { agents: Mover3D[]; posRef: RefObject<LivePos[]>; npcs?: Npc3D[]; onNpc?: (id: string) => void; follow?: string; firstPerson?: boolean }) {
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [6.4, 5.4, 6.4], fov: 36 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#f2e8d0']} />
      <hemisphereLight args={['#fff6e0', '#b9a97e', 0.7]} />
      <directionalLight position={[8, 13, 5]} intensity={1.25} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-far={90} shadow-camera-left={-30} shadow-camera-right={30} shadow-camera-top={30} shadow-camera-bottom={-30} />
      <Suspense fallback={null}>
        <Scene agents={agents} posRef={posRef} npcs={npcs} onNpc={onNpc} />
        {!follow && <FitTown />}
        {follow && <FollowCam name={follow} posRef={posRef} firstPerson={firstPerson} />}
        <ContactShadows position={[0, 0.015, 0]} opacity={0.26} scale={40} blur={2} far={8} />
      </Suspense>
      {!follow && <OrbitControls enablePan={false} minPolarAngle={0.45} maxPolarAngle={1.15} minDistance={10} maxDistance={110} target={[0.5, 0.3, 1.5]} makeDefault />}
    </Canvas>
  );
}

useGLTF.preload('/city/pavement.glb');
useGLTF.preload('/city/pavement-fountain.glb');
