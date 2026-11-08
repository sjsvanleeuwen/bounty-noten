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

  const api = { detectPitch, freqToMidi, midiToFreq, Stabilizer, OnsetDetector };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BNPitch = api;
})(typeof window !== 'undefined' ? window : globalThis);
