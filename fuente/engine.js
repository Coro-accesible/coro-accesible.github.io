// Corale — motor de canto (Web Worker, módulo ES)
// espeak-ng (wasm) dice cada palabra a la altura de sus notas; luego un PSOLA
// ajusta afinación exacta, alarga la vocal y añade vibrato.

const DATA = '/usr/share/espeak-ng-data';
const VDIR = DATA + '/voices/cantor';
let M = null, W = null, FS = null, ESR = 22050;
const made = new Set();
let currentVoice = '';
let latestJob = 0;
const LANG_FILES = {
  'es-419': 'roa/es-419', 'es': 'roa/es', 'la': 'itc/la', 'it': 'roa/it', 'en-us': 'gmw/en-US', 'en': 'gmw/en',
  'pt-br': 'roa/pt-BR', 'pt': 'roa/pt', 'fr': 'roa/fr', 'de': 'gmw/de', 'ca': 'roa/ca', 'eu': 'eu', 'qu': 'qu'
};

async function init(data) {
  M = await createEspeak({ getPreloadedPackage: () => data });
  FS = M.FS;
  try { FS.mkdir(VDIR); } catch (e) { /* ya existe */ }
  W = new M.eSpeakNGWorker();
  ESR = W.get_samplerate();
  W.set_rate(125);
}

function useVoice(lang, variant, hz) {
  hz = Math.round(Math.min(1100, Math.max(55, hz)));
  const name = `${lang}_${variant}_${hz}_v2`;
  if (!made.has(name)) {
    let base = '';
    if (variant && variant !== 'base') {
      try { base = new TextDecoder().decode(FS.readFile(`${DATA}/voices/!v/${variant}`)); } catch (e) { base = ''; }
    }
    let keep = base.split('\n')
      .filter(l => !/^\s*(name|language|pitch|echo|roughness|breath|breathw|gender|tone|flutter)\b/.test(l));
    // Voces femeninas más llenas: las variantes de eSpeak suben mucho los formantes (hasta
    // un 30 %), lo que adelgaza el timbre. Se acercan a los valores de base y se refuerzan
    // los dos formantes graves. La altura no cambia: la fija después el PSOLA nota por nota.
    if (/^f\d/.test(variant)) {
      keep = keep.map(l => {
        const m = l.match(/^\s*formant\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(.*)$/);
        if (!m) return l;
        const n = +m[1], f = +m[2], h = +m[3];
        const f2 = n === 0 ? f : Math.round(100 + (f - 100) * 0.5);
        const h2 = n <= 1 ? Math.round(h * 1.2) : h;
        return `formant ${n} ${f2} ${h2} ${m[4]}${m[5]}`;
      });
    }
    keep = keep.join('\n');
    let langDef = `language ${lang}`;
    const lf = LANG_FILES[lang];
    if (lf) {
      try {
        langDef = new TextDecoder().decode(FS.readFile(`${DATA}/lang/${lf}`)).split('\n')
          .filter(l => !/^\s*(name|maintainer|status)\b/.test(l)).join('\n');
      } catch (e) { /* se usa sólo el código */ }
    }
    FS.writeFile(`${VDIR}/${name}`, `name ${name}\n${langDef}\npitch ${hz} ${hz}\n${keep}\n`);
    made.add(name);
  }
  if (currentVoice !== name) { W.set_voice('cantor/' + name); currentVoice = name; }
}

function synth(text) {
  const chunks = [], evs = [];
  W.synthesize(text, (a, e) => { if (a && a.length) chunks.push(a); if (e) evs.push(...e); return 0; });
  let n = 0; for (const c of chunks) n += c.length;
  const x = new Float32Array(n); let o = 0;
  for (const c of chunks) { for (let i = 0; i < c.length; i++) x[o + i] = c[i] / 32768; o += c.length; }
  const ph = [];
  for (const e of evs) {
    if (e.type === 'phoneme' && e.id) ph.push({ p: e.id, s: Math.round(e.audio_position * ESR / 1000) });
  }
  return { x, ph };
}

// ---------------------------------------------------------------- fonemas
const VOW = /[aeiouyɑɐɒæɔəɘɚɛɜɝɞɤɨɪɯɵøœɶʉʊʌʏ]/;
function clean(p) { return p.replace(/[ˈˌːˑ‿ʰ̯̃͡˞]/g, ''); }
function isVowel(p) { const c = clean(p); return c.length > 0 && (VOW.test(c[0]) || /̩/.test(p)); }
const OBS = new Set(['p', 'b', 't', 'd', 'k', 'g', 'f', 'β', 'ð', 'ɣ', 'v']);
const LIQ = new Set(['ɾ', 'r', 'l', 'ɹ', 'ʁ', 'ɫ']);
const GLIDE = new Set(['j', 'w', 'ʲ', 'ʷ', 'ɥ', 'i̯', 'u̯']);
function isGlide(p) { return GLIDE.has(p.replace(/[ˈˌːˑ]/g, '')) || /̯/.test(p); }
function isCluster(a, b) { return OBS.has(clean(a)) && LIQ.has(clean(b)); }

// Reparte los fonemas de una palabra entre n sílabas. Devuelve [{a, v, b}] (índices
// de fonema: inicio, vocal a estirar, fin exclusivo) o null si no encaja.
function splitSyllables(ph, n) {
  let groups = [];
  ph.forEach((q, i) => { if (isVowel(q.p)) groups.push([i, i]); });
  if (groups.length === 0) return n === 1 ? [{ a: 0, v: Math.floor(ph.length / 2), b: ph.length }] : null;
  while (groups.length > n) {
    let best = 0, bg = 1e9;
    for (let k = 0; k < groups.length - 1; k++) {
      const gap = groups[k + 1][0] - groups[k][1] - 1;
      if (gap < bg) { bg = gap; best = k; }
    }
    groups[best] = [groups[best][0], groups[best + 1][1]];
    groups.splice(best + 1, 1);
  }
  if (groups.length < n) return null;
  const starts = [0];
  for (let k = 1; k < groups.length; k++) {
    const c0 = groups[k - 1][1] + 1, c1 = groups[k][0];
    // Las semivocales (la «i» de «ria», la «u» de «bue») van con la consonante que las
    // precede: «glo-ria», no «glor-ia». Si la «r» quedaba al final de la sílaba anterior,
    // se oía dos veces en la unión y sonaba como la «rr» de «carro».
    let e = c1, onset = 0;
    while (e - 1 >= c0 && isGlide(ph[e - 1].p)) { e--; onset++; }
    const c = e - c0;
    if (c === 1) onset += 1;
    else if (c >= 2) onset += isCluster(ph[e - 2].p, ph[e - 1].p) ? 2 : 1;
    starts.push(c1 - onset);
  }
  return groups.map((g, k) => ({ a: starts[k], v: g[1], b: k + 1 < groups.length ? starts[k + 1] : ph.length }));
}

// ---------------------------------------------------------------- análisis
function analyse(x, approxHz) {
  const hop = Math.round(ESR * 0.005), win = Math.round(ESR * 0.025);
  const P0 = ESR / approxHz;
  const lo = Math.max(16, Math.floor(P0 * 0.72)), hi = Math.ceil(P0 * 1.38);
  const nF = Math.max(1, Math.floor((x.length - win - hi) / hop));
  const per = new Float32Array(nF), voiced = new Uint8Array(nF), rms = new Float32Array(nF);
  let maxR = 1e-9;
  for (let f = 0; f < nF; f++) {
    const s = f * hop; let e = 0;
    for (let i = 0; i < win; i++) e += x[s + i] * x[s + i];
    rms[f] = Math.sqrt(e / win); if (rms[f] > maxR) maxR = rms[f];
  }
  for (let f = 0; f < nF; f++) {
    const s = f * hop;
    let e0 = 0; for (let i = 0; i < win; i++) e0 += x[s + i] * x[s + i];
    if (e0 <= 0) continue;
    let best = -1, bk = lo;
    for (let k = lo; k <= hi; k++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < win; i++) { c += x[s + i] * x[s + i + k]; e1 += x[s + i + k] * x[s + i + k]; }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; bk = k; }
    }
    per[f] = bk;
    voiced[f] = (best > 0.5 && rms[f] > 0.04 * maxR) ? 1 : 0;
  }
  // marcas de pitch
  const marks = [], periods = [];
  let i = 0;
  while (i < x.length) {
    const f = Math.min(nF - 1, Math.floor(i / hop));
    if (!voiced[f]) { i += hop; continue; }
    const P = per[f] || Math.round(P0);
    let a, b;
    if (marks.length && i - marks[marks.length - 1] <= P * 1.5) { a = i - (P >> 2); b = i + (P >> 2); }
    else { a = i; b = i + P; }
    a = Math.max(0, a); b = Math.min(x.length - 1, b);
    let p = a, mv = -1e9;
    for (let k = a; k <= b; k++) if (x[k] > mv) { mv = x[k]; p = k; }
    if (marks.length && p <= marks[marks.length - 1] + (P >> 1)) p = marks[marks.length - 1] + P;
    if (p >= x.length) break;
    marks.push(p); periods.push(P);
    i = p + P;
  }
  return { hop, voiced, nF, marks: Int32Array.from(marks), periods: Int32Array.from(periods) };
}

function nearestMark(marks, s) {
  let lo = 0, hi = marks.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (marks[m] < s) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(marks[lo - 1] - s) < Math.abs(marks[lo] - s)) lo--;
  return lo;
}

// ---------------------------------------------------------------- render
function hzAt(segs, t) {
  // t en segundos absolutos; glissando breve entre notas de un melisma
  const G = 0.045;
  let k = 0;
  while (k < segs.length - 1 && t >= segs[k + 1].start) k++;
  let f = segs[k].hz;
  if (k + 1 < segs.length) {
    const b = segs[k + 1].start;
    if (t > b - G / 2) { const u = (t - (b - G / 2)) / G; f = Math.exp(Math.log(f) * (1 - u) + Math.log(segs[k + 1].hz) * u); }
  }
  if (k > 0) {
    const b = segs[k].start;
    if (t < b + G / 2) { const u = (t - (b - G / 2)) / G; f = Math.exp(Math.log(segs[k - 1].hz) * (1 - u) + Math.log(segs[k].hz) * u); }
  }
  const seg = segs[k], d = seg.end - seg.start, tt = t - seg.start;
  if (d > 0.5 && tt > 0.18) {
    const depth = Math.min(1, (tt - 0.18) / 0.35) * 0.018;
    f *= 1 + depth * Math.sin(2 * Math.PI * 5.4 * tt);
  }
  return f;
}

const XFADE = 0.015; // s, fundido cruzado entre sílabas contiguas
const ONSET_MAX = 0.07, CODA_MAX = 0.16; // s, duración máxima de las consonantes de inicio y final
// tiempo que el inicio de la sílaba se adelanta al comienzo de la nota. Si ese inicio
// lleva una vocal (el «tri» de «tria», un diptongo) no se acorta, para no comerse la «r».
function onsetOut(syl) { return syl.vowOn ? syl.v0 : Math.min(syl.v0, Math.round(ESR * ONSET_MAX)); }
function preOf(syl) { return Math.min(onsetOut(syl) / ESR, 0.085); }

function renderSyllable(syl, out, endT) {
  const x = syl.x, A = syl.an;
  const sr = ESR;
  const onIn = syl.v0, vIn = syl.v1 - syl.v0, coIn = x.length - syl.v1;
  const noteStart = syl.segs[0].start;
  const pre = preOf(syl);
  let t0 = Math.max(0, noteStart - pre);
  let total = Math.round((endT - t0) * sr);
  if (total < sr * 0.05) total = Math.round(sr * 0.05);
  // En el canto las consonantes son breves: eSpeak las alarga como en el habla
  // (cierres de «t», «m» y «n» de hasta 100 ms), y eso se oía como un bache.
  let onOut = onsetOut(syl), coOut = syl.vowCo ? coIn : Math.min(coIn, Math.round(sr * CODA_MAX));
  const minV = Math.round(sr * 0.04);
  if (onOut + coOut + minV > total) {
    const k = Math.max(0.2, (total - minV) / Math.max(1, onOut + coOut));
    onOut = Math.round(onOut * k); coOut = Math.round(coOut * k);
  }
  const vOut = Math.max(minV, total - onOut - coOut);
  const edge = Math.min(Math.round(sr * 0.03), Math.floor(vIn * 0.25));
  const map = (t) => {
    if (t < onOut) return onOut ? t * onIn / onOut : 0;
    if (t >= onOut + vOut) { const u = t - onOut - vOut; return syl.v1 + (coOut ? u * coIn / coOut : 0); }
    const u = t - onOut;
    if (vOut <= vIn) return syl.v0 + u * vIn / vOut;
    if (u < edge) return syl.v0 + u;
    if (u > vOut - edge) return syl.v1 - (vOut - u);
    return syl.v0 + edge + (u - edge) * (vIn - 2 * edge) / Math.max(1, vOut - 2 * edge);
  };
  const len = onOut + vOut + coOut;
  const y = new Float32Array(len + 4096), wsum = new Float32Array(len + 4096);
  const H = Math.round(sr * 0.005);
  const han = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n); return w; };
  const hanCache = new Map();
  const getHan = (n) => { let w = hanCache.get(n); if (!w) { w = han(n); hanCache.set(n, w); } return w; };
  let t = 0;
  while (t < len) {
    const src = map(t);
    const fi = Math.min(A.nF - 1, Math.max(0, Math.floor(src / A.hop)));
    const k = A.voiced[fi] ? nearestMark(A.marks, src) : -1;
    const tc = Math.round(t);
    if (k >= 0 && Math.abs(A.marks[k] - src) < A.periods[k] * 1.5) {
      const m = A.marks[k], P = A.periods[k], w = getHan(2 * P);
      for (let i = 0; i < 2 * P; i++) {
        const si = m - P + i, oi = tc - P + i;
        if (si < 0 || si >= x.length || oi < 0) continue;
        y[oi] += x[si] * w[i]; wsum[oi] += w[i];
      }
      const f = hzAt(syl.segs, t0 + t / sr);
      t += sr / f;
    } else {
      const s = Math.round(src), w = getHan(2 * H);
      for (let i = 0; i < 2 * H; i++) {
        const si = s - H + i, oi = tc - H + i;
        if (si < 0 || si >= x.length || oi < 0) continue;
        y[oi] += x[si] * w[i]; wsum[oi] += w[i];
      }
      t += H;
    }
  }
  for (let i = 0; i < len; i++) y[i] = y[i] / Math.max(wsum[i], 0.05);
  // Bordes: tras un silencio, entrada breve (8 ms); entre sílabas seguidas, fundido cruzado
  // de igual potencia con la sílaba vecina, para que no quede un hueco en la unión.
  const fi = Math.min(len, Math.round(sr * (syl.xin ? XFADE : 0.008)));
  const fo = Math.min(len, Math.round(sr * (syl.xout ? XFADE : 0.02)));
  for (let i = 0; i < fi; i++) y[i] *= syl.xin ? Math.sin(Math.PI / 2 * i / fi) : i / fi;
  for (let i = 0; i < fo; i++) y[len - 1 - i] *= syl.xout ? Math.sin(Math.PI / 2 * i / fo) : i / fo;
  const off = Math.round(t0 * sr);
  for (let i = 0; i < len && off + i < out.length; i++) out[off + i] += y[i] * syl.gain;
}

function trim(x, ph) {
  let a = 0, b = x.length;
  const th = 0.004;
  while (a < b && Math.abs(x[a]) < th) a++;
  while (b > a && Math.abs(x[b - 1]) < th) b--;
  return { a, b };
}

function cleanText(t) {
  return t.replace(/[¡!¿?,.;:"“”«»()\[\]{}*]/g, '').replace(/[_‿]/g, ' ').trim();
}

// palabra -> sílabas analizadas
function prepareWord(word, lang, variant) {
  const hzs = word.syls.flatMap(s => s.segs.map(g => g.hz)).sort((a, b) => a - b);
  const synthHz = hzs[Math.floor(hzs.length / 2)];
  useVoice(lang, variant, synthHz);
  const n = word.syls.length;
  const res = [];
  let parts = null, x = null, ph = null;
  const text = cleanText(word.syls.map(s => s.text).join(''));
  if (n > 1 && text) {
    ({ x, ph } = synth(text));
    parts = splitSyllables(ph, n);
  }
  if (parts) {
    const tr = trim(x), end = tr.b;
    parts.forEach((pt, k) => {
      // la primera sílaba arranca 10 ms antes de su primer fonema, pero nunca en el
      // silencio inicial de eSpeak: ese silencio dejaba un hueco antes de la palabra
      const s0 = k === 0 ? Math.max(0, Math.min(ph[pt.a].s, Math.max(tr.a, ph[pt.a].s - Math.round(ESR * 0.01)))) : ph[pt.a].s;
      const s1 = pt.b < ph.length ? ph[pt.b].s : end;
      const v0 = ph[pt.v].s, v1 = pt.v + 1 < ph.length ? ph[pt.v + 1].s : end;
      const syl = makeSyl(x.subarray(s0, Math.max(s0 + 1, s1)), v0 - s0, v1 - s0, word.syls[k], synthHz, nasalRanges(ph, s0, end));
      syl.vowOn = hasVowel(ph, pt.a, pt.v); syl.vowCo = hasVowel(ph, pt.v + 1, pt.b);
      res.push(syl);
    });
  } else {
    for (const s of word.syls) {
      const sh = s.segs.map(g => g.hz).sort((a, b) => a - b)[0];
      useVoice(lang, variant, sh);
      const t = cleanText(s.text) || 'u';
      const r = synth(t);
      const tr = trim(r.x);
      const p = r.ph.filter(q => q.s >= tr.a - 50);
      let vi = -1; for (let i = p.length - 1; i >= 0; i--) if (isVowel(p[i].p)) { vi = i; break; }
      let v0, v1;
      if (vi >= 0) { v0 = p[vi].s; v1 = vi + 1 < p.length ? p[vi + 1].s : tr.b; }
      else { v0 = tr.a + Math.round((tr.b - tr.a) * 0.25); v1 = tr.a + Math.round((tr.b - tr.a) * 0.8); }
      v0 = Math.max(tr.a, Math.min(v0, tr.b - 2)); v1 = Math.max(v0 + 1, Math.min(v1, tr.b));
      const syl = makeSyl(r.x.subarray(tr.a, tr.b), v0 - tr.a, v1 - tr.a, s, sh, nasalRanges(r.ph, tr.a, tr.b));
      syl.vowOn = vi > 0 && hasVowel(p, 0, vi);
      res.push(syl);
    }
  }
  return res;
}

function hasVowel(ph, a, b) { for (let i = a; i < b; i++) if (ph[i] && isVowel(ph[i].p)) return true; return false; }

// tramos de consonantes nasales (m, n, ñ), en muestras relativas a «off»
const NASAL = new Set(['m', 'n', 'ɲ', 'ŋ', 'ɱ']);
function nasalRanges(ph, off, end) {
  const out = [];
  for (let i = 0; i < ph.length; i++) if (NASAL.has(clean(ph[i].p))) out.push([ph[i].s - off, (i + 1 < ph.length ? ph[i + 1].s : end) - off]);
  return out;
}

function makeSyl(x, v0, v1, s, synthHz, nasals = []) {
  x = Float32Array.from(x);
  v0 = Math.max(0, Math.min(v0, x.length - 2)); v1 = Math.max(v0 + 2, Math.min(v1, x.length));
  let pk = 1e-6; for (let i = v0; i < v1; i++) pk = Math.max(pk, Math.abs(x[i]));
  // eSpeak marca el fin de la vocal donde empieza la explosión de la consonante siguiente,
  // así que el final de la «vocal» puede ser ya el silencio de una «t» o una «p». Al
  // estirar la nota ese silencio se oía como un corte: la vocal termina donde todavía suena.
  {
    const F = Math.round(ESR * 0.005), rms = (a) => { let e = 0; for (let i = a; i < a + F; i++) e += x[i] * x[i]; return Math.sqrt(e / F); };
    let e = v1; while (e - v0 > 4 * F && rms(e - F) < 0.12 * pk) e -= F;
    v1 = e;
  }
  // Consonantes nasales (m, n, ñ): eSpeak las da unos 20 dB más suaves que la vocal y,
  // entre dos sílabas, se oían como un hueco. Se refuerzan hasta 6 dB con transiciones
  // suaves. La «l», la «r» y las demás consonantes quedan como las da eSpeak: reforzadas
  // sonaban forzadas (la «gl» de «gloria»).
  {
    const F = Math.round(ESR * 0.005), nF = Math.ceil(x.length / F), g = new Float32Array(nF).fill(1);
    for (const [a, b] of nasals) {
      for (let f = Math.max(0, Math.floor(a / F)); f < Math.min(nF, Math.ceil(b / F)); f++) {
        const i0 = f * F; if (i0 >= v0 && i0 < v1) continue;
        let e = 0; for (let i = i0; i < Math.min(x.length, i0 + F); i++) e = Math.max(e, Math.abs(x[i]));
        if (e > 0) g[f] = Math.min(2, Math.max(1, 0.4 * pk / e));
      }
    }
    for (let f = 1; f < nF; f++) g[f] = Math.min(g[f], g[f - 1] + 0.2);
    for (let f = nF - 2; f >= 0; f--) g[f] = Math.min(g[f], g[f + 1] + 0.2);
    for (let i = 0; i < x.length; i++) {
      const ff = i / F, f0 = Math.min(nF - 1, Math.floor(ff)), f1 = Math.min(nF - 1, f0 + 1), u = ff - Math.floor(ff);
      x[i] *= g[f0] * (1 - u) + g[f1] * u;
    }
  }
  // Silencios dentro de las consonantes (el cierre de «t», «p», «k»): en el canto ligado
  // duran muy poco. Cada tramo silencioso de más de 15 ms se acorta a 15 ms.
  ({ x, v0, v1 } = shortenGaps(x, v0, v1, pk));
  const an = analyse(x, synthHz);
  return { x, v0, v1, segs: s.segs, an, gain: 0.55 / pk };
}

function shortenGaps(x, v0, v1, pk) {
  const W = Math.round(ESR * 0.005), keep = Math.round(ESR * 0.015), th = 0.015 * pk;
  const quiet = (a) => { let e = 0, n = 0; for (let i = a; i < Math.min(x.length, a + W); i++) { e += x[i] * x[i]; n++; } return Math.sqrt(e / Math.max(1, n)) < th; };
  const cut = [];
  const scan = (a, b) => {
    let run = -1;
    for (let p = a; p + W <= b; p += W) {
      if (quiet(p)) { if (run < 0) run = p; }
      else { if (run >= 0 && p - run > keep) cut.push([run + (keep >> 1), p - (keep >> 1)]); run = -1; }
    }
    if (run >= 0 && b - run > keep) cut.push(b < x.length ? [run + (keep >> 1), b - (keep >> 1)] : [run + keep, b]);
  };
  scan(0, v0); scan(v1, x.length);
  if (!cut.length) return { x, v0, v1 };
  const out = []; let pos = 0, nv0 = v0, nv1 = v1;
  for (const [a, b] of cut) {
    for (let i = pos; i < a; i++) out.push(x[i]);
    const d = b - a; if (b <= v0) { nv0 -= d; nv1 -= d; } else if (a >= v1) { /* tras la vocal */ }
    pos = b;
  }
  for (let i = pos; i < x.length; i++) out.push(x[i]);
  return { x: Float32Array.from(out), v0: nv0, v1: nv1 };
}

// ---------------------------------------------------------------- guía instrumental
// Piano Salamander: cada nota usa la grabación más cercana (una cada tercera menor),
// afinada a su altura. Al terminar la nota se apaga como al soltar la tecla.
let PIANO = null;
function renderPiano(notes, len) {
  const out = new Float32Array(len);
  const rel = Math.round(ESR * 0.35), tau = ESR * 0.07;
  for (const n of notes) {
    const m = 69 + 12 * Math.log2(n.hz / 440);
    let k = 0;
    for (let j = 1; j < PIANO.notes.length; j++) if (Math.abs(PIANO.notes[j] - m) < Math.abs(PIANO.notes[k] - m)) k = j;
    const x = PIANO.pcm[k], rate = Math.pow(2, (m - PIANO.notes[k]) / 12);
    const s0 = Math.round(n.start * ESR), L = Math.max(Math.round((n.end - n.start) * ESR), Math.round(ESR * 0.04));
    for (let i = 0; i < L + rel && s0 + i < len; i++) {
      const p = i * rate, a = Math.floor(p);
      if (a + 1 >= x.length) break;
      let v = x[a] + (x[a + 1] - x[a]) * (p - a);
      if (i >= L) v *= Math.exp(-(i - L) / tau) * (1 - (i - L) / rel);
      out[s0 + i] += v * 1.2;
    }
  }
  return out;
}

function renderGuide(notes, len) {
  if (PIANO) return renderPiano(notes, len);
  const out = new Float32Array(len);
  for (const n of notes) {
    const f = n.hz, s0 = Math.round(n.start * ESR), L = Math.round((n.end - n.start) * ESR);
    for (let i = 0; i < L && s0 + i < len; i++) {
      const t = i / ESR;
      const env = Math.min(1, t / 0.006) * (0.25 + 0.75 * Math.exp(-t * 2.2)) * Math.min(1, (L - i) / (ESR * 0.04));
      const ph = 2 * Math.PI * f * t;
      out[s0 + i] += env * (Math.sin(ph) + 0.42 * Math.sin(2 * ph) + 0.18 * Math.sin(3 * ph) + 0.08 * Math.sin(4 * ph)) * 0.35;
    }
  }
  return out;
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function renderTrack(job, tr, total, progress) {
  const len = Math.ceil(total * ESR) + ESR;
  const voice = new Float32Array(len);
  const syls = [];
  let w = 0;
  for (const word of tr.words) {
    try { syls.push(...prepareWord(word, tr.lang, tr.variant)); }
    catch (e) { /* palabra imposible: se omite */ }
    if (++w % 12 === 0) { progress(); await tick(); if (job !== latestJob) return null; }
    else progress();
  }
  for (let i = 0; i < syls.length; i++) {
    const s = syls[i], nx = syls[i + 1];
    const end = s.segs[s.segs.length - 1].end;
    let endT;
    s.xout = !!(nx && nx.segs[0].start - end < 0.01);
    if (s.xout) {
      // termina dentro de la entrada de la sílaba siguiente, que empieza con fundido
      endT = nx.segs[0].start - preOf(nx) + XFADE;
      nx.xin = true;
    } else endT = end - 0.03;
    endT = Math.max(endT, s.segs[0].start + 0.06);
    renderSyllable(s, voice, endT);
  }
  let pk = 1e-6; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(voice[i]));
  for (let i = 0; i < len; i++) voice[i] *= 0.85 / pk;
  const guide = renderGuide(tr.notes, len);
  let gk = 1e-6; for (let i = 0; i < len; i++) gk = Math.max(gk, Math.abs(guide[i]));
  if (gk > 0.8) for (let i = 0; i < len; i++) guide[i] *= 0.8 / gk;
  return { voice, guide };
}

globalThis.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.cmd === 'init') {
    try { await init(msg.data); postMessage({ type: 'ready', sr: ESR }); }
    catch (e) { postMessage({ type: 'error', message: String(e && e.message || e) }); }
  } else if (msg.cmd === 'render') {
    const job = msg.job; latestJob = job;
    const totalWords = msg.tracks.reduce((s, t) => s + t.words.length, 0) || 1;
    let done = 0, last = 0;
    const progress = () => {
      done++;
      const now = Date.now();
      if (now - last > 120) { last = now; postMessage({ type: 'progress', job, done, total: totalWords }); }
    };
    for (const tr of msg.tracks) {
      const r = await renderTrack(job, tr, msg.total, progress);
      if (!r || job !== latestJob) return;
      postMessage({ type: 'track', job, id: tr.id, sr: ESR, voice: r.voice, guide: r.guide }, [r.voice.buffer, r.guide.buffer]);
    }
    postMessage({ type: 'done', job });
  } else if (msg.cmd === 'piano') {
    PIANO = { notes: msg.notes, pcm: msg.pcm };
  } else if (msg.cmd === 'cancel') {
    latestJob = -1;
  }
};
