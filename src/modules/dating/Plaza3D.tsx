import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Clone, Html, OrbitControls, ContactShadows } from '@react-three/drei';
import { Suspense, useRef } from 'react';
import * as THREE from 'three';
import type { DatingLook } from '../../api';
import { avatar3dUrl, type AgentAppearance } from './agent-avatar';

// the sim positions movers in a 0–100 field; map that onto a PLAZA-wide ground
const PLAZA = 13;
const map = (v: number) => (v / 100 - 0.5) * PLAZA;

export interface Mover3D {
  name: string;
  look: DatingLook;
  you: boolean;
  x: number;
  y: number;
  bubble?: { text: string; kind: 'fight' | 'love' | 'new' };
}

function Prop({ url, position, rotation, scale = 1 }: { url: string; position: [number, number, number]; rotation?: [number, number, number]; scale?: number }) {
  const { scene } = useGLTF(url);
  return <Clone object={scene} position={position} rotation={rotation} scale={scale} castShadow receiveShadow />;
}

function Agent({ mover }: { mover: Mover3D }) {
  const { scene } = useGLTF(avatar3dUrl(mover.look as AgentAppearance));
  const g = useRef<THREE.Group>(null);
  const target = new THREE.Vector3(map(mover.x), 0, map(mover.y));
  useFrame(() => {
    if (g.current) g.current.position.lerp(target, 0.16);
  });
  return (
    <group ref={g} position={[map(mover.x), 0, map(mover.y)]}>
      <Clone object={scene} scale={0.5} castShadow />
      {mover.you && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.42, 0.55, 24]} />
          <meshBasicMaterial color="#e0b53a" />
        </mesh>
      )}
      <Html position={[0, 1.6, 0]} center distanceFactor={11} zIndexRange={[10, 0]}>
        <div className={`dt3d-tag ${mover.you ? 'you' : ''}`}>{mover.name}</div>
      </Html>
      {mover.bubble && (
        <Html position={[0, 2.25, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
          <div className={`dt3d-bubble ${mover.bubble.kind}`}>{mover.bubble.text}</div>
        </Html>
      )}
    </group>
  );
}

function Scene({ movers }: { movers: Mover3D[] }) {
  const pavement: [number, number][] = [];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) pavement.push([x, z]);
  return (
    <>
      {/* park ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#dfcea8" />
      </mesh>
      {/* central paved plaza + fountain */}
      {pavement.map(([x, z], i) => (
        <Prop key={`p${i}`} url="/city/pavement.glb" position={[x, 0, z]} />
      ))}
      <Prop url="/city/pavement-fountain.glb" position={[0, 0, 0]} />
      {/* buildings along the back */}
      <Prop url="/city/building-small-a.glb" position={[-4, 0, -4]} />
      <Prop url="/city/building-small-c.glb" position={[-1.5, 0, -4.5]} />
      <Prop url="/city/building-garage.glb" position={[1.5, 0, -4.5]} rotation={[0, Math.PI, 0]} />
      <Prop url="/city/building-small-d.glb" position={[4, 0, -4]} />
      {/* trees + lightposts around the rim */}
      <Prop url="/city/grass-trees.glb" position={[-4.5, 0, 1.5]} />
      <Prop url="/city/grass-trees-tall.glb" position={[4.5, 0, 0]} />
      <Prop url="/city/grass-trees.glb" position={[4, 0, 3.5]} />
      <Prop url="/city/grass-trees.glb" position={[-4, 0, 4]} />
      <Prop url="/city/road-straight-lightposts.glb" position={[-3, 0, 3]} />
      <Prop url="/city/road-straight-lightposts.glb" position={[3, 0, -2]} rotation={[0, Math.PI / 2, 0]} />
      {movers.map((m) => (
        <Agent key={m.name} mover={m} />
      ))}
    </>
  );
}

export default function Plaza3D({ movers }: { movers: Mover3D[] }) {
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [11, 10, 13], fov: 36 }} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#f2e8d0']} />
      <hemisphereLight args={['#fff6e0', '#b9a97e', 0.7]} />
      <directionalLight position={[9, 15, 6]} intensity={1.25} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-far={40} shadow-camera-left={-15} shadow-camera-right={15} shadow-camera-top={15} shadow-camera-bottom={-15} />
      <Suspense fallback={null}>
        <Scene movers={movers} />
        <ContactShadows position={[0, 0.015, 0]} opacity={0.3} scale={34} blur={2.2} far={12} />
      </Suspense>
      <OrbitControls enablePan={false} minPolarAngle={0.5} maxPolarAngle={1.15} minDistance={9} maxDistance={26} target={[0, 0.6, 0]} makeDefault />
    </Canvas>
  );
}

useGLTF.preload('/city/pavement.glb');
useGLTF.preload('/city/pavement-fountain.glb');
