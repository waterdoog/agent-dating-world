import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Clone, Html, OrbitControls, ContactShadows } from '@react-three/drei';
import { Suspense, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { DatingLook } from '../../api';
import { avatar3dUrl, type AgentAppearance } from './agent-avatar';

// Kenney city tiles are 1×1 units and buildings are ~1–2 units tall, so agents
// must be small: a character model is ~1.8 units before scaling.
const AGENT_SCALE = 0.42;
// The sim keeps movers inside 10–89, so stretch that band across the paved
// plaza: 10 → -3.2 and 89 → +3.2, i.e. they use the whole square, not the middle.
const map = (v: number) => ((v - 10) / 79 - 0.5) * 7.6;

// live positions come from the sim ref (read every frame — React re-renders do
// NOT reliably reach inside the r3f Canvas); identity + bubbles come from props.
export interface LivePos { name: string; x: number; y: number; vx?: number; vy?: number; heading?: number }
export interface Npc3D {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
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

function Prop({ url, position, rotation, scale = 1 }: { url: string; position: [number, number, number]; rotation?: [number, number, number]; scale?: number }) {
  const { scene } = useGLTF(url);
  return <Clone object={scene} position={position} rotation={rotation} scale={scale} castShadow receiveShadow />;
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
    _v.set(map(p.x), 0, map(p.y));
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
    <group ref={g} position={[map(agent.x), 0, map(agent.y)]}>
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
    <group position={[map(npc.x), 0, map(npc.y)]} onClick={(e) => { e.stopPropagation(); onPick?.(npc.id); }}>
      <Clone object={scene} scale={AGENT_SCALE} castShadow />
      <Html position={[0, 1.05, 0]} center distanceFactor={13} zIndexRange={[8, 0]}>
        <div className={`dt3d-npc ${npc.kind}`}>{npc.name}</div>
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
    g.current.position.set(map(p.x), 1.72 + tagLift(agent.name), map(p.y));
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
    g.current.position.set((map(pa.x) + map(pb.x)) / 2, 1.5, (map(pa.y) + map(pb.y)) / 2);
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
  // 7×7 paved plaza — the agents' whole world, so nobody wanders onto bare dirt
  const pavement: [number, number][] = [];
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) pavement.push([x, z]);

  // a ring road around the plaza: straights on the sides, corners at the four ends
  const ring: Array<{ url: string; pos: [number, number, number]; rot?: [number, number, number] }> = [];
  for (let i = -3; i <= 3; i++) {
    const lamp = i % 3 === 0;
    ring.push({ url: lamp ? '/city/road-straight-lightposts.glb' : '/city/road-straight.glb', pos: [i, 0, -4], rot: [0, 0, 0] });
    ring.push({ url: lamp ? '/city/road-straight-lightposts.glb' : '/city/road-straight.glb', pos: [i, 0, 4], rot: [0, Math.PI, 0] });
    ring.push({ url: lamp ? '/city/road-straight-lightposts.glb' : '/city/road-straight.glb', pos: [-4, 0, i], rot: [0, R, 0] });
    ring.push({ url: lamp ? '/city/road-straight-lightposts.glb' : '/city/road-straight.glb', pos: [4, 0, i], rot: [0, -R, 0] });
  }
  ring.push({ url: '/city/road-corner.glb', pos: [-4, 0, -4], rot: [0, R, 0] });
  ring.push({ url: '/city/road-corner.glb', pos: [4, 0, -4], rot: [0, 0, 0] });
  ring.push({ url: '/city/road-corner.glb', pos: [4, 0, 4], rot: [0, -R, 0] });
  ring.push({ url: '/city/road-corner.glb', pos: [-4, 0, 4], rot: [0, Math.PI, 0] });

  // blocks on all four sides of the ring road, not one row
  const B = '/city/building-small-';
  const blocks: Array<{ url: string; pos: [number, number, number]; rot?: [number, number, number] }> = [
    { url: `${B}a.glb`, pos: [-5, 0, -5] },
    { url: `${B}c.glb`, pos: [-3, 0, -5.5] },
    { url: '/city/building-garage.glb', pos: [-1, 0, -5.5], rot: [0, Math.PI, 0] },
    { url: `${B}b.glb`, pos: [1, 0, -5.5] },
    { url: `${B}d.glb`, pos: [3, 0, -5.5] },
    { url: `${B}a.glb`, pos: [5, 0, -5], rot: [0, -R, 0] },
    { url: `${B}c.glb`, pos: [5.5, 0, -2], rot: [0, -R, 0] },
    { url: `${B}d.glb`, pos: [5.5, 0, 1], rot: [0, -R, 0] },
    { url: `${B}b.glb`, pos: [5, 0, 5], rot: [0, Math.PI, 0] },
    { url: '/city/building-garage.glb', pos: [2, 0, 5.5], rot: [0, 0, 0] },
    { url: `${B}c.glb`, pos: [-2, 0, 5.5] },
    { url: `${B}a.glb`, pos: [-5, 0, 5], rot: [0, R, 0] },
    { url: `${B}d.glb`, pos: [-5.5, 0, 2], rot: [0, R, 0] },
    { url: `${B}b.glb`, pos: [-5.5, 0, -1], rot: [0, R, 0] },
  ];

  // an outer town: a second ring road further out, with its own streets of
  // houses, so the world doesn't stop at the plaza's edge
  const OUT = 9;
  const outerRoad: Array<{ url: string; pos: [number, number, number]; rot?: [number, number, number] }> = [];
  for (let i = -OUT + 1; i <= OUT - 1; i++) {
    const lamp = i % 4 === 0;
    const road = lamp ? '/city/road-straight-lightposts.glb' : '/city/road-straight.glb';
    outerRoad.push({ url: road, pos: [i, 0, -OUT], rot: [0, 0, 0] });
    outerRoad.push({ url: road, pos: [i, 0, OUT], rot: [0, Math.PI, 0] });
    outerRoad.push({ url: road, pos: [-OUT, 0, i], rot: [0, R, 0] });
    outerRoad.push({ url: road, pos: [OUT, 0, i], rot: [0, -R, 0] });
  }
  outerRoad.push({ url: '/city/road-corner.glb', pos: [-OUT, 0, -OUT], rot: [0, R, 0] });
  outerRoad.push({ url: '/city/road-corner.glb', pos: [OUT, 0, -OUT], rot: [0, 0, 0] });
  outerRoad.push({ url: '/city/road-corner.glb', pos: [OUT, 0, OUT], rot: [0, -R, 0] });
  outerRoad.push({ url: '/city/road-corner.glb', pos: [-OUT, 0, OUT], rot: [0, Math.PI, 0] });
  // four spokes connecting the inner ring to the outer one
  for (let i = 5; i <= OUT - 1; i++) {
    outerRoad.push({ url: '/city/road-straight.glb', pos: [0, 0, -i], rot: [0, R, 0] });
    outerRoad.push({ url: '/city/road-straight.glb', pos: [0, 0, i], rot: [0, R, 0] });
    outerRoad.push({ url: '/city/road-straight.glb', pos: [-i, 0, 0], rot: [0, 0, 0] });
    outerRoad.push({ url: '/city/road-straight.glb', pos: [i, 0, 0], rot: [0, 0, 0] });
  }
  outerRoad.push({ url: '/city/road-intersection.glb', pos: [0, 0, -OUT] });
  outerRoad.push({ url: '/city/road-intersection.glb', pos: [0, 0, OUT] });
  outerRoad.push({ url: '/city/road-intersection.glb', pos: [-OUT, 0, 0] });
  outerRoad.push({ url: '/city/road-intersection.glb', pos: [OUT, 0, 0] });

  // houses lining the outer streets (deterministic variety, both sides)
  const KINDS = [`${B}a.glb`, `${B}b.glb`, `${B}c.glb`, `${B}d.glb`, '/city/building-garage.glb'];
  const outerBlocks: Array<{ url: string; pos: [number, number, number]; rot?: [number, number, number] }> = [];
  let k = 0;
  for (let i = -7; i <= 7; i += 2) {
    if (Math.abs(i) < 2) continue;                       // leave the spokes clear
    outerBlocks.push({ url: KINDS[k++ % 5], pos: [i, 0, -OUT - 1.4], rot: [0, Math.PI, 0] });
    outerBlocks.push({ url: KINDS[k++ % 5], pos: [i, 0, OUT + 1.4], rot: [0, 0, 0] });
    outerBlocks.push({ url: KINDS[k++ % 5], pos: [-OUT - 1.4, 0, i], rot: [0, -R, 0] });
    outerBlocks.push({ url: KINDS[k++ % 5], pos: [OUT + 1.4, 0, i], rot: [0, R, 0] });
    // a second row set back from the street, so the town has depth
    if (i % 4 === 1) {
      outerBlocks.push({ url: KINDS[k++ % 5], pos: [i + 1, 0, -OUT - 3.2], rot: [0, Math.PI, 0] });
      outerBlocks.push({ url: KINDS[k++ % 5], pos: [-OUT - 3.2, 0, i + 1], rot: [0, -R, 0] });
    }
  }

  // greenery: between the two rings, and scattered through the outer town
  const greens: Array<[number, number, string]> = [
    [-6.5, -3, 'grass-trees'], [-6.5, 0, 'grass-trees-tall'], [-6.5, 4, 'grass-trees'],
    [6.5, -3.5, 'grass-trees-tall'], [6.5, -0.5, 'grass-trees'], [6.5, 3.5, 'grass-trees'],
    [-3.5, 6.5, 'grass-trees'], [2.5, 6.5, 'grass-trees-tall'], [3.8, 6.5, 'grass-trees'],
    [-4, -6.8, 'grass-trees'], [2.2, -6.8, 'grass-trees'], [4.2, -6.8, 'grass-trees-tall'],
    [-7.6, -7.6, 'grass-trees'], [7.6, 7.6, 'grass-trees'], [7.6, -7.6, 'grass-trees-tall'], [-7.6, 7.6, 'grass-trees'],
    [-11, -4, 'grass-trees'], [11, 4, 'grass-trees-tall'], [-11, 5, 'grass'], [11, -5, 'grass'],
    [-4, -11.5, 'grass-trees'], [4.5, 11.5, 'grass-trees'], [-9, 11.5, 'grass'], [9, -11.5, 'grass'],
    [12.5, 0, 'grass'], [-12.5, 0, 'grass'], [0, 12.5, 'grass-trees'], [0, -12.5, 'grass'],
  ];

  return (
    <>
      {/* ground — covers the whole town, not just the plaza */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#cfd8ae" />
      </mesh>
      {pavement.map(([x, z], i) => (
        <Prop key={`p${i}`} url="/city/pavement.glb" position={[x, 0, z]} />
      ))}
      <Prop url="/city/pavement-fountain.glb" position={[0, 0, 0]} />
      {ring.map((r, i) => (
        <Prop key={`r${i}`} url={r.url} position={r.pos} rotation={r.rot} />
      ))}
      {blocks.map((b, i) => (
        <Prop key={`b${i}`} url={b.url} position={b.pos} rotation={b.rot} />
      ))}
      {greens.map(([x, z, kind], i) => (
        <Prop key={`g${i}`} url={`/city/${kind}.glb`} position={[x, 0, z]} />
      ))}
      {agents.map((a) => (
        <Agent key={a.name} agent={a} posRef={posRef} />
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

/** Keeps the camera trailing the agent you're driving. */
function FollowCam({ name, posRef }: { name: string; posRef: RefObject<LivePos[]> }) {
  const { camera } = useThree();
  useFrame(() => {
    const p = posRef.current?.find((m) => m.name === name);
    if (!p) return;
    const tx = map(p.x), tz = map(p.y);
    _v.set(tx + 4.5, 4.2, tz + 4.5);
    camera.position.lerp(_v, 0.06);
    camera.lookAt(tx, 0.4, tz);
  });
  return null;
}

export default function Plaza3D({ agents, posRef, npcs = [], onNpc, follow }: { agents: Mover3D[]; posRef: RefObject<LivePos[]>; npcs?: Npc3D[]; onNpc?: (id: string) => void; follow?: string }) {
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [6.4, 5.4, 6.4], fov: 36 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#f2e8d0']} />
      <hemisphereLight args={['#fff6e0', '#b9a97e', 0.7]} />
      <directionalLight position={[8, 13, 5]} intensity={1.25} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-far={34} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={12} shadow-camera-bottom={-12} />
      <Suspense fallback={null}>
        <Scene agents={agents} posRef={posRef} npcs={npcs} onNpc={onNpc} />
        {follow && <FollowCam name={follow} posRef={posRef} />}
        <ContactShadows position={[0, 0.015, 0]} opacity={0.28} scale={22} blur={2} far={8} />
      </Suspense>
      {!follow && <OrbitControls enablePan={false} minPolarAngle={0.45} maxPolarAngle={1.15} minDistance={6} maxDistance={16} target={[0, 0.3, 0]} makeDefault />}
    </Canvas>
  );
}

useGLTF.preload('/city/pavement.glb');
useGLTF.preload('/city/pavement-fountain.glb');
