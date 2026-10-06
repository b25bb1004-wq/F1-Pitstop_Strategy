/* Shared 3D staging: studio lighting with amber rim, reflective floor, speed streaks, post FX. */
import * as THREE from "three";
import { Suspense, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, MeshReflectorMaterial } from "@react-three/drei";

const HDRI = import.meta.env.BASE_URL + "hdr/studio_small_08_1k.hdr";

export function Studio({ floor = true, intensity = 1, hdri = false }: { floor?: boolean; intensity?: number; hdri?: boolean }) {
  return (
    <>
      <color attach="background" args={["#030305"]} />
      <fog attach="fog" args={["#030305", 9, 26]} />
      <ambientLight intensity={0.12 * intensity} />
      <directionalLight position={[4, 6, 3]} intensity={1.1 * intensity} castShadow shadow-mapSize={[1024, 1024]} />
      <spotLight position={[-6, 3, -4]} angle={0.6} penumbra={1} intensity={60 * intensity} color="#ff8a00" />
      <spotLight position={[6, 2.5, -5]} angle={0.5} penumbra={1} intensity={40 * intensity} color="#ffb547" />
      <pointLight position={[0, 4, 6]} intensity={6 * intensity} color="#ffffff" />
      {hdri ? <Suspense fallback={null}><Environment files={HDRI} environmentIntensity={0.55 * intensity} /></Suspense> : <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.4} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[10, 1.2, 1]} />
        <Lightformer form="rect" intensity={1.4} position={[0, 2, 6]} scale={[8, 0.6, 1]} />
        <Lightformer form="rect" intensity={3} color="#ff9a2e" position={[-6, 1.5, -2]} rotation-y={Math.PI / 2} scale={[6, 0.8, 1]} />
        <Lightformer form="rect" intensity={1.6} color="#ffd59a" position={[6, 1.5, -2]} rotation-y={-Math.PI / 2} scale={[6, 0.5, 1]} />
        <Lightformer form="ring" intensity={1.2} color="#ff2a1f" position={[0, 3, -6]} scale={2} />
      </Environment>}
      {floor && (
        <>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0]} receiveShadow>
            <planeGeometry args={[60, 60]} />
            <MeshReflectorMaterial blur={[300, 80]} resolution={512} mixBlur={1} mixStrength={18} roughness={0.85} depthScale={1}
              minDepthThreshold={0.4} maxDepthThreshold={1.4} color="#07080b" metalness={0.6} mirror={0} />
          </mesh>
          <ContactShadows position={[0, 0.005, 0]} opacity={0.75} scale={9} blur={2.4} far={2} />
        </>
      )}
    </>
  );
}

/* Light streaks rushing past; `speed` is a ref so GSAP can drive it without re-rendering. */
export function Streaks({ speed, count = 140 }: { speed: { current: number }; count?: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const data = useMemo(() => Array.from({ length: count }, () => ({
    x: (Math.random() - 0.5) * 40, y: 0.05 + Math.random() * 2.6, z: (Math.random() - 0.5) * 9 - 1.5,
    len: 0.6 + Math.random() * 2.4, k: 0.6 + Math.random() * 0.9,
  })), [count]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#ffc477", transparent: true, opacity: 0.0, toneMapped: false }), []);
  useFrame((_, dt) => {
    const v = speed.current;
    mat.opacity = Math.min(0.9, v / 30);
    data.forEach((p, i) => {
      p.x -= v * p.k * Math.min(dt, 0.05);
      if (p.x < -20) p.x += 40;
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(p.len * (0.4 + v / 25), 0.012, 0.012);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined as any, undefined as any, count]} material={mat}>
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
}
