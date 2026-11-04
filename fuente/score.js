// Corale — lectura de MusicXML / MXL
// Devuelve una estructura con compases, secuencia desplegada (repeticiones),
// mapa de tempo y pistas (una por parte/voz) con notas y letra.

export async function readScoreFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readScoreBytes(bytes, file.name);
}

export async function readScoreBytes(bytes, name = '') {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = parseZip(bytes);
    let path = null;
    const cont = entries.find(e => e.name === 'META-INF/container.xml');
    if (cont) {
      const cx = decodeText(await inflate(bytes, cont));
      const m = cx.match(/full-path\s*=\s*"([^"]+)"/);
      if (m) path = m[1];
    }
    let ent = path ? entries.find(e => e.name === path) : null;
    if (!ent) ent = entries.find(e => /\.(xml|musicxml)$/i.test(e.name) && !e.name.startsWith('META-INF'));
    if (!ent) throw new Error('El archivo .mxl no contiene una partitura MusicXML.');
    return decodeText(await inflate(bytes, ent));
  }
  return decodeText(bytes);
}

function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

function parseZip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo .mxl está dañado (no se encontró el índice zip).');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    out.push({ name, method, csize, loff });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function inflate(b, e) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nlen = dv.getUint16(e.loff + 26, true), xlen = dv.getUint16(e.loff + 28, true);
  const start = e.loff + 30 + nlen + xlen;
  const data = b.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error('Compresión .mxl no soportada.');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const kids = (el, tag) => Array.from(el.children).filter(c => c.localName === tag);
const kid = (el, tag) => Array.from(el.children).find(c => c.localName === tag) || null;
const txt = (el, tag) => { const k = el && kid(el, tag); return k ? k.textContent.trim() : null; };
const UNIT_Q = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, breve: 8 };

export function parseScore(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('El archivo no es un MusicXML válido.');
  const root = doc.documentElement;
  if (root.localName === 'score-timewise') throw new Error('Esta partitura está en formato "timewise". Expórtela de nuevo como MusicXML normal (partwise).');
  if (root.localName !== 'score-partwise') throw new Error('El archivo no contiene una partitura MusicXML.');

  const title = (root.querySelector('work > work-title')?.textContent ||
    root.querySelector('movement-title')?.textContent ||
    root.querySelector('credit-words')?.textContent || '').trim();

  const partNames = {};
  for (const sp of root.querySelectorAll('part-list > score-part')) {
    partNames[sp.getAttribute('id')] = (txt(sp, 'part-name') || txt(sp, 'part-abbreviation') || sp.getAttribute('id')).trim();
  }
  const parts = kids(root, 'part');
  if (!parts.length) throw new Error('La partitura no tiene partes.');
  const nM = kids(parts[0], 'measure').length;

  const measInfo = [];
  const measLen = new Array(nM).fill(0);
  const tempoEv = [];
  const raw = []; // por parte: { id, name, voices: Map(voice -> notes[]) }
  let curTime = { beats: 4, beatType: 4 };
  let curEnding = null;

  parts.forEach((part, pi) => {
    const pid = part.getAttribute('id');
    const voices = new Map();
    let hasChord = false;
    const staffSet = new Set();
    let divisions = 1, transpose = 0;
    const lastByVoice = {};
    kids(part, 'measure').forEach((m, mi) => {
      if (mi >= nM) return;
      if (pi === 0) {
        measInfo[mi] = { number: m.getAttribute('number') || String(mi + 1), implicit: m.getAttribute('implicit') === 'yes', fwd: false, bwd: false, times: 2, endings: null, time: null };
      }
      const info = measInfo[mi];
      let cur = 0, maxPos = 0;
      for (const el of m.children) {
        const tag = el.localName;
        if (tag === 'attributes') {
          const d = txt(el, 'divisions'); if (d) divisions = parseFloat(d) || divisions;
          const t = kid(el, 'time');
          if (t && pi === 0) { const b = parseInt(txt(t, 'beats')), bt = parseInt(txt(t, 'beat-type')); if (b && bt) curTime = { beats: b, beatType: bt }; }
          const tr = kid(el, 'transpose');
          if (tr) transpose = (parseInt(txt(tr, 'chromatic')) || 0) + 12 * (parseInt(txt(tr, 'octave-change')) || 0);
        } else if (tag === 'direction') {
          const s = el.querySelector('sound[tempo]');
          if (s) tempoEv.push({ mi, q: cur / divisions, bpm: parseFloat(s.getAttribute('tempo')) });
          else {
            const mt = el.querySelector('metronome');
            const pm = mt && parseFloat(txt(mt, 'per-minute'));
            if (pm) {
              let u = UNIT_Q[txt(mt, 'beat-unit')] || 1;
              if (kid(mt, 'beat-unit-dot')) u *= 1.5;
              tempoEv.push({ mi, q: cur / divisions, bpm: pm * u, weak: true });
            }
          }
        } else if (tag === 'sound' && el.getAttribute('tempo')) {
          tempoEv.push({ mi, q: cur / divisions, bpm: parseFloat(el.getAttribute('tempo')) });
        } else if (tag === 'backup') {
          cur -= (parseFloat(txt(el, 'duration')) || 0);
        } else if (tag === 'forward') {
          cur += (parseFloat(txt(el, 'duration')) || 0);
        } else if (tag === 'barline' && pi === 0) {
          const rep = kid(el, 'repeat');
          if (rep) {
            if (rep.getAttribute('direction') === 'forward') info.fwd = true;
            if (rep.getAttribute('direction') === 'backward') { info.bwd = true; info.times = parseInt(rep.getAttribute('times')) || 2; }
          }
          const end = kid(el, 'ending');
          if (end) {
            const nums = (end.getAttribute('number') || '1').split(/[,\s]+/).map(Number).filter(Boolean);
            const type = end.getAttribute('type');
            if (type === 'start') { curEnding = nums; info.endings = nums; }
            else if (type === 'stop' || type === 'discontinue') { info.endings = info.endings || curEnding || nums; info.endingStop = true; }
          }
        } else if (tag === 'note') {
          if (kid(el, 'grace') || kid(el, 'cue')) continue;
          const dur = parseFloat(txt(el, 'duration')) || 0;
          const v = txt(el, 'voice') || '1';
          const isChord = !!kid(el, 'chord');
          const pitch = kid(el, 'pitch');
          let midi = null;
          if (pitch) midi = 12 * (parseInt(txt(pitch, 'octave')) + 1) + STEP[txt(pitch, 'step')] + Math.round(parseFloat(txt(pitch, 'alter') || '0')) + transpose;
          if (isChord) {
            const last = lastByVoice[v];
            if (last && midi != null && last.midi != null) {
              const upper = (parseInt(v) || 1) % 2 === 1;
              if (upper ? midi > last.midi : midi < last.midi) { last.midi = midi; }
              last.all.push(midi); hasChord = true;
            }
            continue;
          }
          const start = cur / divisions;
          const stf = txt(el, 'staff'); if (stf) staffSet.add(stf);
          cur += dur; if (cur > maxPos) maxPos = cur;
          if (!voices.has(v)) voices.set(v, []);
          if (midi == null) { lastByVoice[v] = null; voices.get(v).push({ mi, q: start, d: dur / divisions, rest: true }); continue; }
          const lyrics = {};
          for (const ly of kids(el, 'lyric')) {
            const texts = kids(ly, 'text').map(t => t.textContent);
            const text = texts.join(' ').replace(/[_‿]/g, ' ').trim();
            if (!text) continue;
            lyrics[ly.getAttribute('number') || '1'] = { text, syllabic: txt(ly, 'syllabic') || 'single', extend: !!kid(ly, 'extend') };
          }
          const ties = kids(el, 'tie').map(t => t.getAttribute('type'));
          const n = { mi, q: start, d: dur / divisions, midi, all: [midi], lyrics, tieStop: ties.includes('stop'), tieStart: ties.includes('start') };
          voices.get(v).push(n);
          lastByVoice[v] = n;
        }
        if (cur > maxPos) maxPos = cur;
      }
      if (pi === 0) {
        info.time = { ...curTime };
        if (!info.endings && curEnding && !info.endingStop) info.endings = curEnding;
        if (info.endingStop) curEnding = null;
      }
      measLen[mi] = Math.max(measLen[mi], maxPos / divisions);
    });
    raw.push({ id: pid, name: partNames[pid] || pid, voices, hasChord, staves: staffSet.size });
  });

  for (let i = 0; i < nM; i++) {
    if (!measLen[i]) measLen[i] = measInfo[i].time.beats * 4 / measInfo[i].time.beatType;
  }
  const origStart = [];
  let acc = 0;
  for (let i = 0; i < nM; i++) { origStart.push(acc); acc += measLen[i]; }

  // ---------- secuencia desplegada (repeticiones y casillas)
  const seq = [];
  const jumps = {};
  let i = 0, pass = 1, repStart = 0, resetPending = false;
  while (i < nM && seq.length < nM * 12) {
    const m = measInfo[i];
    if (resetPending && !m.endings) { pass = 1; resetPending = false; }
    if (m.fwd && (seq.length === 0 || seq[seq.length - 1].mi !== i - 0 || true)) { if (repStart !== i) { repStart = i; } }
    if (m.endings && !m.endings.includes(pass)) { i++; continue; }
    seq.push({ mi: i, pass });
    if (m.bwd) {
      const done = jumps[i] || 0;
      if (done < m.times - 1) { jumps[i] = done + 1; pass = done + 2; i = repStart; continue; }
      resetPending = true; repStart = i + 1;
    }
    i++;
  }
  let uq = 0;
  for (const s of seq) { s.startQ = uq; s.lenQ = measLen[s.mi]; uq += s.lenQ; }
  const totalQ = uq;

  // ---------- mapa de tempo
  const strong = tempoEv.filter(e => !e.weak);
  const useEv = strong.length ? strong : tempoEv;
  const tmap = [];
  for (const s of seq) for (const e of useEv) if (e.mi === s.mi) tmap.push({ q: s.startQ + e.q, bpm: e.bpm });
  tmap.sort((a, b) => a.q - b.q);
  const tempo = [];
  for (const t of tmap) {
    if (!(t.bpm > 0)) continue;
    if (tempo.length && Math.abs(tempo[tempo.length - 1].q - t.q) < 1e-6) tempo[tempo.length - 1].bpm = t.bpm;
    else if (!tempo.length || tempo[tempo.length - 1].bpm !== t.bpm) tempo.push({ q: t.q, bpm: t.bpm });
  }
  const baseBpm = tempo.length ? tempo[0].bpm : 100;
  if (!tempo.length || tempo[0].q > 0) tempo.unshift({ q: 0, bpm: baseBpm });
  let sec = 0;
  for (let k = 0; k < tempo.length; k++) {
    if (k > 0) sec += (tempo[k].q - tempo[k - 1].q) * 60 / tempo[k - 1].bpm;
    tempo[k].sec = sec;
  }

  // ---------- pistas
  const tracks = [];
  const generic = (nm) => /^(musicxml part|part|parte|p\d+|staff|pentagrama)?\s*\d*$/i.test((nm || '').trim());
  for (const p of raw) {
    const vkeys = Array.from(p.voices.keys()).filter(v => p.voices.get(v).some(n => !n.rest));
    vkeys.sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
    const perVoice = [];
    vkeys.forEach((v, vi) => {
      const src = p.voices.get(v);
      const byM = new Map();
      for (const n of src) { if (!byM.has(n.mi)) byM.set(n.mi, []); byM.get(n.mi).push(n); }
      const notes = [];
      let lastEnd = -1;
      for (const s of seq) {
        for (const n of (byM.get(s.mi) || [])) {
          const q = s.startQ + n.q;
          if (n.rest) continue;
          const keys = Object.keys(n.lyrics);
          let lyr = null;
          if (keys.length) lyr = n.lyrics[String(s.pass)] || n.lyrics['1'] || n.lyrics[keys[0]];
          const prev = notes[notes.length - 1];
          if (n.tieStop && prev && prev.midi === n.midi && Math.abs(prev.q + prev.d - q) < 1e-6 && !lyr) { prev.d += n.d; lastEnd = q + n.d; continue; }
          notes.push({ q, d: n.d, midi: n.midi, all: n.all.slice(), lyric: lyr, mi: s.mi, seqIndex: seq.indexOf(s), origQ: origStart[s.mi] + n.q, afterRest: q - lastEnd > 1e-6 });
          lastEnd = q + n.d;
        }
      }
      if (notes.length) perVoice.push({ v, vi, notes });
    });
    if (!perVoice.length) continue;
    const partLyrics = perVoice.some(x => x.notes.some(n => n.lyric));
    const instrumental = !partLyrics && (p.staves > 1 || p.hasChord || /piano|pno|órgano|organo|organ|teclado|keyboard|acomp|accomp|guitar|arpa|harp|instr/i.test(p.name));
    if (instrumental) {
      const notes = perVoice.flatMap(x => x.notes).sort((a, b) => a.q - b.q);
      const mids = notes.map(n => n.midi).sort((a, b) => a - b);
      tracks.push({ id: `${p.id}-all`, name: generic(p.name) ? 'Acompañamiento' : p.name, hasLyrics: false, instrumental: true, medianMidi: mids[Math.floor(mids.length / 2)], notes });
      continue;
    }
    for (const { v, vi, notes } of perVoice) {
      const base = generic(p.name) ? (raw.filter(r => generic(r.name)).length > 1 ? `Voz ${raw.indexOf(p) + 1}` : 'Voz') : p.name;
      const name = perVoice.length > 1 ? `${base} · voz ${vi + 1}` : base;
      const hasLyrics = notes.some(n => n.lyric);
      const mids = notes.map(n => n.midi).sort((a, b) => a - b);
      tracks.push({ id: `${p.id}-${v}`, name, hasLyrics, medianMidi: mids[Math.floor(mids.length / 2)], notes });
    }
  }
  const vocalT = tracks.filter(t => !t.instrumental);
  if (vocalT.length === 1 && /^Voz \d+$/.test(vocalT[0].name)) vocalT[0].name = 'Voz';
  if (!tracks.length) throw new Error('No se encontraron notas en la partitura.');

  return { title, measInfo, measLen, origStart, seq, totalQ, tempo, baseBpm, tracks };
}

// q desplegado -> segundos (sin factor de velocidad)
export function qToSec(score, q) {
  const t = score.tempo;
  let k = t.length - 1;
  while (k > 0 && t[k].q > q) k--;
  return t[k].sec + (q - t[k].q) * 60 / t[k].bpm;
}
export function secToQ(score, s) {
  const t = score.tempo;
  let k = t.length - 1;
  while (k > 0 && t[k].sec > s) k--;
  return t[k].q + (s - t[k].sec) * t[k].bpm / 60;
}

// Palabras para el motor de canto
export function buildWords(score, track, speed, transpose, lang = '') {
  const toSec = q => qToSec(score, q) / speed;
  const hz = m => 440 * Math.pow(2, (m + transpose - 69) / 12);
  if (track.instrumental) {
    const guide = [];
    for (const n of track.notes) for (const m of (n.all || [n.midi])) guide.push({ start: toSec(n.q), end: toSec(n.q + n.d), hz: hz(m) });
    return { words: [], guide, sylList: [] };
  }
  const words = [];
  const sylList = [];
  let cur = null, lastSyl = null;
  for (const n of track.notes) {
    const seg = { start: toSec(n.q), end: toSec(n.q + n.d), hz: hz(n.midi) };
    if (n.lyric && n.lyric.text) {
      const syl = { text: n.lyric.text, segs: [seg] };
      const sb = n.lyric.syllabic;
      if ((sb === 'middle' || sb === 'end') && cur) cur.syls.push(syl);
      else { cur = { syls: [syl], lyric: true }; words.push(cur); }
      if (sb === 'single' || sb === 'end') cur = null;
      lastSyl = syl;
      sylList.push({ text: n.lyric.text, syllabic: sb, start: seg.start, end: seg.end, origQ: n.origQ, seqIndex: n.seqIndex, word: words.length - 1 });
    } else if (lastSyl && !n.afterRest && track.hasLyrics) {
      lastSyl.segs.push(seg);
      if (sylList.length) sylList[sylList.length - 1].end = seg.end;
    } else {
      cur = null; lastSyl = null;
      words.push({ syls: [{ text: 'u', segs: [seg] }] });
    }
  }
  if (/^(es|it|la|pt|ca|gl|qu|eu)/.test(lang)) applySinalefa(words);
  const guide = track.notes.map(n => ({ start: toSec(n.q), end: toSec(n.q + n.d), hz: hz(n.midi) }));
  return { words, guide, sylList };
}

// Sinalefa al cantar: si una palabra termina en vocal y la siguiente empieza con la misma vocal,
// sin silencio entre ambas, la vocal repetida se omite en el canto («donde estás» se canta «donde stás»).
// Sólo cambia lo que se canta; la letra en pantalla no se modifica.
function applySinalefa(words) {
  const base = (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u', ü: 'u' }[c] || c);
  const V = /[aeiouáéíóúàèìòùü]/i;
  for (let i = 1; i < words.length; i++) {
    const p = words[i - 1], w = words[i];
    if (!p.lyric || !w.lyric) continue;
    const last = p.syls[p.syls.length - 1], first = w.syls[0];
    const pe = last.segs[last.segs.length - 1].end, ws = first.segs[0].start;
    if (ws - pe > 0.06) continue;                     // hay silencio o respiración entre las palabras
    const a = (last.text.toLowerCase().match(/(\p{L})[^\p{L}]*$/u) || [])[1];
    const m = first.text.match(/^([^\p{L}]*)(\p{L})(.*)$/u);
    if (!a || !m || !V.test(a) || !V.test(m[2])) continue;
    if (base(a) !== base(m[2].toLowerCase())) continue;
    if (!V.test(m[3])) continue;                      // la sílaba quedaría sin vocal: se canta completa
    first.text = m[1] + m[3];
  }
}

