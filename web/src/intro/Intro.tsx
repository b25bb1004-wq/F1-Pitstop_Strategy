/* Loading sequence: the five start lights fill as data loads, the car materialises from a blueprint,
 * then a random hold, lights out, launch. Skippable; reduced motion gets a plain fade. */
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Vignette } from "@react-three/postprocessing";
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
    // fit ~6.4 units of car into ~72% of the frame width (closer framing on tall screens)
    const fit = 6.4 / 0.72 / (2 * Math.tan(THREE.MathUtils.degToRad(api.fov.current) / 2) * Math.max(Math.min(aspect, 2.1), 0.75));
    const dist = Math.max(fit, 7) - api.dolly.current;
    const drift = Math.sin(clock.elapsedTime * 0.25) * 0.25;
    const shake = api.shake.current;
    cam.position.set(look.x + dir.x * dist + drift + (Math.random() - 0.5) * shake, look.y + dir.y * dist + (Math.random() - 0.5) * shake, look.z + dir.z * dist);
    cam.lookAt(look.x + api.follow.current, look.y, look.z);
    if (cam.fov !== api.fov.current) { cam.fov = api.fov.current; cam.updateProjectionMatrix(); }
  });
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
  const ca = useRef<any>(null);
  const t0 = useRef(performance.now());
  const skip = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const launched = useRef(false);
  const api = useRef({
    camera: null as any, reveal: { current: 0 }, target: { current: 0 }, spin: { current: 0 }, speed: { current: 0 },
    shake: { current: 0 }, dolly: { current: 0 }, follow: { current: 0 }, fov: { current: 32 },
  }).current;

  const carLoaded = progress[3] >= 1;
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!carLoaded) return;
    if (reduced) { api.reveal.current = 1; setRevealed(true); return; }
    const tw = gsap.to(api.reveal, { current: 1, duration: seen ? 0.9 : 1.9, ease: "power2.inOut", delay: 0.15, onComplete: () => setRevealed(true) });
    return () => { tw.kill(); };
  }, [carLoaded]);

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
    tl.to(api.spin, { current: 90, duration: 1.0, ease: "power2.in" }, 0)
      .to(api.speed, { current: 75, duration: 0.95, ease: "power2.in" }, 0)
      .to(api.shake, { current: 0.05, duration: 0.5, ease: "power1.in" }, 0.1)
      .to(api.fov, { current: 42, duration: 1.0, ease: "power3.in" }, 0)
      .to(api.dolly, { current: 2.2, duration: 1.0, ease: "power3.in" }, 0)
      .to(api.follow, { current: 3.5, duration: 1.1, ease: "power3.in" }, 0.1)
      .to(car.current!.position, { x: 16, duration: 1.15, ease: "power4.in" }, 0.05)
      .to(ca.current ? ca.current.offset : {}, { x: 0.006, y: 0.002, duration: 0.8, ease: "power2.in" }, 0.2)
      .to(flash.current, { opacity: 1, duration: 0.16, ease: "power2.in" }, 0.82)
      .to(root.current, { clipPath: "inset(0 0 100% 0)", duration: 0.55, ease: "power4.inOut" }, 1.0);
  };

  // sequence: all lights lit + data ready + minimum show time -> random hold -> lights out
  useEffect(() => {
    if (phase !== "loading" || !ready || !lit.every(Boolean) || !revealed) return;
    const minShow = skip.current ? 0 : seen ? 700 : 2200;
    const wait = Math.max(0, minShow - (performance.now() - t0.current));
    const hold = skip.current ? 0 : 400 + Math.random() * 700;      // real F1: a random delay before lights out
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
        <Studio intensity={0.35 + 0.65 * overall} />
        <group ref={car} position={[-0.3, 0, 0]}>
          {carLoaded && (hasCar()
            ? <CarModel compound="SOFT" reveal={api.reveal} spin={api.spin} jackOnChange={false} hologram />
            : <Car compound="SOFT" reveal={api.reveal} spin={api.spin} jackOnChange={false} />)}
        </group>
        <Streaks speed={api.speed} />
        {FX && <EffectComposer multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={0.55} intensity={1.1} radius={0.7} />
          <ChromaticAberration ref={ca} offset={new THREE.Vector2(0, 0)} radialModulation={false} modulationOffset={0} />
          <Vignette eskil={false} offset={0.2} darkness={0.85} />
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
