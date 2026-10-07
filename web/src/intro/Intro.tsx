/* Loading sequence: the five start lights fill as data loads, the car materialises from a blueprint,
 * then a random hold, lights out, launch. Skippable; reduced motion gets a plain fade. */
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import gsap from "gsap";
import { Car } from "../three/Car";
import { CarModel, hasCar } from "../three/CarModel";
import { Streaks, Studio } from "../three/Scenes";
import { STAGES, reducedMotion } from "../data";
import { Boundary, DPR, FX, hasWebGL } from "../ui/safety";

type Props = { progress: number[]; ready: boolean; error: string | null; onDone: () => void; onRetry: () => void };

function Rig({ api }: { api: any }) {
  const { camera, size, gl } = useThree();
  const look = useMemo(() => new THREE.Vector3(0.2, 0.5, 0), []);
  const dir = useMemo(() => new THREE.Vector3(0.42, 0.16, 1).normalize(), []);
  useEffect(() => { api.camera = camera; gl.localClippingEnabled = true; }, [camera, gl]);
  useFrame(({ clock }) => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / size.height;
    // fit ~6.4 units of car into ~56% of the frame width: room for the lights above and the name below
    const fit = 6.4 / 0.56 / (2 * Math.tan(THREE.MathUtils.degToRad(api.fov.current) / 2) * Math.max(Math.min(aspect, 2.1), 0.75));
    const dist = Math.max(fit, 8.5) - api.dolly.current;
    const t = clock.elapsedTime, drift = Math.sin(t * 0.25) * 0.25;
    // smooth noise, not per-frame random jitter (that read as a glitch)
    const sh = api.shake.current, nx = (Math.sin(t * 37.1) + Math.sin(t * 23.3 + 1.7)) * 0.5 * sh, ny = (Math.sin(t * 29.7 + 0.4) + Math.sin(t * 17.9)) * 0.5 * sh;
    cam.position.set(look.x + dir.x * dist + drift + nx, look.y + dir.y * dist + ny, look.z + dir.z * dist);
    // lights come up smoothly with loading instead of stepping at each stage
    gl.toneMappingExposure += (api.exposure.current - gl.toneMappingExposure) * 0.06;
    cam.lookAt(look.x + api.follow.current, look.y, look.z);
    if (cam.fov !== api.fov.current) { cam.fov = api.fov.current; cam.updateProjectionMatrix(); }
  });
  return null;
}

/* Matte floor with a contact shadow that only appears once the car is solid (the old reflective floor and
 * shadow showed the whole car while it was still a clipped hologram), and fades away as the car launches. */
function IntroFloor({ api }: { api: any }) {
  const cs = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = cs.current;
    if (!g) return;
    const r = api.reveal.current, o = Math.max(0, Math.min(1, (r - 0.82) / 0.18)) * Math.max(0, 1 - api.speed.current / 12);
    g.visible = o > 0.01;
    g.traverse((m: any) => { if (m.isMesh && m.material) m.material.opacity = 0.65 * o; });
  });
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.002, 0]}><circleGeometry args={[16, 64]} /><meshStandardMaterial color="#08080a" roughness={0.92} metalness={0.15} /></mesh>
      <ContactShadows ref={cs as any} position={[0, 0.004, 0]} opacity={0.65} scale={9} blur={2.4} far={2} resolution={512} />
    </>
  );
}

/* Compile the car's shaders before the reveal starts, so the reveal never stutters on its first frames. */
function Warmup({ on, onReady }: { on: boolean; onReady: () => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!on) return;
    let dead = false;
    (async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try { await (gl as any).compileAsync?.(scene, camera); } catch {}
      if (!dead) onReady();
    })();
    return () => { dead = true; };
  }, [on]);
  return null;
}

export default function Intro({ progress, ready, error, onDone, onRetry }: Props) {
  const reduced = reducedMotion();
  const seen = (() => { try { return sessionStorage.getItem("pitwall-intro") === "1"; } catch { return false; } })();
  const lit = progress.map((p) => p >= 1);
  const overall = progress.reduce((a, b) => a + b, 0) / progress.length;
  const [phase, setPhase] = useState<"loading" | "hold" | "out" | "gone">("loading");
  const root = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const car = useRef<THREE.Group>(null);
  const t0 = useRef(performance.now());
  const skip = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const launched = useRef(false);
  const api = useRef({
    camera: null as any, reveal: { current: 0 }, target: { current: 0 }, spin: { current: 0 }, speed: { current: 0 },
    shake: { current: 0 }, dolly: { current: 0 }, follow: { current: 0 }, fov: { current: 32 }, exposure: { current: 0.35 },
  }).current;
  api.exposure.current = 0.35 + 0.65 * overall;

  const carLoaded = progress[3] >= 1;
  const [revealed, setRevealed] = useState(false);
  const [warm, setWarm] = useState(!hasWebGL);
  useEffect(() => {
    if (!carLoaded || !warm) return;
    if (reduced) { api.reveal.current = 1; setRevealed(true); return; }
    const tw = gsap.to(api.reveal, { current: 1, duration: seen ? 1.0 : 2.3, ease: "power2.inOut", delay: 0.1, onComplete: () => setRevealed(true) });
    return () => { tw.kill(); };
  }, [carLoaded, warm]);

  const finish = () => {
    try { sessionStorage.setItem("pitwall-intro", "1"); } catch {}
    setPhase("gone");
    onDone();
  };

  const launch = () => {
    if (launched.current) return;
    launched.current = true;
    clearTimeout(timer.current);
    setPhase("out");
    if (reduced) { gsap.to(root.current, { opacity: 0, duration: 0.4, onComplete: finish }); return; }
    const tl = gsap.timeline({ onComplete: finish });
    tl.to(api.spin, { current: 90, duration: 1.2, ease: "power2.in" }, 0)
      .to(api.speed, { current: 75, duration: 1.15, ease: "power2.in" }, 0)
      .to(api.shake, { current: 0.035, duration: 0.6, ease: "power1.in" }, 0.15)
      .to(api.fov, { current: 40, duration: 1.2, ease: "power3.in" }, 0)
      .to(api.dolly, { current: 2.0, duration: 1.2, ease: "power3.in" }, 0)
      .to(api.follow, { current: 3.2, duration: 1.3, ease: "power3.in" }, 0.1)
      .to(car.current!.position, { x: 16, duration: 1.35, ease: "power4.in" }, 0.05)
      .to(flash.current, { opacity: 0.85, duration: 0.2, ease: "power2.in" }, 1.0)
      .to(root.current, { opacity: 0, duration: 0.45, ease: "power2.inOut" }, 1.2);
  };

  // sequence: all lights lit + data ready + minimum show time -> random hold -> lights out
  useEffect(() => {
    if (phase !== "loading" || !ready || !lit.every(Boolean) || !revealed) return;
    const minShow = skip.current ? 0 : seen ? 800 : 2800;
    const wait = Math.max(0, minShow - (performance.now() - t0.current));
    const hold = skip.current ? 0 : 600 + Math.random() * 700;      // real F1: a random delay before lights out
    setPhase("hold");
    timer.current = window.setTimeout(launch, wait + hold);
  }, [ready, lit.join(), phase, revealed]);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter") doSkip(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  const doSkip = () => {
    skip.current = true;
    if (phase === "hold" && ready) launch();
  };

  if (phase === "gone") return null;
  const lightsOn = phase === "out" ? [false, false, false, false, false] : lit;
  const stageIdx = progress.findIndex((p) => p < 1);
  return (
    <div className="intro" ref={root} role="dialog" aria-label="Loading Pitwall" aria-busy={phase === "loading"}>
      {hasWebGL && <Boundary label="Intro" silent>
      <Canvas shadows={FX} dpr={DPR} camera={{ position: [1.4, 1, 6.6], fov: 30, near: 0.1, far: 80 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
        <Rig api={api} />
        <Studio floor={false} />
        <IntroFloor api={api} />
        <Warmup on={carLoaded} onReady={() => setWarm(true)} />
        <group ref={car} position={[-0.3, 0, 0]}>
          {carLoaded && (hasCar()
            ? <CarModel compound="SOFT" reveal={api.reveal} spin={api.spin} jackOnChange={false} hologram />
            : <Car compound="SOFT" reveal={api.reveal} spin={api.spin} jackOnChange={false} />)}
        </group>
        <Streaks speed={api.speed} />
        {FX && <EffectComposer multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={0.6} intensity={0.9} radius={0.65} />
          <Vignette eskil={false} offset={0.25} darkness={0.8} />
        </EffectComposer>}
      </Canvas>
      </Boundary>}

      <div className="gantry" aria-hidden="true">
        {lightsOn.map((on, i) => (
          <div className="col" key={i}><div className={`lamp ${on ? "on" : ""}`} /><div className={`lamp ${on ? "on" : ""}`} /></div>
        ))}
      </div>
      <div className="brand">
        <h1>Pit<span>wall</span></h1>
        <p aria-live="polite">
          {error ? "Telemetry link lost" : phase === "out" ? <b>Lights out and away we go</b>
            : phase === "hold" ? "Hold…" : stageIdx < 0 ? <>Grid formed <b>100%</b></> : <>{STAGES[stageIdx]} <b>{Math.round(overall * 100)}%</b></>}
        </p>
      </div>
      <div className="flash" ref={flash} />
      {error ? (
        <div className="err"><p>{error}</p><button className="btn" onClick={onRetry}>Retry</button></div>
      ) : (
        <button className="skip" onClick={doSkip}>Skip intro</button>
      )}
    </div>
  );
}
