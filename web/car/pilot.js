// The pilot loop: avionics turn sensors into short plain-language reports, Laya judges
// each report, and its answer probabilities set which thrusters fire and how hard.
//
// Laya reads words, not numbers, so the reports carry the meaning ("the left side is
// dipping down") and Laya decides what that means for the thrusters. Each report
// describes where the car will be TUNE.lookahead seconds from now; reacting to the predicted
// attitude is what keeps the corrections from overshooting.
import * as THREE from 'three';
import { THRUSTERS, HOVER, GIMBAL_LIMIT, lowestPoint } from './sim.js';

// Tuning, found by flying hundreds of headless drops (mutable so a test harness can sweep it).
export const TUNE = {
  lookahead: 0.5,   // s
  brake: 3.0,       // m/s², deceleration the safe-speed profile plans for
  touchdown: 1.0,   // m/s, final approach speed
  predictDrop: 0.7, // s, the descent report judges the altitude this far ahead
  brakeGain: 1.4,   // belly thrust change per unit of (brake harder − ease off), as a multiple of hover
  easeGain: 0.4,
  levelDeg: 3,      // within this the car counts as level
  stale: 0.3,       // s without a fresh answer before attitude commands fade out
  fullDeg: 20,      // predicted tilt at which attitude commands reach full strength
  minGain: 0.15,
  tvc: 0.35,        // rad of belly-nozzle swivel at full roll/pitch command
  trim: 0.25,       // rad of belly-nozzle swivel allowed for drift trim when tipped over
  lean: 0.45,       // max lean of vertical thrust against drift when near upright
  spike: 0.8,       // spike-thruster intensity at full roll/pitch command
  sas: 0.3,         // rate damper: attitude command per rad/s of roll / pitch spin (0 = off)
};

// Option keys and wording were checked against laya:* before use (see the probe results).
export const QUESTIONS = {
  roll: {
    type: 'choice',
    instructions: 'Which side of the car is dipping down?',
    criteria: { left: 'The left side', right: 'The right side', even: 'Neither side, the car is level' },
  },
  pitch: {
    type: 'choice',
    instructions: 'Which end of the car is dipping down?',
    criteria: { nose: 'The nose (front)', tail: 'The tail (back)', level: 'Neither end, the car is level' },
  },
  descent: {
    type: 'choice',
    instructions: 'Should the car brake harder or ease off to land safely?',
    criteria: {
      fast: 'Brake harder: it is falling too fast',
      ok: 'Keep the same thrust: it is falling at a safe speed',
      slow: 'Ease off: it is falling too slowly, hovering or rising',
    },
  },
};

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), NOSE = new THREE.Vector3(0, 0, -1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deg = r => (r * 180) / Math.PI;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qp = new THREE.Quaternion();

export const safeSpeed = h => clamp(Math.sqrt(2 * TUNE.brake * Math.max(0, h - 0.3)), TUNE.touchdown, 15);

function predictedQ(car) {
  const angle = car.w.length() * TUNE.lookahead;
  _qp.copy(car.q);
  if (angle > 0) _qp.multiply(_q.setFromAxisAngle(_v.copy(car.w).normalize(), angle));
  return _qp;
}

export function reports(car) {
  const q = predictedQ(car);
  const up = _v.copy(Y).applyQuaternion(q).y;
  const right = _v.copy(X).applyQuaternion(q).y;     // > 0: right side higher, so the left dips
  const nose = _v.copy(NOSE).applyQuaternion(q).y;   // < 0: nose dips
  const inverted = up < 0;

  let roll;
  const low = right > 0 ? 'left' : 'right';
  if (inverted) roll = `The car is upside down and its ${right === 0 ? 'right' : low} side is dipping down.`;
  else if (Math.abs(right) > 0.94) roll = `The car is lying on its ${low} side.`;
  else if (deg(Math.asin(Math.abs(right))) < TUNE.levelDeg) roll = 'The car is level.';
  else roll = `The ${low} side of the car is dipping down${deg(Math.asin(Math.abs(right))) > 25 ? ' a lot' : ''}.`;

  let pitch;
  const end = nose < 0 ? 'nose' : 'tail';
  const pdeg = deg(Math.asin(clamp(Math.abs(nose), 0, 1)));
  if (Math.abs(nose) > 0.94) pitch = `The car is standing on its ${end}.`;
  else if (pdeg < TUNE.levelDeg) pitch = 'The car is level.';
  else if (inverted) pitch = `The car is upside down and its ${end} is dipping down.`;
  else pitch = `The ${end} of the car is dipping down${pdeg > 25 ? ' a lot' : ''}.`;

  // Landing rule: in the last 8 m, don't come down while still tilted or sliding; hover until steady.
  const tilt = deg(Math.acos(clamp(_v.copy(Y).applyQuaternion(car.q).y, -1, 1)));
  const slide = Math.hypot(car.vel.x, car.vel.z);
  const falling = -car.vel.y, h = lowestPoint(car) - Math.max(0, falling) * TUNE.predictDrop;
  const unsteady = h < 8 && (tilt > 8 || slide > 1.5);
  const ratio = falling / (unsteady ? 0.3 : safeSpeed(h));
  const how = ratio > 1.4 ? 'much too fast' : ratio > 1.1 ? 'a bit too fast' : ratio >= 0.7 ? 'at a safe speed' : 'too slowly';
  const descent = `The car is falling ${how}.`;

  return { roll, pitch, descent };
}

// One decision: three single-report questions in parallel (Laya is most reliable when
// the state is one short sentence). Each answer is handed over the moment it arrives,
// so one slow reply never holds back the others.
export function askLaya(rep, post, onAnswer) {
  return Promise.all(Object.keys(QUESTIONS).map(k =>
    post({ state: rep[k], questions: { q: QUESTIONS[k] } })
      .then(r => onAnswer(k, r.answers.q.probabilities, r.latency_ms ?? 0))));
}

// The newest answer per question, by when it was asked: replies can arrive out of order.
export const createMemory = () => ({ roll: null, pitch: null, descent: null });
export function remember(mem, key, probs, asked) {
  if (!mem[key] || asked > mem[key].asked) mem[key] = { p: probs, asked };
}

function gains(car) {
  const q = predictedQ(car);
  const g = y => clamp(deg(Math.asin(clamp(Math.abs(y), 0, 1))) / TUNE.fullDeg, TUNE.minGain, 1);
  const upY = _v.copy(Y).applyQuaternion(q).y;
  if (upY < 0) return { roll: 1, pitch: 1 };   // upside down: always full strength
  return { roll: g(_v.copy(X).applyQuaternion(q).y), pitch: g(_v.copy(NOSE).applyQuaternion(q).y) };
}


// Laya's probabilities → each thruster's intensity (0..1) and nozzle swivel.
// Roll / pitch: the spike thrusters on the side or end Laya says is dipping push it
// back up, and the belly nozzles swivel to add torque the same way (thrust-vector
// control, like a rocket). Descent: "brake harder" minus "ease off" sets belly thrust
// above or below hover.
//
// Belly thrust stays close to the body axis on purpose: swivelling it all the way to
// vertical when the car is tipped acts below the centre of mass and rolls the car further over.
export function fly(car, mem, now) {
  if (!mem.roll || !mem.pitch || !mem.descent) {
    for (const s of car.thr) { s.cmd = 0; s.ta = 0; s.tb = 0; }
    return;
  }
  // An old attitude answer may no longer be true, so its effect fades out.
  const fresh = k => clamp(1 - (now - mem[k].asked - TUNE.stale) / TUNE.stale, 0, 1);
  // Laya says which side / end is dipping and how sure it is; the gain schedule scales that
  // by how far the car is predicted to tip (gentle near level, full beyond TUNE.fullDeg).
  const g = gains(car);
  const R = mem.roll.p, P = mem.pitch.p, D = mem.descent.p;
  const layaRoll = (R.left - R.right) * fresh('roll') * g.roll;     // > 0: lift the left side
  const layaPitch = (P.nose - P.tail) * fresh('pitch') * g.pitch;   // > 0: lift the nose
  // Stability augmentation, as on real aircraft: resist spin (never levels the car by itself),
  // so a late answer from Laya doesn't let the rotation run away.
  const roll = clamp(layaRoll + TUNE.sas * car.w.z, -1, 1);
  const pitch = clamp(layaPitch - TUNE.sas * car.w.x, -1, 1);
  const s = (D.fast - D.slow) * fresh('descent');   // a stale answer fades to "hold this speed"
  const upY = _v.copy(Y).applyQuaternion(car.q).y;

  // Belly nozzle aim (geometry, not judgement), blended by how upright the car is:
  // near upright, swivel so thrust stays vertical with a lean against drift and toward
  // the pad; tipped over, keep thrust along the body (see note above) and only trim.
  const tx = clamp(-0.08 * car.vel.x - 0.02 * (car.pos.x - car.pad.x), -TUNE.lean, TUNE.lean);
  const tz = clamp(-0.08 * car.vel.z - 0.02 * (car.pos.z - car.pad.z), -TUNE.lean, TUNE.lean);
  const inv = _q.copy(car.q).invert();
  const vert = _v.set(tx, 1, tz).normalize().applyQuaternion(inv);
  const vertA = Math.asin(clamp(vert.z, -1, 1)), vertB = clamp(Math.atan2(-vert.x, vert.y), -GIMBAL_LIMIT, GIMBAL_LIMIT);
  const trim = _v.set(tx, 0, tz).applyQuaternion(inv);
  const trimA = clamp(Math.asin(clamp(trim.z, -1, 1)), -TUNE.trim, TUNE.trim);
  const trimB = clamp(Math.asin(clamp(-trim.x, -1, 1)), -TUNE.trim, TUNE.trim);
  const w = clamp((upY - 0.707) / 0.159, 0, 1);   // 1 below 30° of tilt, 0 beyond 45°
  const aimA = w * vertA + (1 - w) * trimA, aimB = w * vertB + (1 - w) * trimB;

  // Body-aligned thrust lifts less when tilted, so push harder; past ~75° it can't help, so cut it.
  const tiltComp = upY > 0.25 ? w + (1 - w) / Math.max(upY, 0.6) : 0;
  const lift = clamp(HOVER * (1 + (s > 0 ? TUNE.brakeGain : TUNE.easeGain) * s) * tiltComp, 0, 1);

  car.thr.forEach((st, i) => {
    const d = THRUSTERS[i], att = -d.side * roll + d.end * pitch;
    if (d.kind === 'belly') {
      st.cmd = clamp(lift + 0.12 * att, 0, 1);
      st.ta = clamp(aimA - TUNE.tvc * pitch, -GIMBAL_LIMIT, GIMBAL_LIMIT);
      st.tb = clamp(aimB + TUNE.tvc * roll, -GIMBAL_LIMIT, GIMBAL_LIMIT);
    } else {
      st.cmd = clamp(TUNE.spike * att, 0, 1);
      st.ta = 0;
      st.tb = clamp(-0.6 * car.w.y * d.end, -0.5, 0.5);   // tilt sideways against yaw spin
    }
  });
}
