/* What the race engineer says, at three depths. Rookie: no jargon. Fan: racing language.
 * Engineer: the maths and the evidence. */
export type Profile = "rookie" | "fan" | "engineer";
type Depth = Record<Profile, string>;

export const PROFILES: { id: Profile; title: string; blurb: string }[] = [
  { id: "rookie", title: "New to F1", blurb: "Explain pit stops and tyres from zero." },
  { id: "fan", title: "I watch every race", blurb: "Talk strategy like the pit wall does." },
  { id: "engineer", title: "I build models", blurb: "Show me the maths and the validation." },
];
export const GOALS = [
  { id: "strategy", title: "Make a pit call" },
  { id: "races", title: "Replay real races" },
  { id: "whatif", title: "Test a what-if" },
];

export type Step = { id: string; view: string; target?: string; title: string; body: Depth; task?: { event: string; value?: string; text: Depth } };

export const STEPS: Step[] = [
  {
    id: "call", view: "wall", target: '[data-explain="call"]', title: "This is the call",
    body: {
      rookie: "Tyres get slower every lap, and a pit stop for fresh ones costs about 20 seconds. The pit wall's job is deciding the exact lap where fresh tyres win back more than the stop costs. This panel is that decision, live.",
      fan: "Box or stay out, with the expected time gain and how many of 30 refitted models agree. Undercuts, Safety Car gambles and the two-compound rule are all in it.",
      engineer: "A stochastic dynamic programme over the remaining laps. State is (compound, tyre age, two-compound rule met, track status), green/SC/VSC follows a per-circuit Markov chain, and agreement comes from 30 race-bootstrap refits of the tyre model.",
    },
    task: { event: "wall:status", value: "sc", text: {
      rookie: "Bring out a Safety Car: press SC under Track status and watch the call change.",
      fan: "Throw an SC and see if it's a cheap stop.",
      engineer: "Set track status to SC: the pit-loss term drops and the policy flips.",
    } },
  },
  {
    id: "garage", view: "wall", target: ".garage", title: "The car on your pit wall",
    body: {
      rookie: "The rings on the tyres show the compound: red soft (fast, wears quickly), yellow medium, white hard (slow but lasts). When the call is BOX, the car jacks up and swaps to the new set.",
      fan: "Compound rings and a pit-stop jack animation. Spin it with your mouse, and tap the numbered hotspots for the technical detail.",
      engineer: "A real F1-75 model, de-branded and re-liveried by a shader in car space. Wheels are re-pivoted from the mesh clusters so they spin and swap compound live.",
    },
    task: { event: "wall:compound", value: "HARD", text: { rookie: "Put hard tyres on the car.", fan: "Fit the hards.", engineer: "Set compound = HARD." } },
  },
  {
    id: "tower", view: "theatre", target: ".lb", title: "Every 2025 race, replayed",
    body: {
      rookie: "Real cars, real timing. Open the leaderboard for the running order. The red bar next to each driver is how strongly the model expects that team to pit this lap.",
      fan: "A live leaderboard with the model's P(box) for each car against the stops they actually made. Watch the bars rise before a stop.",
      engineer: "Each bar is the pit-call classifier's probability (ROC-AUC 0.876 on 2025), computed only from information available before the lap.",
    },
    task: { event: "theatre:follow", text: { rookie: "Open the leaderboard and pick a driver to ride with.", fan: "Pick a driver from the leaderboard.", engineer: "Select a driver from the leaderboard." } },
  },
  {
    id: "cams", view: "theatre", target: ".modes", title: "Pick your shot",
    body: {
      rookie: "Director films it like television: a trackside camera on every corner, then chase or aerial shots on the straights. Chase, TV and Heli let you pick one camera yourself.",
      fan: "Director cuts at every braking zone to a long-lens camera on the outside of the corner, with a caption for the apex speed and gear. The front wheels steer and the car brakes where the real driver did.",
      engineer: "Corners are detected from braking zones in the fastest-lap speed trace (plus curvature for flat-out sweepers). Every rig is a smooth function of a damped, roll-free pose; front-wheel angle is atan(wheelbase x curvature).",
    },
    task: { event: "theatre:mode", value: "tv", text: { rookie: "Try the TV camera.", fan: "Switch to TV.", engineer: "Set camera = TV." } },
  },
  {
    id: "onboard", view: "onboard", target: '[data-explain="hud"]', title: "Ride the fastest lap",
    body: {
      rookie: "This is the quickest lap of the race at this track. The big number is speed, the box is the gear, green and red bars are throttle and brake.",
      fan: "Real telemetry: speed, gear, rev lights, throttle, brake and DRS, synced to the car on the track. The brakes glow where the driver brakes.",
      engineer: "Telemetry resampled by distance fraction onto the same 360 points as the circuit outline, so the HUD, the traces and the 3D car share one index.",
    },
    task: { event: "onboard:mode", text: { rookie: "Switch the camera view.", fan: "Change the camera.", engineer: "Change camera mode." } },
  },
  {
    id: "whatif", view: "whatif", target: ".ask", title: "Ask what if",
    body: {
      rookie: "Type a question like 'What if Norris pitted 3 laps earlier at Monza?'. Pitwall reruns that race and races the real car against the what-if one.",
      fan: "Move stops, swap compounds, remove or add a Safety Car, or hand the strategy to the optimiser. The result is a full rerun, not a guess.",
      engineer: "A counterfactual simulator: real clean pace plus modelled tyre and pit deltas, applied as differences to the real clocks, with Safety Cars as queue events.",
    },
    task: { event: "whatif:run", text: { rookie: "Run any question, or tap an example.", fan: "Run one.", engineer: "Execute a scenario." } },
  },
  {
    id: "proof", view: "proof", target: ".hero-stats", title: "Why you can trust it",
    body: {
      rookie: "Everything here was learned from 2021-2024 and then tested once on all of 2025, races it had never seen.",
      fan: "Fitted on 2021-23, tuned on 2024, scored once on every 2025 race. The tables show where it beats simple approaches and where it doesn't.",
      engineer: "Whole-season splits, thresholds frozen on dev, and a leakage audit: a classifier given the current lap's time matches published per-lap scores, while the honest one is far lower.",
    },
  },
];

export const EXPLAIN: Record<string, { title: string } & Depth> = {
  call: { title: "The pit wall call", rookie: "Box means pit now for fresh tyres. Stay out means keep going. The number is how many seconds the call is worth.", fan: "Expected race-time gain of the call, plus model agreement across 30 refits.", engineer: "V_stay minus V_pit from backward induction; P(pit) from bootstrap refits of the degradation model." },
  ring: { title: "Model agreement", rookie: "How sure the model is: 30 slightly different versions vote.", fan: "Bootstrap agreement. Under 70% means it's a close call.", engineer: "Share of 30 race-resampled refits whose policy matches at this state." },
  strip: { title: "Strategy from here", rookie: "The rest of the race: each coloured block is a set of tyres, and the red lines are the pit stops.", fan: "The optimal plan, following the policy assuming green running.", engineer: "Forward roll-out of the optimal policy with track state fixed to green." },
  window: { title: "Pit window", rookie: "How much time you'd lose by stopping on each lap instead of the best lap. Purple is the best lap.", fan: "Cost of committing to each stop lap. Purple is optimal, green within 0.5 s.", engineer: "Committed-stop values under green running; it ignores SC option value, which is why the plan can stop later." },
  garage: { title: "The car", rookie: "A real F1 car model, painted in Pitwall colours. Tyre rings show the compound.", fan: "Drag to rotate, and tap the numbered hotspots.", engineer: "CC-BY-NC Ferrari F1-75 mesh, 284k triangles after simplification, de-branded, with a livery shader in car space." },
  tower: { title: "Leaderboard", rookie: "The running order. Bars show how likely each car is to pit this lap.", fan: "P(box) per car, PIT when they actually pit; the card on the left follows your driver.", engineer: "Pit-call classifier probabilities with leak-free features from lap n-1." },
  hud: { title: "Driver HUD", rookie: "Speed, gear, throttle (green) and brake (red).", fan: "Rev lights, DRS and live telemetry from the real lap.", engineer: "FastF1 car_data merged with position data, resampled by distance." },
  traces: { title: "Telemetry traces", rookie: "The whole lap as graphs: speed dips are corners, red is braking.", fan: "Speed, throttle/brake and gear on one distance axis. Hover anywhere.", engineer: "Small multiples sharing x; no dual axes." },
  onboard: { title: "Onboard", rookie: "Ride along the fastest lap.", fan: "T-cam, chase or trackside TV.", engineer: "Speed-profile-mapped motion on a smoothed CatmullRom centreline with true elevation." },
  "whatif-ask": { title: "Ask in plain English", rookie: "Type your question; Pitwall shows what it understood before running.", fan: "Stops, compounds, Safety Cars, temperature, pit speed or the optimiser.", engineer: "Deterministic parser; anything it can't place is reported, never guessed." },
  "whatif-understood": { title: "Understood as", rookie: "Check and fix what Pitwall understood.", fan: "Edit the race, driver and changes before running.", engineer: "The exact scenario passed to the simulator." },
  "whatif-stage": { title: "Live rerun", rookie: "The coloured car is what really happened. The white car is the what-if.", fan: "The real car against its twin, with the live gap.", engineer: "Both clocks come from the simulator; the field uses re-simulated clocks when the race itself changes." },
  "whatif-verdict": { title: "The verdict", rookie: "Where the driver would have finished.", fan: "Finishing position and time change.", engineer: "Positions by elapsed time at the driver's final lap; traffic not modelled." },
  "whatif-positions": { title: "Position by lap", rookie: "Blue is the real race, red the what-if. Higher is better.", fan: "Lap-by-lap order, real vs what-if.", engineer: "Rank of each clock at each lap completion." },
  "whatif-gap": { title: "Time difference", rookie: "Below zero means the what-if driver is ahead of where they really were.", fan: "Cumulative gain or loss vs reality.", engineer: "cf clock minus real clock per lap." },
};
