/* PowerUP week scheduler: 7 days hourly (4 ordinary days + a 3-day shutoff) for 3 Malibu neighborhoods.
   Pure functions; browser (window.PowerUpScheduler) and node (module.exports). Region packs (config/regions/*.json)
   change inputs only. Batteries are modelled as perfect: the dispatcher sends an intent and the fleet executes it.
   Real inputs: SCE circuit customers and October load profiles (via the engine's circuitProfiles), October peak as
   feeder capacity, Base Core 39.2 kWh. Everything else comes from the pack and is labelled there. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PowerUpScheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const H = 168, DAYS = 7;
  const NB_NAMES = ['Near the fire', 'Middle', 'Far'];
  const MODES = { follow: 'grid-following', form: 'grid-forming (island)', resync: 'resync' };
  const RULE = 'Customer prices are never raised in an emergency.';

  const solarShape = hod => (hod >= 6 && hod <= 19 ? Math.max(0, Math.sin(Math.PI * (hod - 6) / 13)) : 0);
  const sum = a => a.reduce((s, x) => s + x, 0);

  // 3 neighborhoods from the six real Malibu shutoff circuits, grouped by distance of each circuit's line to the fire.
  function neighborhoods(G, DATA) {
    const prof = G.circuitProfiles(DATA), fire = DATA.fire;
    const names = Object.keys(DATA.load).filter(c => prof[c]);
    if (names.length !== 6) throw Error('The scheduler expects the six Malibu circuits (powerup/data/data.json)');
    const centroid = c => {
      const pts = (DATA.lines[c] || []).flat();
      if (!pts.length) return null;
      return [sum(pts.map(p => p[0])) / pts.length, sum(pts.map(p => p[1])) / pts.length];
    };
    const k = Math.cos(fire.lat * Math.PI / 180);
    const named = names.map(c => ({ c, p: centroid(c) }));
    const dist = x => (x.p ? Math.hypot((x.p[0] - fire.lon) * k, x.p[1] - fire.lat) : Infinity); // no line: farthest
    named.sort((a, b) => dist(a) - dist(b));
    return [0, 1, 2].map(i => {
      const circuits = named.slice(i * 2, i * 2 + 2).map(x => x.c);
      const typical = Array.from({ length: 24 }, (_, h) => sum(circuits.map(c => (prof[c].max[h] + prof[c].min[h]) / 2)) * G.KW_PER_UNIT);
      const heat = Array.from({ length: 24 }, (_, h) => sum(circuits.map(c => prof[c].max[h])) * G.KW_PER_UNIT);
      return {
        id: ['near', 'middle', 'far'][i], name: NB_NAMES[i], circuits,
        customers: sum(circuits.map(c => DATA.circuits[c].customers)),
        capKW: sum(circuits.map(c => prof[c].peak)) * G.KW_PER_UNIT, // October peak, as the engine's restoration cap
        typical, heat, borrowed: circuits.filter(c => prof[c].borrowed),
      };
    });
  }

  function validatePack(p) {
    const need = ['id', 'name', 'provenance', 'flag', 'hazard', 'grid', 'tariff', 'shutoff', 'criticalLoads', 'fleet', 'loads', 'credits'];
    const miss = need.filter(k => p[k] == null);
    if (miss.length) throw Error('Region pack ' + (p.id || '?') + ' missing ' + miss.join(', '));
    if (p.id !== 'la-wildfire' && p.provenance !== 'SYNTHETIC') throw Error('Region pack ' + p.id + ' must be labelled SYNTHETIC');
    if (!(p.grid.hz > 0 && p.grid.volts > 0)) throw Error('Region pack ' + p.id + ' needs grid.hz and grid.volts');
    return p;
  }

  // the normal tariff for this hour: the customer price, never raised in an emergency
  const priceAt = (t, h) => (t.peakHours[0] <= h % 24 && h % 24 < t.peakHours[1] ? t.peak : t.offpeak);

  /* run(G, DATA, pack, opts): opts.shutoff=false gives a normal week; opts.policy='baseline' gives the plain
     self-consumption policy a battery runs without PowerUP (no peak relief, no fill, no hours budget). */
  function run(G, DATA, pack, opts) {
    opts = opts || {};
    validatePack(pack);
    const policy = opts.policy || 'powerup', withShutoff = opts.shutoff !== false;
    const t = pack.tariff, f = pack.fleet, L = pack.loads, cr = pack.credits, so = pack.shutoff;
    const eta = f.efficiency, floor = f.floorPct / 100, outFloor = f.outageFloorPct / 100, ceil = f.ceilingPct / 100;
    const heatDays = new Set(pack.heatDays || []);
    const critKW = sum(pack.criticalLoads.map(c => c.kw)) / 3; // facilities split across the three neighborhoods
    const out = neighborhoods(G, DATA).map((nb, i) => {
      const homes = Math.round(nb.customers * f.adoptionPct / 100);
      const energy = homes * f.capacityKWh + (f.communityKWh || 0), power = homes * f.powerKW + (f.communityKW || 0);
      const chargePower = homes * (f.chargeKW || f.powerKW) + (f.communityKW || 0);
      const off = withShutoff ? so.startH + so.staggerH[i] : Infinity, on = withShutoff ? off + so.durationH : Infinity;
      return {
        ...nb, homes, energy, power, chargePower, off, on, mbHomes: Math.round(nb.customers * L.medicalPct / 100),
        soc: new Float64Array(H + 1), load: new Float64Array(H), solar: new Float64Array(H), grid: new Float64Array(H),
        dis: new Float64Array(H), ch: new Float64Array(H), critical: new Float64Array(H), served: new Float64Array(H),
        deferred: new Float64Array(H), price: new Float64Array(H), mode: new Array(H), headroom: new Float64Array(H),
        uncontrolled: new Float64Array(H),
      };
    });
    let revenue = 0, credits = 0, drPaid = 0, critHours = 0, critServed = 0;
    const creditByKind = { ev: 0, pool: 0, ac: 0 };
    for (const nb of out) nb.soc[0] = nb.energy * f.startSocPct / 100;

    for (let h = 0; h < H; h++) {
      const hod = h % 24, day = Math.floor(h / 24), heat = heatDays.has(day);
      const peak = t.peakHours[0] <= hod && hod < t.peakHours[1];
      for (const nb of out) {
        const base = (heat ? nb.heat[hod] : nb.typical[hod]) * L.scale;
        // worst-case homes (assumed shares of battery homes): EV evenings, AC on heat afternoons, pool pumps, workshops
        const ev = nb.homes * L.evPct / 100 * L.evKW * (hod >= 18 && hod < 23 ? 1 : 0);
        const ac = heat ? nb.homes * L.acPct / 100 * L.acKW * (hod >= 13 && hod < 20 ? 1 : 0) : 0;
        const pool = nb.homes * L.poolPct / 100 * L.poolKW * (hod >= 10 && hod < 16 ? 1 : 0);
        const shop = nb.homes * L.shopPct / 100 * L.shopKW * (hod >= 9 && hod < 17 ? 1 : 0);
        const crit = nb.mbHomes * L.medicalKW + critKW;
        const smoky = withShutoff && day >= Math.floor(so.startH / 24) ? f.smokeDerate : 1;
        const solar = (nb.homes * f.solarKW + (f.communitySolarKW || 0)) * solarShape(hod) * f.solarDerate * smoky;
        const flex = { ev, ac, pool };
        let soc = nb.soc[h];
        const price = priceAt(t, h);
        nb.price[h] = price;
        nb.critical[h] = crit; nb.solar[h] = solar;
        const down = h >= nb.off && h < nb.on, resync = h === nb.on;
        const fill = policy === 'powerup' && withShutoff && h >= nb.off - so.fillLeadH && h < nb.off;
        let dis = 0, ch = 0, deferred = { ev: 0, ac: 0, pool: 0 }, load, grid;
        if (down) {
          // Island: grid-forming at the pack's Hz/V. Battery homes and critical sites only; flexible loads wait (credits).
          nb.mode[h] = 'form';
          deferred = { ...flex };
          load = base * nb.homes / nb.customers + crit; // workshops and flexible loads wait in an island
          const left = Math.max(1, nb.on - h);
          // hours budget: keep enough for critical loads to the end of the outage, spend the rest evenly
          const reserveCrit = Math.max(0, crit * (left - 1) - solar * 0.5 * (left - 1)) / eta;
          const budget = Math.max(0, (soc - nb.energy * outFloor - reserveCrit) * eta / left) + solar;
          const serve = policy === 'baseline' ? load : Math.min(load, Math.max(crit, budget));
          const need = serve - solar;
          if (need > 0) dis = Math.min(need, nb.power, Math.max(0, (soc - nb.energy * outFloor) * eta));
          else ch = Math.min(-need, nb.chargePower, Math.max(0, (nb.energy * ceil - soc) / eta)); // solar refills
          soc += ch * eta - dis / eta;
          nb.served[h] = Math.min(load, solar + dis);
          grid = 0;
        } else {
          nb.mode[h] = resync ? 'resync' : 'follow';
          // cold-load pickup: the first hours back on, the circuit's own load runs higher (factor from the pack)
          const cold = h >= nb.on && h < nb.on + so.coldLoadH ? so.coldLoadFactor : 1;
          load = base * cold + ev + ac + pool + shop + crit;
          const capKW = nb.capKW;
          let net = load - solar;
          nb.uncontrolled[h] = net; // what the feeder would carry with no PowerUP action this hour
          // flexible loads defer first whenever the feeder would go over capacity (credits paid by tier)
          if (policy === 'powerup' && net > capKW) {
            for (const k of ['ev', 'pool', 'ac']) {
              if (net <= capKW) break;
              const cut = Math.min(flex[k], net - capKW);
              deferred[k] = cut; net -= cut; load -= cut;
            }
          }
          const room = Math.max(0, (soc - nb.energy * floor) * eta);
          const exportKW = nb.homes * (f.exportKW || f.powerKW) + (f.communityKW || 0);
          if (resync) {
            // one hour to resynchronise: batteries keep carrying their own homes, no charging from the grid
            dis = Math.min(Math.max(0, net) * nb.homes / nb.customers, nb.power, room);
          } else if (fill || (policy === 'powerup' && h >= nb.on)) {
            // fill before the shutoff and the staggered recharge after it: inside headroom, never over capacity
            const head = Math.max(0, capKW - net);
            ch = Math.min(nb.chargePower, head, Math.max(0, (nb.energy * ceil - soc) / eta));
          } else if (peak) {
            // evening peak: peak relief up to the export limit; the baseline covers only the battery homes' own share
            const target = policy === 'baseline' ? Math.max(0, net) * nb.homes / nb.customers : Math.min(Math.max(0, net), exportKW);
            dis = Math.min(target, nb.power, room);
          } else if (net < 0) {
            ch = Math.min(-net, nb.chargePower, Math.max(0, (nb.energy * ceil - soc) / eta)); // solar surplus
          } else if (policy === 'powerup' && price === t.offpeak && hod < 6) {
            const head = Math.max(0, capKW - net);
            const want = Math.max(0, nb.energy * t.nightTargetPct / 100 - soc) / eta;
            ch = Math.min(nb.chargePower, head, want); // arbitrage: refill off-peak, inside headroom
          }
          // the cap is a hard limit: discharge more if the feeder is still over
          if (net - dis + ch > capKW) dis += Math.min(net - dis + ch - capKW, Math.max(0, room - dis));
          soc += ch * eta - dis / eta;
          grid = net - dis + ch;
          const fromGrid = Math.max(0, ch - Math.max(0, -net));
          revenue += price * dis - price * fromGrid + (policy === 'powerup' && peak ? t.drCredit * dis : 0);
          if (policy === 'powerup' && peak) drPaid += t.drCredit * dis;
          nb.served[h] = load;
        }
        for (const k of Object.keys(deferred)) {
          const c = deferred[k] * cr[k];
          creditByKind[k] += c; credits += c;
        }
        nb.load[h] = load; nb.grid[h] = grid; nb.dis[h] = dis; nb.ch[h] = ch;
        nb.deferred[h] = deferred.ev + deferred.ac + deferred.pool;
        nb.headroom[h] = down ? 0 : nb.capKW - grid;
        nb.soc[h + 1] = Math.min(nb.energy, Math.max(0, soc));
        critHours++; if (!down || nb.served[h] + 1e-6 >= crit) critServed++;
      }
    }
    const net = revenue - credits;
    // PowerUP never adds load over capacity: an over-cap hour counts against it only if it charged, or carried more
    // than the feeder would have without it. (Cold-load pickup on restoration can exceed the October peak by itself.)
    let capViolations = 0, surgeAvoidedKW = 0;
    for (const nb of out) {
      for (let h = 0; h < H; h++) {
        if (nb.mode[h] === 'form') continue;
        if (nb.grid[h] > nb.capKW + 1e-6 && (nb.ch[h] > 1e-6 || nb.grid[h] > nb.uncontrolled[h] + 1e-6)) capViolations++;
      }
      if (Number.isFinite(nb.on) && nb.on < H) {
        // everyone recharging at full rate the hour the grid returns, vs the staggered recharge PowerUP sent
        const naive = Math.min(nb.chargePower, (nb.energy * ceil - nb.soc[nb.on]) / eta);
        let sent = 0;
        for (let h = nb.on; h < Math.min(H, nb.on + 12); h++) sent = Math.max(sent, nb.ch[h]);
        surgeAvoidedKW += Math.max(0, naive - sent);
      }
    }
    return {
      pack, policy, shutoff: withShutoff, H, nbs: out, rule: RULE,
      kpis: {
        revenue, credits, drPaid, net, creditByKind,
        criticalHoursServed: critServed, criticalHours: critHours, capViolations, surgeAvoidedKW,
        // smallest feeder headroom on the ordinary days (before any shutoff)
        minHeadroomKW: Math.min(...out.map(nb => Math.min(...Array.from(nb.headroom).slice(0, Math.min(H, nb.off))))),
        socMinPct: Math.min(...out.map(nb => Math.min(...nb.soc) / nb.energy * 100)),
        socMaxPct: Math.max(...out.map(nb => Math.max(...nb.soc) / nb.energy * 100)),
      },
    };
  }

  // A normal week is the plain self-consumption policy with no shutoff; PowerUP's week is the shutoff week.
  function compare(G, DATA, pack) {
    const week = run(G, DATA, pack), normal = run(G, DATA, pack, { shutoff: false, policy: 'baseline' });
    week.kpis.normalWeek = normal.kpis.net;
    week.kpis.vsNormalPct = normal.kpis.net ? (week.kpis.net / normal.kpis.net - 1) * 100 : 0;
    return { week, normal };
  }

  // Funding path: each step quotes a number computed from a scheduler run (never typed into the config).
  function fundingPath(funding, res, dod, pilotHomes) {
    const k = res.kpis, homes = sum(res.nbs.map(n => n.homes)), sym = res.pack.tariff.symbol;
    const perHome = k.net / Math.max(1, homes), pct = r => Math.round(r.kpis.criticalHoursServed / r.kpis.criticalHours * 100);
    const steps = {
      'malibu-week': `Malibu week: ${pct(res)}% of critical hours served, ${sym}${Math.round(k.net).toLocaleString()} net vs ${sym}${Math.round(k.normalWeek).toLocaleString()} for a normal week`,
      'sce-pilot': `500-home SCE pilot: ≈${sym}${Math.round(perHome * (pilotHomes || 500)).toLocaleString()} a week at the same per-home rate`,
      'base-housing': dod ? `Base-housing pack: ${pct(dod)}% of critical hours served, ${sum(dod.nbs.map(n => n.homes)).toLocaleString()} homes, $${Math.round(dod.kpis.net).toLocaleString()} net a week` : 'Base-housing pack: run it from Regions',
    };
    return funding.path.map(s => ({ ...s, metric: steps[s.metric] || s.metric }));
  }

  return { H, DAYS, MODES, NB_NAMES, RULE, neighborhoods, validatePack, run, compare, fundingPath, solarShape, priceAt };
});
