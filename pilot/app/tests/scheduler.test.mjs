// Week scheduler: hard constraints on every region pack. Run: node --test pilot/app/tests/scheduler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const G = require('../src/engine.js');
const S = require('../src/scheduler.js');
const DATA = require('../../../powerup/data/data.json'); // the six Malibu shutoff circuits
const cfg = new URL('../../../config/', import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL('regions/index.json', cfg)));
const pack = id => JSON.parse(fs.readFileSync(new URL(`regions/${id}.json`, cfg)));
const runs = Object.fromEntries(index.order.map(id => [id, S.compare(G, DATA, pack(id))]));
const EPS = 1e-6;

test('six region packs; LA is real, every other pack is labelled SYNTHETIC', () => {
  assert.deepEqual(index.order, ['la-wildfire', 'au-bushfire', 'guangdong-typhoon', 'japan-typhoon', 'community-battery', 'dod-base-housing']);
  for (const id of index.order) {
    const p = S.validatePack(pack(id));
    if (id === 'la-wildfire') assert.equal(p.provenance, 'REAL');
    else assert.equal(p.provenance, 'SYNTHETIC', id);
    assert.ok(p.grid.hz === 50 || p.grid.hz === 60, id);
    assert.ok(p.hazard.feed && p.tariff.currency && p.shutoff.rule && p.criticalLoads.length, id);
  }
  assert.equal(pack('guangdong-typhoon').grid.hz, 50);
  assert.equal(pack('japan-typhoon').grid.hzEast, 50);
  assert.equal(pack('japan-typhoon').grid.hz, 60);
  assert.throws(() => S.validatePack({ ...pack('au-bushfire'), provenance: 'REAL' }), /SYNTHETIC/);
});

test('3 neighborhoods from the real circuits, nearest the fire first; 7 days hourly', () => {
  const nbs = S.neighborhoods(G, DATA);
  assert.deepEqual(nbs.map(n => n.id), ['near', 'middle', 'far']);
  assert.equal(nbs.flatMap(n => n.circuits).length, 6);
  for (const n of nbs) assert.ok(n.capKW > 0 && n.customers > 0);
  assert.equal(S.H, 168);
  assert.equal(pack('la-wildfire').fleet.capacityKWh, 39.2);
});

for (const id of index.order) {
  const { week } = runs[id];
  test(`${id}: feeder capacity is never exceeded by PowerUP`, () => {
    assert.equal(week.kpis.capViolations, 0);
    for (const nb of week.nbs) for (let h = 0; h < S.H; h++) {
      if (nb.mode[h] === 'form') { assert.equal(nb.grid[h], 0); continue; }
      if (nb.grid[h] > nb.capKW + EPS) assert.ok(nb.ch[h] <= EPS && nb.grid[h] <= nb.uncontrolled[h] + EPS, `${nb.id} h${h}`);
    }
  });
  test(`${id}: state of charge stays between floor and ceiling`, () => {
    const f = week.pack.fleet;
    for (const nb of week.nbs) for (let h = 0; h <= S.H; h++) {
      assert.ok(nb.soc[h] >= nb.energy * f.outageFloorPct / 100 - EPS, `${nb.id} h${h} below the hard floor`);
      assert.ok(nb.soc[h] <= nb.energy * f.ceilingPct / 100 + EPS, `${nb.id} h${h} above the ceiling`);
      if (h < nb.off) assert.ok(nb.soc[h] >= nb.energy * Math.min(f.floorPct, f.startSocPct) / 100 - EPS, `${nb.id} h${h} below the ordinary floor`);
    }
  });
  test(`${id}: critical and Medical Baseline loads are served every hour`, () => {
    assert.equal(week.kpis.criticalHoursServed, week.kpis.criticalHours);
    for (const nb of week.nbs) for (let h = 0; h < S.H; h++) assert.ok(nb.served[h] + EPS >= nb.critical[h], `${nb.id} h${h}`);
  });
  test(`${id}: inverters switch follow → form on grid loss, resync, then follow`, () => {
    for (const nb of week.nbs) {
      assert.equal(nb.mode[nb.off - 1], 'follow');
      assert.equal(nb.mode[nb.off], 'form');
      if (nb.on < S.H) { assert.equal(nb.mode[nb.on], 'resync'); if (nb.on + 1 < S.H) assert.equal(nb.mode[nb.on + 1], 'follow'); }
    }
    assert.ok(week.nbs[0].off <= week.nbs[1].off && week.nbs[1].off <= week.nbs[2].off, 'the neighborhood nearest the fire islands first');
  });
  test(`${id}: the shutoff week earns at least a normal week`, () => {
    assert.ok(week.kpis.net >= week.kpis.normalWeek - EPS, `${week.kpis.net} vs ${week.kpis.normalWeek}`);
  });
  test(`${id}: customer prices are never raised in an emergency`, () => {
    const t = week.pack.tariff;
    for (const nb of week.nbs) for (let h = 0; h < S.H; h++) assert.ok(nb.price[h] <= S.priceAt(t, h) + EPS);
    assert.match(week.rule, /never raised in an emergency/);
  });
}

test('solar charges batteries during the outage', () => {
  const nb = runs['la-wildfire'].week.nbs[0];
  let charged = 0;
  for (let h = nb.off; h < Math.min(S.H, nb.on); h++) charged += nb.ch[h];
  assert.ok(charged > 0);
});

test('flexibility credits are paid for deferred EV, pool and AC load', () => {
  const k = runs['la-wildfire'].week.kpis;
  assert.ok(k.credits > 0 && k.creditByKind.ev > 0);
});

test('funding metrics are computed from runs, not typed into the config', () => {
  const funding = JSON.parse(fs.readFileSync(new URL('funding.json', cfg)));
  assert.doesNotMatch(JSON.stringify(funding.path), /\d{2,}/, 'no numbers in the path config');
  const la = runs['la-wildfire'].week, dod = runs['dod-base-housing'].week;
  const path = S.fundingPath(funding, la, dod, 500);
  assert.ok(path.find(s => s.step === 'Phase I').metric.includes(Math.round(la.kpis.net).toLocaleString()));
  assert.ok(path.find(s => s.step === 'DoD').metric.includes('Base-housing pack'));
  const other = S.fundingPath(funding, runs['au-bushfire'].week, dod, 500);
  assert.notEqual(other.find(s => s.step === 'Phase I').metric, path.find(s => s.step === 'Phase I').metric);
  assert.ok(funding.programs.some(p => p.name === 'CalSEED' && p.level === 'state'));
});

test('the engine and scheduler hold no region-specific code', () => {
  for (const f of ['../src/engine.js', '../src/scheduler.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    const hit = src.match(/bushfire|typhoon|Guangdong|Japan|community-battery|dod-base-housing|AUD|CNY|JPY/i);
    assert.equal(hit, null, f + ' mentions ' + (hit && hit[0]));
  }
});
