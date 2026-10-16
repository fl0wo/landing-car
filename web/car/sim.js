// Flying-car rigid-body physics, built on three.js math.
// Body frame: nose points to -z, right is +x, up is +y. The centre of mass is the origin and
// sits at floor level (battery pack in the floor), so the body box is centred BODY.y above it.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export const G = 9.81;
export const MASS = 1200;                       // kg
export const INERTIA = V(2400, 2700, 1100);     // kg·m² about body x (pitch), y (yaw), z (roll)
export const BODY = { w: 1.9, h: 1.1, l: 4.4, y: 0.3 }; // m; y: box centre above the CoM
export const AIR_DRAG = 2.4;                    // N per (m/s)², linear motion
export const SPIN_DRAG = 900;                   // N·m per rad/s, rotation through the air
export const GIMBAL_LIMIT = Math.PI / 2;        // ±90° on each of the two axes: a 180°×180° range
export const GIMBAL_SPEED = Math.PI * 1.5;      // rad/s nozzle slew rate
export const SPOOL = 0.08;                      // s, thrust lag

// Touchdown limits: faster, more tilted or sliding more than this is a crash.
export const SAFE = { vertical: 3, tilt: 15, horizontal: 3 };

// 4 lift thrusters under the belly, 4 attitude thrusters at the tips of the corner spikes.
export const THRUSTERS = [
  { id: 'B-FL', kind: 'belly', pos: V(-0.62, -0.38, -1.35), max: 5500 },
  { id: 'B-FR', kind: 'belly', pos: V(0.62, -0.38, -1.35), max: 5500 },
  { id: 'B-RL', kind: 'belly', pos: V(-0.62, -0.38, 1.35), max: 5500 },
  { id: 'B-RR', kind: 'belly', pos: V(0.62, -0.38, 1.35), max: 5500 },
  { id: 'S-FL', kind: 'spike', pos: V(-1.6, 0.65, -2.0), max: 2500 },
  { id: 'S-FR', kind: 'spike', pos: V(1.6, 0.65, -2.0), max: 2500 },
  { id: 'S-RL', kind: 'spike', pos: V(-1.6, 0.65, 2.0), max: 2500 },
  { id: 'S-RR', kind: 'spike', pos: V(1.6, 0.65, 2.0), max: 2500 },
].map(t => ({ ...t, side: Math.sign(t.pos.x), end: t.pos.z < 0 ? 1 : -1 }));  // side -1 = left, end 1 = front

export const HOVER = (MASS * G) / THRUSTERS.filter(t => t.kind === 'belly').reduce((s, t) => s + t.max, 0);

// Points that can touch the ground: landing-gear feet, body corners, spike tips.
const CONTACTS = [
  ...[-1, 1].flatMap(x => [-1, 1].map(z => V(x * 0.8, -0.6, z * 1.6))),
  ...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => V(x * BODY.w / 2, BODY.y + y * BODY.h / 2, z * BODY.l / 2)))),
  ...THRUSTERS.filter(t => t.kind === 'spike').map(t => t.pos.clone()),
];

const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Nozzle orientation from its two gimbal angles: a about body x, then b about body z.
export function nozzleQuat(a, b, out = new THREE.Quaternion()) {
  return out.setFromAxisAngle(Z, b).multiply(_qa.setFromAxisAngle(X, a));
}
const _qa = new THREE.Quaternion();

export function createCar() {
  return {
    pos: V(0, 50, 0), vel: V(0, 0, 0), q: new THREE.Quaternion(), w: V(0, 0, 0),  // w: body-frame spin, rad/s
    thr: THRUSTERS.map(() => ({ cmd: 0, level: 0, a: 0, b: 0, ta: 0, tb: 0 })),
    t: 0, landed: null, pad: V(0, 0, 0),
  };
}

// Random drop: height, tumble (anything up to upside down), spin and drift.
export function spawn(car, rand = Math.random) {
  const r = (a, b) => a + (b - a) * rand();
  car.pos.set(r(-12, 12), r(30, 120), r(-12, 12));
  car.vel.set(r(-3, 3), r(-6, 2), r(-3, 3));
  const axis = V(r(-1, 1), r(-0.3, 0.3), r(-1, 1)).normalize();
  car.q.setFromAxisAngle(axis, r(0, Math.PI)).premultiply(new THREE.Quaternion().setFromAxisAngle(Y, r(0, 2 * Math.PI)));
  car.w.set(r(-1.2, 1.2), r(-0.8, 0.8), r(-1.2, 1.2));
  for (const s of car.thr) Object.assign(s, { cmd: 0, level: 0, a: 0, b: 0, ta: 0, tb: 0 });
  car.t = 0; car.landed = null;
  return car;
}

export function lowestPoint(car) {
  let min = Infinity;
  for (const c of CONTACTS) min = Math.min(min, _p.copy(c).applyQuaternion(car.q).y);
  return car.pos.y + min;
}

export const tiltDeg = car => THREE.MathUtils.radToDeg(Math.acos(clamp(_p.copy(Y).applyQuaternion(car.q).y, -1, 1)));

const _p = V(0, 0, 0), _f = V(0, 0, 0), _t = V(0, 0, 0), _d = V(0, 0, 0), _c = V(0, 0, 0), _iw = V(0, 0, 0);
const _nq = new THREE.Quaternion(), _dq = new THREE.Quaternion();

export function step(car, dt) {
  car.t += dt;
  if (car.landed) return settle(car, dt);

  _f.set(0, -MASS * G, 0);   // world-frame force
  _t.set(0, 0, 0);           // body-frame torque
  car.thr.forEach((s, i) => {
    const d = THRUSTERS[i], slew = GIMBAL_SPEED * dt;
    s.a = clamp(s.a + clamp(s.ta - s.a, -slew, slew), -GIMBAL_LIMIT, GIMBAL_LIMIT);
    s.b = clamp(s.b + clamp(s.tb - s.b, -slew, slew), -GIMBAL_LIMIT, GIMBAL_LIMIT);
    s.level += (clamp(s.cmd, 0, 1) - s.level) * Math.min(1, dt / SPOOL);
    _d.copy(Y).applyQuaternion(nozzleQuat(s.a, s.b, _nq)).multiplyScalar(s.level * d.max);  // body-frame thrust
    _t.add(_c.crossVectors(d.pos, _d));
    _f.add(_d.applyQuaternion(car.q));
  });
  _f.addScaledVector(car.vel, -AIR_DRAG * car.vel.length());
  _t.addScaledVector(car.w, -SPIN_DRAG);

  // Euler's rigid-body equations in the body frame: I·dw/dt = torque - w × (I·w)
  _iw.set(INERTIA.x * car.w.x, INERTIA.y * car.w.y, INERTIA.z * car.w.z);
  _t.sub(_c.crossVectors(car.w, _iw));
  car.w.x += (_t.x / INERTIA.x) * dt;
  car.w.y += (_t.y / INERTIA.y) * dt;
  car.w.z += (_t.z / INERTIA.z) * dt;

  car.vel.addScaledVector(_f, dt / MASS);
  car.pos.addScaledVector(car.vel, dt);
  const angle = car.w.length() * dt;
  if (angle > 0) car.q.multiply(_dq.setFromAxisAngle(_c.copy(car.w).normalize(), angle)).normalize();

  const low = lowestPoint(car);
  if (low <= 0) touchdown(car, low);
}

function touchdown(car, low) {
  const vertical = -car.vel.y, horizontal = Math.hypot(car.vel.x, car.vel.z), tilt = tiltDeg(car);
  const ok = vertical <= SAFE.vertical && tilt <= SAFE.tilt && horizontal <= SAFE.horizontal;
  const onPad = Math.hypot(car.pos.x - car.pad.x, car.pos.z - car.pad.z) < 6;
  car.landed = { ok, vertical, horizontal, tilt, onPad, t: car.t };
  car.pos.y -= low;
  car.vel.set(0, 0, 0); car.w.set(0, 0, 0);
  for (const s of car.thr) s.cmd = 0;
}

// After touchdown: engines spool down; a good landing settles level onto its gear.
function settle(car, dt) {
  for (const s of car.thr) s.level += (0 - s.level) * Math.min(1, dt / SPOOL);
  if (!car.landed.ok) return;
  const fwd = _p.set(0, 0, -1).applyQuaternion(car.q);
  _nq.setFromAxisAngle(Y, Math.atan2(-fwd.x, -fwd.z));
  car.q.slerp(_nq, Math.min(1, dt * 4));
  car.pos.y -= lowestPoint(car);
}
