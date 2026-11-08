/* Toonherkenning voor Bounty Noten.
   McLeod Pitch Method (NSDF) op een blok samples, plus een kleine "stabilisator"
   die pas een noot meldt als hij een paar frames achter elkaar hetzelfde is. */
(function (root) {
  'use strict';

  function detectPitch(buf, sampleRate, opts) {
    opts = opts || {};
    const fmin = opts.fmin || 55, fmax = opts.fmax || 1100;
    const n = buf.length;
    // gemiddelde eraf + energie
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    let rms = 0;
    const x = opts.work && opts.work.length === n ? opts.work : new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = buf[i] - mean; x[i] = v; rms += v * v; }
    rms = Math.sqrt(rms / n);
    if (rms < (opts.gate || 0.008)) return { freq: 0, clarity: 0, rms };

    const minLag = Math.max(2, Math.floor(sampleRate / fmax));
    const maxLag = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / fmin));
    const nsdf = opts.nsdf && opts.nsdf.length >= maxLag + 2 ? opts.nsdf : new Float32Array(maxLag + 2);

    // m'(tau) incrementeel: som van x_j^2 + x_{j+tau}^2 over j in [0, n-tau)
    let m = 0;
    for (let i = 0; i < n; i++) m += 2 * x[i] * x[i];
    for (let tau = 0; tau <= maxLag + 1; tau++) {
      if (tau > 0) m -= x[n - tau] * x[n - tau] + x[tau - 1] * x[tau - 1];
      if (tau < minLag - 1) { nsdf[tau] = 1; continue; }
      let acf = 0;
      const lim = n - tau;
      for (let j = 0; j < lim; j++) acf += x[j] * x[j + tau];
      nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }

    // Sleutelmaxima tussen positieve nuldoorgangen (na de eerste negatieve zone)
    const peaks = [];
    let tau = minLag;
    while (tau < maxLag && nsdf[tau] > 0) tau++;          // eerst uit de begin-heuvel
    let curMax = -1, curIdx = -1, inPos = false;
    for (; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (!inPos) { inPos = true; curMax = -1; curIdx = -1; }
        if (v > curMax) { curMax = v; curIdx = tau; }
      } else if (inPos) {
        inPos = false;
        if (curIdx > 0) peaks.push(curIdx);
      }
    }
    if (inPos && curIdx > 0 && curIdx < maxLag) peaks.push(curIdx);
    if (!peaks.length) return { freq: 0, clarity: 0, rms };

    let best = 0;
    for (const p of peaks) if (nsdf[p] > best) best = nsdf[p];
    const k = opts.k || 0.88;
    let chosen = peaks[0];
    for (const p of peaks) { if (nsdf[p] >= k * best) { chosen = p; break; } }

    // parabolische interpolatie
    const a = nsdf[chosen - 1], b = nsdf[chosen], c = nsdf[chosen + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
    const period = chosen + Math.max(-1, Math.min(1, shift));
    return { freq: sampleRate / period, clarity: b, rms };
  }

  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /* Stabilisator: meldt {midi} als dezelfde noot `need` frames achter elkaar komt. */
  function Stabilizer(need) {
    this.need = need || 3; this.last = null; this.count = 0; this.reported = null;
  }
  Stabilizer.prototype.push = function (midi) {
    if (midi == null) { this.count = 0; this.last = null; this.reported = null; return null; }
    if (midi === this.last) this.count++; else { this.last = midi; this.count = 1; }
    if (this.count >= this.need && this.reported !== midi) { this.reported = midi; return midi; }
    return null;
  };
  Stabilizer.prototype.reset = function () { this.last = null; this.count = 0; this.reported = null; };

  /* Aanzet-detectie: herkent een nieuwe streek of tokkel, ook als de toonhoogte gelijk blijft.
     Twee signalen: een plotselinge sprong in volume (harp), of een dip gevolgd door herstel (strijkwissel). */
  function OnsetDetector() { this.env = 0; this.peak = 0; this.trough = 1; this.lastT = -1e9; }
  OnsetDetector.prototype.push = function (rms, gate, t) {
    let onset = false;
    if (rms > gate && t - this.lastT > 140) {
      if (this.env > 0 && rms > this.env * 1.35) onset = true;                             // tokkel
      else if (this.trough < this.peak * 0.72 && rms > this.trough * 1.22 && rms > this.peak * 0.8) onset = true; // streek
    }
    if (onset) { this.lastT = t; this.peak = rms; this.trough = rms; }
    else {
      this.peak = Math.max(rms, this.peak * 0.97);
      this.trough = rms > this.peak * 0.9 ? rms : Math.min(this.trough, rms);
    }
    this.env = this.env ? this.env * 0.8 + rms * 0.2 : rms;
    return onset;
  };

  /* Fijne aanzet-detectie op een volume-omhullende met kleine stapjes (bv. 128 samples ≈ 3 ms).
     - tokkel / aanslag: volume springt binnen ~25 ms flink omhoog
     - streekwissel: volume zakt kort in (dip) en herstelt binnen ~150 ms
     - vanuit stilte: geluid begint                                                   */
  function EnvelopeOnset(opts) {
    opts = opts || {};
    this.dipRatio = opts.dipRatio || 0.84;   // hoe diep de dip moet zijn t.o.v. het niveau ervoor
    this.jump = opts.jump || 1.5;            // hoeveel sterker binnen 25 ms = tokkel
    this.hist = []; this.e = 0; this.t = 0; this.lastOn = -1e9;
    this.dip = null; this.below = true;
  }
  EnvelopeOnset.prototype.push = function (rms, dt, gate, hf) {
    // glijdend venster van ~28 ms, zodat lage tonen (C2 = 15 ms per trilling) geen gewiebel geven
    const n = Math.max(1, Math.round(28 / dt));
    (this.ring = this.ring || []).push(rms * rms);
    if (this.ring.length > n) this.ring.shift();
    let sum = 0; for (const v of this.ring) sum += v;
    this.e = Math.sqrt(sum / this.ring.length);
    this.t += dt;
    const t = this.t, e = this.e;
    this.hist.push([t, e]);
    while (this.hist.length && this.hist[0][0] < t - 400) this.hist.shift();
    let onset = false;
    const refr = t - this.lastOn > 180;
    // vanuit stilte
    if (e > gate * 1.5 && this.below && refr) onset = true;
    if (e < gate) this.below = true; else if (e > gate * 1.5) this.below = false;
    // tokkel: sprong t.o.v. 25 ms geleden
    if (!onset && refr && e > gate * 1.5) {
      let past = null;
      for (let i = this.hist.length - 1; i >= 0; i--) if (this.hist[i][0] <= t - 25) { past = this.hist[i][1]; break; }
      if (past !== null && e > past * this.jump) onset = true;
    }
    // streekwissel: dip t.o.v. niveau van de laatste 250 ms, daarna herstel
    if (!onset) {
      let ref = 0;
      for (const [ht, he] of this.hist) if (ht >= t - 250 && ht <= t - 30) ref = Math.max(ref, he);
      // alleen een snelle val telt (streekwissel); langzaam golven (vibrato, crescendo) niet
      let past = e;
      for (let i = this.hist.length - 1; i >= 0; i--) if (this.hist[i][0] <= t - 45) { past = this.hist[i][1]; break; }
      if (!this.dip && ref > gate * 2 && e < ref * this.dipRatio && past * this.dipRatio > e * 1.02) this.dip = { ref, min: e, t0: t };
      if (this.dip) {
        this.dip.min = Math.min(this.dip.min, e);
        if (t - this.dip.t0 > 160) this.dip = null;                     // geen snel herstel: gewoon zachter geworden
        else if (t - this.lastOn > 180 && e > this.dip.min * 1.15 && e > this.dip.ref * 0.88) { onset = true; this.dip = null; }
      }
    } else this.dip = null;
    // strijkgeruis: kort veel hoge tonen t.o.v. het normale klankkleur (hf = energie van het verschilsignaal)
    if (hf != null && this.e > 0) {
      const ratio = Math.sqrt(hf) / Math.max(1e-6, rms);
      this.hfAvg = this.hfAvg == null ? ratio : this.hfAvg + (1 - Math.exp(-dt / 250)) * (ratio - this.hfAvg);
      (this.hfRing = this.hfRing || []).push(ratio); if (this.hfRing.length > Math.max(1, Math.round(12 / dt))) this.hfRing.shift();
      const hfNow = this.hfRing.reduce((x, y) => x + y, 0) / this.hfRing.length;
      let ref2 = 0; for (const [ht, he] of this.hist) if (ht >= t - 250) ref2 = Math.max(ref2, he);
      if (!onset && refr && this.e > gate * 2 && this.e > ref2 * 0.75 && hfNow > this.hfAvg * 1.9 && t > 120) onset = true;
    }
    if (onset) this.lastOn = t;
    return onset;
  };

  const api = { detectPitch, freqToMidi, midiToFreq, Stabilizer, OnsetDetector, EnvelopeOnset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BNPitch = api;
})(typeof window !== 'undefined' ? window : globalThis);
