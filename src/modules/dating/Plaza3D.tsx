import { Canvas, useFrame } from '@react-three/fiber';
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
export interface LivePos { name: string; x: number; y: number }
export interface Mover3D {
  name: string;
  look: DatingLook;
  you: boolean;
  x: number;   // snapshot for initial placement (before useFrame's first tick)
  y: number;
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
  const inited = useRef(false);
  useFrame(() => {
    const p = posRef.current?.find((m) => m.name === agent.name);
    if (!p || !g.current) return;
    _v.set(map(p.x), 0, map(p.y));
    if (inited.current) g.current.position.lerp(_v, 0.16);
    else { g.current.position.copy(_v); inited.current = true; }
  });
  return (
    <group ref={g} position={[map(agent.x), 0, map(agent.y)]}>
      <Clone object={scene} scale={AGENT_SCALE} castShadow />
      {agent.you && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.34, 0.44, 24]} />
          <meshBasicMaterial color="#e0b53a" />
        </mesh>
      )}
      <Html position={[0, 1.15 + tagLift(agent.name), 0]} center distanceFactor={12} zIndexRange={[10, 0]}>
        <div className={`dt3d-tag ${agent.you ? 'you' : ''}`}>{agent.name}</div>
      </Html>
      {agent.bubble && (
        <Html position={[0, 1.72 + tagLift(agent.name), 0]} center distanceFactor={11} zIndexRange={[20, 0]}>
          <div className={`dt3d-bubble ${agent.bubble.kind}`}>{agent.bubble.text}</div>
        </Html>
      )}
    </group>
  );
}

const R = Math.PI / 2;   // one quarter turn

function Scene({ agents, posRef }: { agents: Mover3D[]; posRef: RefObject<LivePos[]> }) {
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

  // greenery filling the corners and the gaps behind the blocks
  const greens: Array<[number, number, string]> = [
    [-6.5, -3, 'grass-trees'], [-6.5, 0, 'grass-trees-tall'], [-6.5, 4, 'grass-trees'],
    [6.5, -3.5, 'grass-trees-tall'], [6.5, -0.5, 'grass-trees'], [6.5, 3.5, 'grass-trees'],
    [-3.5, 6.5, 'grass-trees'], [0, 6.5, 'grass-trees-tall'], [3.8, 6.5, 'grass-trees'],
    [-4, -6.8, 'grass-trees'], [0.5, -6.8, 'grass-trees'], [4.2, -6.8, 'grass-trees-tall'],
    [-7.5, -6, 'grass'], [7.5, 6, 'grass'], [7.5, -6.5, 'grass'], [-7.5, 6.5, 'grass'],
  ];

  return (
    <>
      {/* ground — sized to the block, so there's no empty desert around it */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[26, 26]} />
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
    </>
  );
}

export default function Plaza3D({ agents, posRef }: { agents: Mover3D[]; posRef: RefObject<LivePos[]> }) {
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [6.4, 5.4, 6.4], fov: 36 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#f2e8d0']} />
      <hemisphereLight args={['#fff6e0', '#b9a97e', 0.7]} />
      <directionalLight position={[8, 13, 5]} intensity={1.25} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-far={34} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={12} shadow-camera-bottom={-12} />
      <Suspense fallback={null}>
        <Scene agents={agents} posRef={posRef} />
        <ContactShadows position={[0, 0.015, 0]} opacity={0.28} scale={22} blur={2} far={8} />
      </Suspense>
      <OrbitControls enablePan={false} minPolarAngle={0.45} maxPolarAngle={1.15} minDistance={6} maxDistance={16} target={[0, 0.3, 0]} makeDefault />
    </Canvas>
  );
}

useGLTF.preload('/city/pavement.glb');
useGLTF.preload('/city/pavement-fountain.glb');
