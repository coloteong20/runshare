/* Run with: node --test
 *
 * util.js and run.js are plain scripts with no module system (the app has no
 * build step), so we load them by evaluating the source in a sandbox and
 * pulling out the functions we want to exercise.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadSandbox(routeCoords) {
  const ctx = {
    crypto: require('node:crypto').webcrypto,
    routeCoords,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), ctx);

  // Pull only the pure geometry helpers out of run.js — the rest of the file
  // touches Mapbox and Firebase, which do not exist here.
  const runSrc = fs.readFileSync(path.join(root, 'run.js'), 'utf8');
  for (const name of ['nearestPointOnRoute', 'getRemainingDistance', 'walkForwardOnRoute']) {
    const start = runSrc.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `${name} not found in run.js`);
    const end = runSrc.indexOf('\n}\n', start) + 3;
    vm.runInContext(runSrc.slice(start, end), ctx);
  }
  return ctx;
}

test('escapeHtml neutralises a stored-XSS payload in a runner name', () => {
  const ctx = loadSandbox([]);
  const payload = '<img src=x onerror=alert(1)>';
  assert.ok(payload.length <= 30, 'payload fits the 30-char name input');
  const out = ctx.escapeHtml(payload);
  assert.ok(!out.includes('<'), 'no raw angle brackets survive');
  assert.strictEqual(out, '&lt;img src=x onerror=alert(1)&gt;');
});

test('randomId is always full length and never repeats', () => {
  const ctx = loadSandbox([]);
  const seen = new Set();
  for (let i = 0; i < 20000; i++) {
    const id = ctx.randomId();
    assert.strictEqual(id.length, 24, 'constant length (Math.random().toString(36) was not)');
    assert.match(id, /^[0-9a-f]+$/);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 20000, 'no collisions in 20k draws');
});

test('lngScale collapses to 1 at the equator and shrinks with latitude', () => {
  const ctx = loadSandbox([]);
  assert.ok(Math.abs(ctx.lngScale(0) - 1) < 1e-12);
  assert.ok(Math.abs(ctx.lngScale(1.35) - 1) < 0.001, 'Singapore is effectively unscaled');
  assert.ok(Math.abs(ctx.lngScale(51.5) - 0.623) < 0.005, 'London ~0.62');
});

test('nearestPointOnRoute picks the truly nearest segment at London latitude', () => {
  // Two candidate segments from a runner at (51.5, 0):
  //   EAST  segment, 0.010 deg of longitude away  -> 0.69 km on the ground
  //   NORTH segment, 0.008 deg of latitude away   -> 0.89 km on the ground
  // Treating degrees as a flat grid makes NORTH look closer. It is not.
  const LAT = 51.5;
  const route = [
    [0.010, LAT - 0.02], [0.010, LAT + 0.02],   // segment 0: EAST, truly nearest
    [-0.05, LAT + 0.008], [0.05, LAT + 0.008],  // segment 2: NORTH, nearer in raw degrees
  ];
  const ctx = loadSandbox(route);
  const np = ctx.nearestPointOnRoute(LAT, 0);
  assert.strictEqual(np.bestIdx, 0, 'must snap to the EAST segment, not the NORTH one');
});

test('getRemainingDistance shrinks monotonically along the route', () => {
  const route = [[0, 51.5], [0.01, 51.5], [0.02, 51.5], [0.03, 51.5]];
  const ctx = loadSandbox(route);
  const start = ctx.getRemainingDistance(51.5, 0);
  const mid   = ctx.getRemainingDistance(51.5, 0.015);
  const end   = ctx.getRemainingDistance(51.5, 0.03);
  assert.ok(start > mid && mid > end, `expected ${start} > ${mid} > ${end}`);
  assert.ok(end < 0.001, 'at the finish there is nothing left');
});

test('walkForwardOnRoute advances by roughly the distance asked for', () => {
  const route = [[0, 51.5], [0.05, 51.5], [0.1, 51.5]];
  const ctx = loadSandbox(route);
  const [lat, lng] = ctx.walkForwardOnRoute(51.5, 0, 1.0); // 1 km forward
  const moved = ctx.haversineKm(51.5, 0, lat, lng);
  assert.ok(Math.abs(moved - 1.0) < 0.02, `moved ${moved} km, expected ~1.0`);
});

test('walkForwardOnRoute clamps to the finish rather than overshooting', () => {
  const route = [[0, 51.5], [0.01, 51.5]];
  const ctx = loadSandbox(route);
  const [lat, lng] = ctx.walkForwardOnRoute(51.5, 0, 999);
  assert.strictEqual(lat, 51.5);
  assert.ok(Math.abs(lng - 0.01) < 1e-9, 'lands on the last route point');
});
