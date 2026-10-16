// Headless flight test for the Laya-piloted flying car.
//   MODE=table (default): Laya's recorded answers, replayed with real recorded request latencies, simulated time.
//   MODE=ideal: perfect answers, same latency replay.
//   MODE=laya: real Laya over the LAN, real time.
// Options: N, SEED, WRONG (chance an attitude answer is flipped), SLOW (latency multiplier), TUNE (JSON), QUIET, LOG.
import fs from 'fs';
import { createCar, spawn, step, lowestPoint, tiltDeg } from '../web/car/sim.js';
import { reports, askLaya, fly, createMemory, remember, TUNE } from '../web/car/pilot.js';

const env = process.env, MODE = env.MODE || 'table', N = +(env.N || 40), SEED = +(env.SEED || 1);
const WRONG = +(env.WRONG || 0), SLOW = +(env.SLOW || 1);
if (env.TUNE) Object.assign(TUNE, JSON.parse(env.TUNE));

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = mulberry(SEED), noise = mulberry(SEED + 99);

const TABLE = JSON.parse(fs.readFileSync(new URL('./laya_table.json', import.meta.url)));
const LAT = JSON.parse(fs.readFileSync(new URL('./latencies_req.json', import.meta.url)));
let latIdx = Math.floor(noise() * LAT.length);
const nextLatency = () => LAT[latIdx++ % LAT.length] * SLOW;   // replay the real sequence, bursts included

function ideal(key, rep) {
  const one = (a, b, c) => rep.includes(a) ? { [a]: .8, [b]: .1, [c]: .1 } : rep.includes(b) ? { [a]: .1, [b]: .8, [c]: .1 } : { [a]: .1, [b]: .1, [c]: .8 };
  if (key === 'roll') return one('left', 'right', 'even');
  if (key === 'pitch') return one('nose', 'tail', 'level');
  return rep.includes('much') ? { fast: .85, ok: .1, slow: .05 } : rep.includes('bit') ? { fast: .45, ok: .45, slow: .1 }
    : rep.includes('safe') ? { fast: .1, ok: .8, slow: .1 } : { fast: .05, ok: .25, slow: .7 };
}
function answer(key, rep) {
  let p = MODE === 'table' ? TABLE[key][rep] ?? ideal(key, rep) : ideal(key, rep);
  if (key !== 'descent' && noise() < WRONG) { const [a, b, c] = Object.keys(p); p = { [a]: p[b], [b]: p[a], [c]: p[c] }; }
  return p;
}
const post = body => fetch('http://localhost:8000/api/systemone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const DT = 1 / 240, LIMIT = 90, FLY_HZ = 60;
async function episode(i) {
  const car = spawn(createCar(), rand), h0 = car.pos.y, tilt0 = tiltDeg(car);
  const mem = createMemory(), log = [];
  let inFlight = 0, lastAsk = -1, lastFly = -1, answered = 0, arrivals = [];
  const start = performance.now();
  const now = () => (MODE === 'laya' ? (performance.now() - start) / 1000 : car.t);

  while (!car.landed && car.t < LIMIT) {
    const t = now();
    if (inFlight < 3 && t - lastAsk >= 0.04) {
      lastAsk = t; inFlight++;
      const asked = t, rep = reports(car);
      if (MODE === 'laya') {
        askLaya(rep, post, (k, p) => { remember(mem, k, p, asked); answered++; if (env.LOG) log.push({ asked, k, rep: rep[k], p }); })
          .catch(e => console.error('ERR', e.message)).finally(() => inFlight--);
      } else {
        const lats = Object.keys(mem).map(k => ({ k, at: asked + nextLatency(), p: answer(k, rep[k]) }));
        arrivals.push(...lats.map(x => ({ ...x, asked })));
        arrivals.push({ done: Math.max(...lats.map(x => x.at)) });
      }
    }
    if (MODE !== 'laya') {
      for (const a of arrivals.filter(a => (a.at ?? a.done) <= t)) {
        if (a.done != null) inFlight--; else { remember(mem, a.k, a.p, a.asked); answered++; }
      }
      arrivals = arrivals.filter(a => (a.at ?? a.done) > t);
    }
    if (car.t - lastFly >= 1 / FLY_HZ - 1e-9) { lastFly = car.t; fly(car, mem, t); }
    if (MODE === 'laya') {
      while (car.t < now() && !car.landed) step(car, DT);
      await new Promise(r => setTimeout(r, 4));
    } else step(car, DT);
  }
  const L = car.landed, res = L ? (L.ok ? 'OK ' : 'CRASH') : 'TIMEOUT';
  if (!env.QUIET) console.log(`${String(i).padStart(2)} ${res} h0=${h0.toFixed(0).padStart(3)}m tilt0=${tilt0.toFixed(0).padStart(3)}° t=${car.t.toFixed(1)}s` +
    (L ? ` vz=${L.vertical.toFixed(2)} tilt=${L.tilt.toFixed(1)}° vh=${L.horizontal.toFixed(2)} pad=${L.onPad ? 'Y' : 'n'}` : ` alt=${lowestPoint(car).toFixed(1)}`) +
    ` answers/s=${(answered / 3 / car.t).toFixed(1)}`);
  if (env.LOG) fs.writeFileSync(`log${i}.json`, JSON.stringify(log));
  return L?.ok ? 1 : 0;
}

let ok = 0;
for (let i = 0; i < N; i++) ok += await episode(i);
console.log(`${MODE} wrong=${WRONG} slow=x${SLOW}${env.TUNE ? ' ' + env.TUNE : ''}: ${ok}/${N} landed safely`);
