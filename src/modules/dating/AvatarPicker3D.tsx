import { Canvas } from '@react-three/fiber';
import { useGLTF, Clone, Stage } from '@react-three/drei';
import { Suspense } from 'react';

/**
 * The wizard used to show 40px PNG thumbnails, which were too small to tell a
 * zombie from a bear — and they didn't match the figure that actually walks the
 * plaza. Each swatch is now the real GLB, lit and framed, so what you pick is
 * literally what stands in the town.
 */
function Figure({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <Clone object={scene} />;
}

export function AvatarSwatch({ url, size = 64 }: { url: string; size?: number }) {
  return (
    <Canvas
      style={{ width: size, height: size }}
      camera={{ position: [0, 0.9, 2.6], fov: 30 }}
      dpr={[1, 2]}
      frameloop="demand"          // static preview — render once, then idle
      gl={{ preserveDrawingBuffer: true }}
    >
      <Suspense fallback={null}>
        <Stage intensity={0.5} environment={null} adjustCamera={1.1} shadows={false}>
          <Figure url={url} />
        </Stage>
      </Suspense>
      <ambientLight intensity={0.9} />
      <directionalLight position={[3, 5, 4]} intensity={1.1} />
    </Canvas>
  );
}

export default AvatarSwatch;
