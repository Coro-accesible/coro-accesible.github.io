// ===================================================================== APP
const $ = (id) => document.getElementById(id);
const SR = 22050;
const diag = { engine: 'cargando', viewer: 'cargando', errors: [] };

// errores visibles: nunca fallar en silencio
function reportError(msg) {
  diag.errors.push(msg);
  if (diag.errors.length > 12) diag.errors.shift();
  try { status('Error: ' + msg, true); } catch (e) { /* aún sin interfaz */ }
}
window.addEventListener('error', (e) => reportError(e.message || String(e)));
window.addEventListener('unhandledrejection', (e) => reportError((e.reason && e.reason.message) || String(e.reason)));

// ------------------------------------------------------------------ estado
const st = {
  score: null, xml: null, fileBase: 'partitura', source: '',
  speed: 1, transpose: 0, lang: 'es-419',
  tracks: [], ready: false, job: 0, totalSec: 0,
  mine: null, mode: 'all',
  playing: false, startCtx: 0, startPos: 0, pos: 0, loop: null,
  lyrTrack: null, metroBuf: null, expMetro: false,
};
let ctx = null, master = null, metroGain = null;
let sources = [];
const nodes = new Map();

const prefs = (() => { try { return JSON.parse(localStorage.getItem('corale-prefs') || localStorage.getItem('cantor-prefs') || '{}'); } catch (e) { return {}; } })();
function savePrefs() { try { localStorage.setItem('corale-prefs', JSON.stringify(prefs)); } catch (e) { /* sin almacenamiento */ } }

function say(msg, urgent = false) {
  const el = urgent ? $('liveA') : $('live');
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 40);
}
function status(msg, err = false) {
  const s = $('statusText');
  s.textContent = msg;
  s.className = err ? 'err' : '';
}
function showWarnings(list) {
  const ul = $('warnList');
  ul.innerHTML = (list || []).map(w => `<li>${esc(w)}</li>`).join('');
  ul.hidden = !(list && list.length);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------------ carga de scripts (clásicos, sin módulos)
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

// ------------------------------------------------------------------ motor de voz (worker desde blob)
let engine = null, engineReady = false;
async function startEngine() {
  try {
    status('Cargando motor de voz…');
    await Promise.all([loadScript('cantor-engine.js'), loadScript('cantor-voice-data.js')]);
    const src = '(' + self.CANTOR_ENGINE_SRC.toString() + ')();';
    engine = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    engine.onmessage = onEngineMessage;
    engine.onerror = (e) => { diag.engine = 'error: ' + (e.message || 'worker'); reportError('El motor de voz falló: ' + (e.message || '')); };
    const b64 = self.CANTOR_VOICE_DATA;
    const bin = new Uint8Array(b64.length * 3 / 4 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
    const raw = atob(b64);
    for (let i = 0; i < bin.length; i++) bin[i] = raw.charCodeAt(i);
    diag.voiceData = `${(bin.length / 1e6).toFixed(1)} MB`;
    engine.postMessage({ cmd: 'init', data: bin.buffer }, [bin.buffer]);
  } catch (e) {
    diag.engine = 'error: ' + e.message;
    reportError('No se pudo iniciar el motor de voz. ' + e.message);
  }
}
function onEngineMessage(ev) {
  const m = ev.data;
  if (m.type === 'ready') {
    engineReady = true; diag.engine = 'listo';
    if (st.score) startRender(); else status('Listo. Abra una partitura desde el menú Archivo.');
  } else if (m.type === 'error') {
    diag.engine = 'error: ' + m.message;
    reportError('No se pudo iniciar el motor de voz: ' + m.message);
  } else if (m.type === 'progress' && m.job === st.job) {
    const p = Math.round(100 * m.done / m.total);
    $('prog').value = p;
    status(`Generando voces… ${p} %`);
  } else if (m.type === 'track' && m.job === st.job) {
    const tr = st.tracks.find(t => t.id === m.id);
    if (tr) tr.buf = { voice: m.voice, guide: m.guide };
  } else if (m.type === 'done' && m.job === st.job) {
    buildMetronome();
    st.ready = true;
    $('prog').hidden = true;
    const nv = st.tracks.filter(t => !t.instrumental).length, ni = st.tracks.length - nv;
    const desc = `${nv === 1 ? '1 voz' : nv + ' voces'}${ni ? (ni === 1 ? ' y acompañamiento' : ` y ${ni} instrumentos`) : ''}`;
    status(`Listo: ${desc} · ${fmtTime(st.totalSec)}.`);
    say(`Listo: ${desc}, duración ${fmtTimeWords(st.totalSec)}. Alt Mayúsculas P para reproducir.`);
    setTransportEnabled(true);
    updatePosition(true);
  }
}

function startRender() {
  if (!st.score) return;
  if (!engineReady) { status('Partitura cargada. Esperando al motor de voz…'); return; }
  stop(false);
  st.ready = false;
  setTransportEnabled(false);
  st.job++;
  st.totalSec = qToSec(st.score, st.score.totalQ) / st.speed;
  const payload = [];
  for (const tr of st.tracks) {
    const b = buildWords(st.score, tr, st.speed, st.transpose, st.lang);
    tr.sylList = b.sylList; tr.words = b.words; tr.buf = null;
    payload.push({ id: tr.id, lang: st.lang, variant: tr.mix.variant, words: b.words, notes: b.guide });
  }
  $('prog').hidden = false; $('prog').value = 0;
  status('Generando voces… 0 %');
  engine.postMessage({ cmd: 'render', job: st.job, total: st.totalSec + 0.5, tracks: payload });
  renderLyricsFull();
  updateLyrics(0, true);
}
let renderTimer = 0;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(startRender, 500); }

// ------------------------------------------------------------------ abrir partituras
async function loadXml(xml, name, source = 'MusicXML', warnings = []) {
  stop(false);
  let score;
  try { score = parseScore(xml); }
  catch (e) { status(e.message, true); say(e.message, true); return; }
  st.score = score; st.xml = xml; st.source = source;
  // idioma de la letra: si se reconoce con claridad, se elige solo
  const lyrText = score.tracks.flatMap(t => t.notes.filter(n => n.lyric).map(n => n.lyric.text + (n.lyric.syllabic === 'begin' || n.lyric.syllabic === 'middle' ? '' : ' '))).join('');
  const det = detectLyricLang(lyrText);
  let langNote = '';
  if (det && !(det.startsWith('es') && st.lang.startsWith('es')) && !(det.startsWith('en') && st.lang.startsWith('en')) && det !== st.lang) {
    st.lang = det; $('selLang').value = det;
    langNote = ` Idioma de la letra detectado: ${$('selLang').selectedOptions[0].text}.`;
  }
  st.fileBase = (score.title || name || 'partitura').replace(/\.(mxl|musicxml|xml|brf|brl|txt)$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'partitura';
  $('fileName').textContent = score.title && name && !name.toLowerCase().includes(score.title.toLowerCase()) ? `${score.title} (${name})` : (score.title || name);
  $('fileBadge').innerHTML = source === 'BRF' ? '<span class="badge">desde braille</span>' : '';
  showWarnings(warnings);
  st.tracks = score.tracks.map((t, i) => ({
    ...t,
    mix: {
      voice: t.hasLyrics ? 80 : 0, guide: t.instrumental ? 55 : t.hasLyrics ? 20 : 60,
      pan: score.tracks.length > 1 ? Math.round(-60 + 120 * i / (score.tracks.length - 1)) : 0,
      mute: false, solo: false,
      variant: defaultVariant(t, i, score.tracks),
    },
    buf: null, sylList: [], words: [],
  }));
  st.mine = (st.tracks.find(t => t.hasLyrics) || st.tracks.find(t => !t.instrumental) || st.tracks[0]).id;
  st.lyrTrack = st.mine;
  st.pos = 0;
  $('numGoto').max = score.measInfo.length;
  $('numLoopA').value = 1;
  $('numLoopB').value = Math.min(4, score.measInfo.length);
  $('speedHint').textContent = `Tempo de la partitura: negra = ${Math.round(score.baseBpm)}. Las voces se vuelven a generar al cambiar la velocidad.`;
  updateSpeedLabel();
  buildMixerUI();
  applyMode();
  const nv = st.tracks.length;
  if (langNote) status('Partitura abierta.' + langNote);
  say(`Partitura abierta: ${score.title || name}. ${nv} ${nv === 1 ? 'voz' : 'voces'}: ${st.tracks.map(t => t.name).join(', ')}.${langNote}${warnings.length ? ' Hay ' + warnings.length + ' avisos de importación, debajo de la barra de estado.' : ''} Generando voces.`);
  renderScoreView();
  startRender();
}

async function loadBytes(bytes, name) {
  const lower = (name || '').toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let text = null;
  if (!isZip) text = new TextDecoder('utf-8').decode(bytes);
  const looksXml = text && /^\s*(<\?xml|<!DOCTYPE|<score-)/.test(text.slice(0, 400).replace(/^﻿/, ''));
  if (!isZip && !looksXml && (/\.(brf|brl|txt)$/.test(lower) || !/\.(xml|musicxml)$/.test(lower))) {
    const r = brfToMusicXML(text, name);
    await loadXml(r.xml, name, 'BRF', r.warnings);
    return;
  }
  const xml = await readScoreBytes(bytes, name);
  await loadXml(xml, name, isZip ? 'MXL' : 'MusicXML');
}
async function loadFile(file) {
  try {
    status(`Leyendo ${file.name}…`);
    await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (e) { status('No se pudo abrir el archivo: ' + e.message, true); say('No se pudo abrir el archivo. ' + e.message, true); }
}
async function loadExample(key) {
  try {
    if (!self.CANTOR_EXAMPLES) await loadScript('cantor-examples.js');
    const ex = self.CANTOR_EXAMPLES[key];
    if (!ex) throw new Error('ejemplo no disponible');
    const names = { campanero: 'Campanero.musicxml', canon: 'Campanero-canon.musicxml', brf: 'Campanero.brf' };
    await loadBytes(new TextEncoder().encode(ex), names[key]);
  } catch (e) { status('No se pudo cargar el ejemplo: ' + e.message, true); }
}
function openFileDialog() { closeMenus(); $('fileInput').click(); }
$('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; };
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop-active'); });
document.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || e.target === document.body) document.body.classList.remove('drop-active'); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('drop-active');
  const f = e.dataTransfer.files[0]; if (f) loadFile(f);
});

// ------------------------------------------------------------------ mezclador
// Timbre por defecto: soprano, mezzo y contralto con voz femenina; tenor, barítono y bajo con voz masculina.
// Se decide por el nombre de la parte; si el nombre no lo dice, por la altura media de la voz.
function voiceRole(t) {
  const n = (t.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/contrabaj|basso?\b|bajo|bass|\bb\b|^b\s*\d/.test(n)) return 'bass';
  if (/bariton/.test(n)) return 'baritone';
  if (/tenor|\bt\b|^t\s*\d/.test(n)) return 'tenor';
  if (/contralt|\balto|mezzo|\bms?\b|^a\s*\d|\ba\b|\bco\b/.test(n)) return 'alto';
  if (/sopran|tiple|\bs\b|^s\s*\d/.test(n)) return 'soprano';
  return null;
}
const ROLE_VARIANTS = { soprano: ['f3', 'f1'], alto: ['f2', 'f4'], tenor: ['m3', 'm2'], baritone: ['m1', 'm4'], bass: ['m1', 'base'] };
function defaultVariant(t, i, all = []) {
  const role = voiceRole(t);
  if (role) {
    // dos partes de la misma cuerda (tenor 1 y tenor 2) reciben timbres distintos
    const k = all.slice(0, i).filter(x => !x.instrumental && voiceRole(x) === role).length;
    const vs = ROLE_VARIANTS[role]; return vs[k % vs.length];
  }
  // sin nombre reconocible: por la altura (las voces de tenor suelen quedar entre Sol 3 y Sol 4)
  return t.medianMidi >= 64 ? (i % 2 ? 'f2' : 'f3') : (i % 2 ? 'm1' : 'm3');
}
const VARIANTS = [
  ['f1', 'Femenina 1'], ['f2', 'Femenina 2'], ['f3', 'Femenina 3'], ['f4', 'Femenina 4'], ['f5', 'Femenina 5'],
  ['base', 'Masculina 1'], ['m1', 'Masculina 2'], ['m2', 'Masculina 3'], ['m3', 'Masculina 4'], ['m4', 'Masculina 5'],
];
function buildMixerUI() {
  const box = $('tracks');
  box.innerHTML = '';
  const vocal = st.tracks.filter(t => !t.instrumental);
  const optHtml = (vocal.length ? vocal : st.tracks).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('selMine').innerHTML = optHtml; $('selMine').value = st.mine;
  $('selLyrTrack').innerHTML = optHtml; $('selLyrTrack').value = st.lyrTrack;
  st.tracks.forEach((t, i) => {
    const fs = document.createElement('fieldset');
    fs.className = 'track'; fs.dataset.id = t.id;
    const n = i + 1;
    fs.innerHTML = `
      <legend>${n}. ${esc(t.name)}</legend>
      ${t.instrumental ? '<p class="nolyr">Acompañamiento instrumental, con sus acordes completos.</p>' : t.hasLyrics ? '' : '<p class="nolyr">Sin letra: se oye como guía instrumental.</p>'}
      <div class="trow" ${t.instrumental ? 'hidden' : ''}>
        <label for="v-${i}">Canto</label>
        <input type="range" id="v-${i}" min="0" max="100" value="${t.mix.voice}" aria-label="Volumen de canto, ${esc(t.name)}">
        <output id="vo-${i}" for="v-${i}">${t.mix.voice}</output>
      </div>
      <div class="trow">
        <label for="g-${i}">${t.instrumental ? 'Volumen' : 'Piano guía'}</label>
        <input type="range" id="g-${i}" min="0" max="100" value="${t.mix.guide}" aria-label="${t.instrumental ? 'Volumen' : 'Volumen del piano guía'}, ${esc(t.name)}">
        <output id="go-${i}" for="g-${i}">${t.mix.guide}</output>
      </div>
      <div class="trow">
        <label for="p-${i}">Panorama</label>
        <input type="range" id="p-${i}" min="-100" max="100" step="10" value="${t.mix.pan}" aria-label="Panorama, ${esc(t.name)}" aria-valuetext="${panText(t.mix.pan)}">
        <output id="po-${i}" for="p-${i}">${panShort(t.mix.pan)}</output>
      </div>
      <div class="tbtn-row">
        <button id="m-${i}" aria-pressed="false" aria-label="Silenciar ${esc(t.name)}">Silenciar</button>
        <button id="s-${i}" aria-pressed="false" aria-label="Solo ${esc(t.name)}" ${n <= 9 ? `aria-keyshortcuts="Control+Shift+${n} Alt+Shift+${n}"` : ''}>Solo${n <= 9 ? ` <kbd aria-hidden="true">Ctrl+Mayús+${n}</kbd>` : ''}</button>
        <label class="sr-only" for="t-${i}">Timbre de ${esc(t.name)}</label>
        <select id="t-${i}" ${t.instrumental ? 'hidden' : ''}>${VARIANTS.map(([v, l]) => `<option value="${v}" ${v === t.mix.variant ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>`;
    box.appendChild(fs);
    $(`v-${i}`).oninput = (e) => { t.mix.voice = +e.target.value; $(`vo-${i}`).textContent = t.mix.voice; applyGains(); };
    $(`g-${i}`).oninput = (e) => { t.mix.guide = +e.target.value; $(`go-${i}`).textContent = t.mix.guide; applyGains(); };
    $(`p-${i}`).oninput = (e) => { t.mix.pan = +e.target.value; $(`po-${i}`).textContent = panShort(t.mix.pan); e.target.setAttribute('aria-valuetext', panText(t.mix.pan)); applyGains(); };
    $(`m-${i}`).onclick = () => { t.mix.mute = !t.mix.mute; refreshTrackButtons(); applyGains(); say(`${t.name} ${t.mix.mute ? 'silenciada' : 'activada'}`); };
    $(`s-${i}`).onclick = () => toggleSolo(i);
    $(`t-${i}`).onchange = (e) => { t.mix.variant = e.target.value; scheduleRender(); say(`Timbre de ${t.name}: ${e.target.selectedOptions[0].text}. Regenerando.`); };
  });
  refreshTrackButtons();
}
function toggleSolo(i) {
  const t = st.tracks[i]; if (!t) return;
  t.mix.solo = !t.mix.solo; refreshTrackButtons(); applyGains();
  say(`Solo de ${t.name} ${t.mix.solo ? 'activado' : 'desactivado'}`);
}
function refreshTrackButtons() {
  st.tracks.forEach((t, i) => {
    const m = $(`m-${i}`), s = $(`s-${i}`);
    if (m) m.setAttribute('aria-pressed', String(t.mix.mute));
    if (s) s.setAttribute('aria-pressed', String(t.mix.solo));
    const fs = document.querySelector(`fieldset.track[data-id="${t.id}"]`);
    if (fs) fs.classList.toggle('is-mine', t.id === st.mine);
  });
}
function setSlider(i, kind, val) {
  const t = st.tracks[i];
  t.mix[kind === 'v' ? 'voice' : 'guide'] = val;
  const el = $(`${kind}-${i}`); if (el) el.value = val;
  const o = $(`${kind}o-${i}`); if (o) o.textContent = val;
}
function applyMode() {
  st.tracks.forEach((t, i) => {
    t.mix.solo = false; t.mix.mute = false;
    const mine = t.id === st.mine;
    const baseV = t.hasLyrics ? 80 : 0;
    if (t.instrumental) { setSlider(i, 'v', 0); setSlider(i, 'g', { all: 55, lead: 40, solo: 0, minus: 55 }[st.mode]); return; }
    if (st.mode === 'all') { setSlider(i, 'v', baseV); setSlider(i, 'g', t.hasLyrics ? 20 : 60); }
    if (st.mode === 'lead') { setSlider(i, 'v', mine ? 100 : Math.round(baseV * 0.35)); setSlider(i, 'g', mine ? 35 : 10); }
    if (st.mode === 'solo') { setSlider(i, 'v', mine ? 90 : 0); setSlider(i, 'g', mine ? 30 : 0); }
    if (st.mode === 'minus') { setSlider(i, 'v', mine ? 0 : baseV); setSlider(i, 'g', mine ? 0 : 20); }
  });
  refreshTrackButtons(); applyGains();
}
$('selMine').onchange = (e) => {
  st.mine = e.target.value; st.lyrTrack = st.mine; $('selLyrTrack').value = st.mine;
  applyMode(); renderLyricsFull(); updateLyrics(st.pos, true);
  say(`Mi voz: ${st.tracks.find(t => t.id === st.mine).name}`);
};
$('selMode').onchange = (e) => { st.mode = e.target.value; applyMode(); say(`Modo: ${e.target.selectedOptions[0].text}`); };
$('selLyrTrack').onchange = (e) => { st.lyrTrack = e.target.value; renderLyricsFull(); updateLyrics(st.pos, true); };
$('rngMaster').oninput = (e) => { $('outMaster').textContent = e.target.value; applyGains(); };
$('rngMetro').oninput = (e) => { $('outMetro').textContent = e.target.value; applyGains(); };

function panShort(p) { return p === 0 ? 'Centro' : (p < 0 ? 'Izq ' + (-p) : 'Der ' + p); }
function panText(p) { return p === 0 ? 'centro' : (p < 0 ? `${-p} a la izquierda` : `${p} a la derecha`); }
function effGains(t) {
  const anySolo = st.tracks.some(x => x.mix.solo);
  const on = !t.mix.mute && (!anySolo || t.mix.solo);
  const m = (+$('rngMaster').value) / 100;
  return { v: on ? Math.pow(t.mix.voice / 100, 1.6) * m : 0, g: on ? Math.pow(t.mix.guide / 100, 1.6) * m * 0.9 : 0 };
}
function applyGains() {
  if (!ctx) return;
  for (const t of st.tracks) {
    const n = nodes.get(t.id); if (!n) continue;
    const { v, g } = effGains(t);
    n.v.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    n.g.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
    n.p.pan.setTargetAtTime(t.mix.pan / 100, ctx.currentTime, 0.02);
  }
  const mv = $('chkMetro').checked ? Math.pow(+$('rngMetro').value / 100, 1.4) * (+$('rngMaster').value / 100) : 0;
  metroGain.gain.setTargetAtTime(mv, ctx.currentTime, 0.02);
}

// ------------------------------------------------------------------ metrónomo
function beatsOf(s) {
  const t = st.score.measInfo[s.mi].time || { beats: 4, beatType: 4 };
  let beatQ = 4 / t.beatType, n = t.beats;
  if (t.beatType === 8 && t.beats % 3 === 0 && t.beats > 3) { beatQ = 1.5; n = t.beats / 3; }
  const nominal = n * beatQ;
  const off = Math.max(0, nominal - s.lenQ);
  const list = [];
  for (let p = ((beatQ - (off % beatQ)) % beatQ); p < s.lenQ - 1e-6; p += beatQ) list.push({ q: s.startQ + p, accent: Math.abs(off + p) < 1e-6, beat: Math.round((off + p) / beatQ) + 1 });
  return { list, beatQ, n };
}
function buildMetronome() {
  const len = Math.ceil((st.totalSec + 1) * SR);
  const buf = new Float32Array(len);
  for (const s of st.score.seq) {
    for (const b of beatsOf(s).list) {
      const at = Math.round(qToSec(st.score, b.q) / st.speed * SR);
      const f = b.accent ? 1760 : 1175, L = Math.round(SR * 0.045);
      for (let i = 0; i < L && at + i < len; i++) buf[at + i] += Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / (SR * 0.009)) * (b.accent ? 0.9 : 0.6);
    }
  }
  st.metroBuf = buf;
}

// ------------------------------------------------------------------ audio
function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.connect(ctx.destination);
  metroGain = ctx.createGain(); metroGain.connect(master);
}
const bufCache = new WeakMap();
function audioBuf(arr) {
  let b = bufCache.get(arr);
  if (!b) { b = ctx.createBuffer(1, arr.length, SR); b.copyToChannel(arr, 0); bufCache.set(arr, b); }
  return b;
}
function loopRange() {
  if (!$('chkLoop').checked || !st.score) return null;
  const a = findMeasureSeq($('numLoopA').value), b0 = findMeasureSeq($('numLoopB').value, a);
  if (a < 0 || b0 < 0) return null;
  const sA = st.score.seq[a], sB = st.score.seq[Math.max(a, b0)];
  const t0 = qToSec(st.score, sA.startQ) / st.speed, t1 = qToSec(st.score, sB.startQ + sB.lenQ) / st.speed;
  return t1 - t0 > 0.2 ? { t0, t1 } : null;
}
async function play() {
  if (!st.ready) { say(st.score ? 'Espere a que terminen de generarse las voces.' : 'Primero abra una partitura.'); return; }
  ensureCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  stopSources();
  const loop = loopRange();
  let from = st.pos;
  if (from >= st.totalSec - 0.05) from = 0;
  if (loop && (from < loop.t0 || from >= loop.t1)) from = loop.t0;
  let lead = 0.06;
  if ($('chkCount').checked) lead += scheduleCountIn(from, ctx.currentTime + 0.06);
  const when = ctx.currentTime + lead;
  const startSrc = (arr, dest) => {
    const s = ctx.createBufferSource(); s.buffer = audioBuf(arr); s.connect(dest);
    if (loop) { s.loop = true; s.loopStart = loop.t0; s.loopEnd = loop.t1; }
    s.start(when, from); sources.push(s);
  };
  for (const t of st.tracks) {
    if (!t.buf) continue;
    let n = nodes.get(t.id);
    if (!n) {
      n = { v: ctx.createGain(), g: ctx.createGain(), p: ctx.createStereoPanner() };
      n.v.connect(n.p); n.g.connect(n.p); n.p.connect(master);
      nodes.set(t.id, n);
    }
    startSrc(t.buf.voice, n.v); startSrc(t.buf.guide, n.g);
  }
  if (st.metroBuf) startSrc(st.metroBuf, metroGain);
  applyGains();
  st.playing = true; st.startCtx = when; st.startPos = from; st.loop = loop;
  setPlayLabel();
  say(`Reproduciendo desde el compás ${measureLabel(from)}`);
  requestAnimationFrame(tickUI);
}
function scheduleCountIn(from, at) {
  const q = secToQ(st.score, from * st.speed);
  const s = st.score.seq[Math.max(0, seqAt(q))];
  const { beatQ, n } = beatsOf(s);
  const t = st.score.tempo; let k = t.length - 1; while (k > 0 && t[k].q > q) k--;
  const beatSec = beatQ * 60 / t[k].bpm / st.speed;
  const vol = Math.max(0.15, Math.pow(+$('rngMetro').value / 100, 1.4)) * (+$('rngMaster').value / 100);
  for (let i = 0; i < n; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = i === 0 ? 1760 : 1175;
    const t0 = at + i * beatSec;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.08);
  }
  return n * beatSec;
}
function stopSources() { for (const s of sources) { try { s.stop(); } catch (e) { /* ya parado */ } } sources = []; }
function currentPos() {
  if (!st.playing) return st.pos;
  let p = st.startPos + Math.max(0, ctx.currentTime - st.startCtx);
  const L = st.loop;
  if (L && p >= L.t1) p = L.t0 + ((p - L.t0) % (L.t1 - L.t0));
  return p;
}
function pause() {
  if (!st.playing) return;
  st.pos = currentPos(); st.playing = false; stopSources(); setPlayLabel();
  updatePosition(true);
  say(`Pausa en el compás ${measureLabel(st.pos)}`);
}
function stop(announce = true) {
  st.playing = false; stopSources(); st.pos = 0; setPlayLabel();
  if (st.score) updatePosition(true);
  if (announce) say('Detenido. Al inicio.');
}
function togglePlay() { st.playing ? pause() : play(); }
function seek(t, announce = true) {
  if (!st.score) return;
  t = Math.max(0, Math.min(st.totalSec, t));
  const was = st.playing;
  if (was) { st.playing = false; stopSources(); }
  st.pos = t;
  updatePosition(true);
  if (was) play(); else if (announce) say(`Compás ${measureLabel(t)}`);
}
function setPlayLabel() {
  $('playLabel').textContent = st.playing ? 'Pausar' : 'Reproducir';
  $('playIcon').setAttribute('d', st.playing ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M7 4l13 8-13 8z');
}
function setTransportEnabled(on) {
  for (const id of ['btnPlay', 'btnStop', 'btnPrev', 'btnNext']) $(id).disabled = !on;
}

// ------------------------------------------------------------------ posición
function seqAt(q) {
  const s = st.score.seq; let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].startQ <= q + 1e-9) lo = m; else hi = m - 1; }
  return lo;
}
function posInfo(t) {
  const q = secToQ(st.score, t * st.speed);
  const si = seqAt(q), s = st.score.seq[si];
  const inQ = q - s.startQ;
  const { list } = beatsOf(s);
  let beat = list.length ? list[0].beat : 1;
  for (const b of list) if (b.q <= q + 1e-6) beat = b.beat;
  const info = st.score.measInfo[s.mi];
  return { si, s, q, inQ, beat, number: info.number, pass: s.pass, origQ: st.score.origStart[s.mi] + inQ };
}
function measureLabel(t) { if (!st.score) return '–'; const p = posInfo(t); return p.number + (p.pass > 1 ? ` (repetición ${p.pass})` : ''); }
function fmtTime(s) { s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function fmtTimeWords(s) { const m = Math.floor(s / 60), r = Math.round(s % 60); return (m ? `${m} ${m === 1 ? 'minuto' : 'minutos'} ` : '') + `${r} segundos`; }
let lastPosKey = '';
function updatePosition(force = false) {
  if (!st.score) return;
  const t = currentPos();
  const p = posInfo(t);
  const key = `${p.si}|${p.beat}|${Math.floor(t)}`;
  if (key !== lastPosKey || force) {
    lastPosKey = key;
    $('posMeasure').textContent = p.number;
    $('posOf').textContent = p.pass > 1 ? ` (rep. ${p.pass})` : '';
    $('posBeat').textContent = p.beat;
    $('posTime').textContent = `${fmtTime(t)} / ${fmtTime(st.totalSec)}`;
  }
  updateLyrics(t, force);
  highlightScore(p.origQ, force);
}
function tickUI() {
  if (!st.playing) return;
  const t = currentPos();
  if (!st.loop && t >= st.totalSec) { st.playing = false; stopSources(); st.pos = 0; setPlayLabel(); updatePosition(true); say('Fin de la partitura.'); return; }
  updatePosition();
  requestAnimationFrame(tickUI);
}
function findMeasureSeq(num, from = 0) {
  const s = st.score.seq, info = st.score.measInfo;
  const n = String(num).trim();
  for (let i = from; i < s.length; i++) if (info[s[i].mi].number === n) return i;
  for (let i = 0; i < s.length; i++) if (info[s[i].mi].number === n) return i;
  const k = parseInt(n);
  return k >= 1 ? Math.min(s.length - 1, k - 1) : -1;
}
function seekSeq(i) {
  const s = st.score.seq[Math.max(0, Math.min(st.score.seq.length - 1, i))];
  seek(qToSec(st.score, s.startQ) / st.speed);
}
function prevMeasure() {
  if (!st.score) return;
  const t = currentPos(), p = posInfo(t);
  const into = t - qToSec(st.score, p.s.startQ) / st.speed;
  seekSeq(into > 0.4 ? p.si : p.si - 1);
}
function nextMeasure() { if (st.score) seekSeq(posInfo(currentPos()).si + 1); }
function gotoMeasurePrompt() { closeMenus(); $('numGoto').focus(); $('numGoto').select(); }
function announcePosition() {
  if (!st.score) { say('No hay partitura abierta.', true); return; }
  const t = currentPos(), p = posInfo(t);
  const syl = currentSyllable(t);
  say(`Compás ${p.number}${p.pass > 1 ? ', repetición ' + p.pass : ''}, pulso ${p.beat}. ${fmtTimeWords(t)} de ${fmtTimeWords(st.totalSec)}.${syl && syl.wordText ? ' Letra: ' + syl.wordText : ''}`, true);
}
$('btnPlay').onclick = togglePlay;
$('btnStop').onclick = () => stop();
$('btnPrev').onclick = prevMeasure;
$('btnNext').onclick = nextMeasure;
$('btnGoto').onclick = () => { if (!st.score) return; const i = findMeasureSeq($('numGoto').value); if (i >= 0) seekSeq(i); };
$('numGoto').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btnGoto').click(); } };
$('chkMetro').onchange = () => { applyGains(); say(`Metrónomo ${$('chkMetro').checked ? 'activado' : 'desactivado'}`); };
$('chkCount').onchange = () => say(`Compás de entrada ${$('chkCount').checked ? 'activado' : 'desactivado'}`);
function restartIfPlaying() { if (st.playing) { st.pos = currentPos(); st.playing = false; stopSources(); play(); } }
$('chkLoop').onchange = () => { restartIfPlaying(); say(`Repetir sección ${$('chkLoop').checked ? `activado, compases ${$('numLoopA').value} a ${$('numLoopB').value}` : 'desactivado'}`); };
for (const id of ['numLoopA', 'numLoopB']) $(id).onchange = () => { if ($('chkLoop').checked) restartIfPlaying(); };

// ------------------------------------------------------------------ velocidad, transporte, idioma
function updateSpeedLabel() {
  const v = Math.round(st.speed * 100);
  const bpm = st.score ? ` (negra = ${Math.round(st.score.baseBpm * st.speed)})` : '';
  $('speedVal').textContent = `${v} %${bpm}`;
  $('rngSpeed').setAttribute('aria-valuetext', `${v} por ciento${bpm}`);
}
function setSpeed(v) {
  v = Math.max(40, Math.min(150, Math.round(v / 5) * 5));
  const old = st.speed;
  $('rngSpeed').value = v; st.speed = v / 100; updateSpeedLabel();
  st.pos = st.pos * old / st.speed;
  scheduleRender();
}
$('rngSpeed').oninput = (e) => setSpeed(+e.target.value);
$('numTrans').onchange = (e) => { st.transpose = Math.max(-12, Math.min(12, parseInt(e.target.value) || 0)); e.target.value = st.transpose; scheduleRender(); say(`Transportado ${st.transpose} semitonos. Regenerando.`); };
$('selLang').onchange = (e) => { st.lang = e.target.value; prefs.lang = st.lang; savePrefs(); scheduleRender(); say(`Idioma: ${e.target.selectedOptions[0].text}. Regenerando.`); };

// ------------------------------------------------------------------ letra
let lyrLines = [], lyrIndexKey = '';
function buildLines(tr) {
  const lines = [];
  let line = null, word = null, lastEnd = -1, lastWordId = -1, wordsInLine = 0;
  tr.sylList.forEach((s, i) => {
    const gap = s.start - lastEnd;
    const newWord = s.word !== lastWordId;
    if (!line || (newWord && (gap > 0.05 || wordsInLine >= 7 || s.seqIndex - line.seq >= 2))) { line = { words: [], seq: s.seqIndex }; lines.push(line); wordsInLine = 0; }
    if (newWord) { word = { syls: [] }; line.words.push(word); wordsInLine++; lastWordId = s.word; }
    word.syls.push({ i, text: s.text });
    lastEnd = s.end;
  });
  return lines;
}
function renderLyricsFull() {
  const tr = st.tracks.find(t => t.id === st.lyrTrack);
  lyrLines = tr ? buildLines(tr) : [];
  lyrIndexKey = '';
  $('fullText').textContent = lyrLines.map(l => l.words.map(w => w.syls.map(s => s.text).join('')).join(' ')).join('\n') || 'Esta voz no tiene letra.';
}
function currentSyllable(t) {
  const tr = st.tracks.find(x => x.id === st.lyrTrack);
  if (!tr || !tr.sylList.length) return null;
  const L = tr.sylList;
  let lo = 0, hi = L.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].start <= t + 0.02) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return { idx: -1 };
  return { idx: k, active: t < L[k].end + 0.15, wordText: L.filter(s => s.word === L[k].word).map(s => s.text).join('') };
}
function updateLyrics(t, force) {
  const box = $('lyrics');
  if (!lyrLines.length) {
    const msg = st.score ? 'Esta voz no tiene letra.' : 'La letra aparecerá aquí, sílaba por sílaba, mientras suena.';
    if (box.dataset.empty !== msg) { box.innerHTML = `<div class="lyr-empty">${msg}</div>`; box.dataset.empty = msg; }
    return;
  }
  box.dataset.empty = '';
  const cs = currentSyllable(t);
  const idx = cs ? cs.idx : -1;
  let li = 0;
  for (let k = 0; k < lyrLines.length; k++) if (lyrLines[k].words[0].syls[0].i <= Math.max(idx, 0)) li = k;
  if (idx < 0) li = 0;
  const key = `${li}|${idx}|${cs && cs.active}`;
  if (key === lyrIndexKey && !force) return;
  lyrIndexKey = key;
  const lineHtml = (l, cls) => !l ? `<div class="lyr-line ${cls}">&nbsp;</div>` :
    `<div class="lyr-line ${cls}">${l.words.map(w => `<span class="lyr-word">${w.syls.map(s => {
      const c = s.i < idx ? 'done' : (s.i === idx ? (cs.active ? 'now' : 'done') : '');
      return `<span class="lyr-syl ${c}">${esc(s.text)}</span>`;
    }).join('')}</span>`).join(' ')}</div>`;
  box.innerHTML = lineHtml(lyrLines[li - 1], 'prev') + lineHtml(lyrLines[li], 'cur') + lineHtml(lyrLines[li + 1], 'next');
}

// ------------------------------------------------------------------ apariencia
const hostTheme = document.documentElement.getAttribute('data-theme');
function applyTheme() {
  const t = prefs.theme || 'system';
  if (t === 'system') { if (hostTheme) document.documentElement.setAttribute('data-theme', hostTheme); else document.documentElement.removeAttribute('data-theme'); }
  else document.documentElement.setAttribute('data-theme', t);
}
function effectiveDark() {
  const a = document.documentElement.getAttribute('data-theme');
  if (a) return a === 'dark';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function setTheme(t, announce = true) {
  prefs.theme = t; savePrefs(); applyTheme();
  if (announce) say(t === 'dark' ? 'Fondo oscuro' : t === 'light' ? 'Fondo claro' : 'Tema según el sistema');
}
function toggleTheme() { setTheme(effectiveDark() ? 'light' : 'dark'); }
function setContrast(on, announce = true) {
  if (on) document.documentElement.setAttribute('data-contrast', 'high'); else document.documentElement.removeAttribute('data-contrast');
  prefs.contrast = on; savePrefs();
  if (announce) say(`Alto contraste ${on ? 'activado' : 'desactivado'}`);
}
function setFont(delta) {
  const v = Math.max(1.6, Math.min(7, +((prefs.font || 3) + delta).toFixed(1)));
  prefs.font = v; savePrefs();
  document.documentElement.style.setProperty('--lyric-size', v + 'rem');
  say(`Tamaño de letra ${Math.round(v * 18)} puntos`);
}
const PANELS = [['panelLyrics', 'letra'], ['panelScore', 'partitura'], ['panelMixer', 'mezclador'], ['panelSettings', 'ajustes']];
function panelVisible(id) { return !(prefs.hidden || []).includes(id); }
function togglePanel(id) {
  const h = new Set(prefs.hidden || []);
  if (h.has(id)) h.delete(id); else h.add(id);
  prefs.hidden = Array.from(h); savePrefs(); applyPanels();
  const name = PANELS.find(p => p[0] === id)[1];
  say(`Panel de ${name} ${panelVisible(id) ? 'visible' : 'oculto'}`);
}
function applyPanels() { for (const [id] of PANELS) $(id).hidden = !panelVisible(id); }
function focusPanel(id, headingId) {
  closeMenus();
  if (!panelVisible(id)) togglePanel(id);
  $(headingId).focus();
}

// ------------------------------------------------------------------ partitura (Verovio)
let tk = null, vrvReady = false, timemap = [], activeAt = [], curPage = 1, pageCount = 0, zoom = prefs.zoom || 55;
let hlIds = [], idToQ = new Map(), lastHlKey = '';
async function startViewer() {
  try {
    await loadScript('verovio-toolkit-wasm.js');
    await new Promise((res) => {
      if (verovio.module.calledRun || verovio.module.runtimeInitialized) return res();
      verovio.module.onRuntimeInitialized = res;
    });
    tk = new verovio.toolkit();
    vrvReady = true; diag.viewer = 'listo (Verovio ' + (tk.getVersion ? tk.getVersion() : '') + ')';
    if (st.xml) renderScoreView(); else $('scoreMsg').textContent = 'Abra una partitura para verla aquí.';
  } catch (e) {
    diag.viewer = 'error: ' + e.message;
    $('scoreMsg').textContent = 'No se pudo cargar el visor de partituras. Las voces se generan igual.';
  }
}
function renderScoreView() {
  $('zoomVal').textContent = `Zoom ${zoom} %`;
  if (!vrvReady || !st.xml) return;
  const w = Math.max(320, $('scoreWrap').clientWidth - 4);
  tk.setOptions({
    scale: zoom, pageWidth: Math.round(w * 100 / zoom), adjustPageHeight: true, breaks: 'auto',
    footer: 'none', header: 'auto', pageMarginLeft: 40, pageMarginRight: 40, pageMarginTop: 30, pageMarginBottom: 30,
  });
  if (!tk.loadData(st.xml)) { $('scoreMsg').textContent = 'El visor no pudo dibujar esta partitura, pero las voces sí se generan.'; $('score').innerHTML = ''; return; }
  $('scoreMsg').textContent = '';
  pageCount = tk.getPageCount();
  try { timemap = tk.renderToTimemap({ includeRests: false, includeMeasures: false }); } catch (e) { timemap = []; }
  activeAt = []; idToQ = new Map();
  const act = new Set();
  for (const e of timemap) {
    for (const id of (e.off || [])) act.delete(id);
    for (const id of (e.on || [])) { act.add(id); if (!idToQ.has(id)) idToQ.set(id, e.qstamp); }
    activeAt.push(Array.from(act));
  }
  showPage(1);
}
function showPage(p) {
  if (!vrvReady || !pageCount) return;
  curPage = Math.max(1, Math.min(pageCount, p));
  $('score').innerHTML = tk.renderToSVG(curPage);
  $('pgInfo').textContent = `Página ${curPage} de ${pageCount}`;
  $('scoreWrap').setAttribute('aria-label', `Partitura, página ${curPage} de ${pageCount}`);
  hlIds = []; lastHlKey = '';
  if (st.score) highlightScore(posInfo(currentPos()).origQ, true);
}
function pageBy(d) { if (pageCount) { showPage(curPage + d); say(`Página ${curPage} de ${pageCount}`); } }
function setZoom(z) { zoom = Math.max(25, Math.min(120, z)); prefs.zoom = zoom; savePrefs(); renderScoreView(); say(`Zoom de la partitura ${zoom} por ciento`); }
function highlightScore(origQ, force) {
  if (!vrvReady || !timemap.length) return;
  let lo = 0, hi = timemap.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (timemap[m].qstamp <= origQ + 1e-4) { k = m; lo = m + 1; } else hi = m - 1; }
  const key = String(k);
  if (key === lastHlKey && !force) return;
  lastHlKey = key;
  for (const id of hlIds) document.getElementById(id)?.classList.remove('activa');
  hlIds = k >= 0 ? activeAt[k] : [];
  if (hlIds.length && prefs.follow !== false) {
    const pg = tk.getPageWithElement(hlIds[0]);
    if (pg && pg !== curPage) { curPage = pg; $('score').innerHTML = tk.renderToSVG(pg); $('pgInfo').textContent = `Página ${curPage} de ${pageCount}`; }
  }
  for (const id of hlIds) document.getElementById(id)?.classList.add('activa');
  if (st.playing && prefs.follow !== false && hlIds.length) {
    const el = document.getElementById(hlIds[0]), wrap = $('scoreWrap');
    if (el) {
      const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      if (r.top < wr.top + 20 || r.bottom > wr.bottom - 20) wrap.scrollTop += r.top - wr.top - wrap.clientHeight / 3;
    }
  }
}
$('score').addEventListener('click', (e) => {
  const g = e.target.closest('g.note');
  if (!g || !st.score) return;
  const q = idToQ.get(g.id);
  if (q == null) return;
  for (const s of st.score.seq) {
    const o = st.score.origStart[s.mi];
    if (q >= o - 1e-6 && q < o + s.lenQ - 1e-6) { seek(qToSec(st.score, s.startQ + (q - o)) / st.speed); return; }
  }
});
$('btnPgPrev').onclick = () => pageBy(-1);
$('btnPgNext').onclick = () => pageBy(1);
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderScoreView, 300); });

// ------------------------------------------------------------------ exportación
function mixDown(withMetro) {
  const len = Math.ceil(st.totalSec * SR) + Math.round(SR * 0.5);
  const L = new Float32Array(len), R = new Float32Array(len);
  for (const t of st.tracks) {
    if (!t.buf) continue;
    const { v, g } = effGains(t);
    const a = (t.mix.pan / 100 + 1) * Math.PI / 4, gl = Math.cos(a), gr = Math.sin(a);
    const V = t.buf.voice, G = t.buf.guide, n = Math.min(len, V.length);
    for (let i = 0; i < n; i++) { const x = V[i] * v + G[i] * g; L[i] += x * gl; R[i] += x * gr; }
  }
  if (withMetro && st.metroBuf) {
    const mv = Math.pow(+$('rngMetro').value / 100, 1.4) * (+$('rngMaster').value / 100) * 0.7071;
    const n = Math.min(len, st.metroBuf.length);
    for (let i = 0; i < n; i++) { L[i] += st.metroBuf[i] * mv; R[i] += st.metroBuf[i] * mv; }
  }
  let pk = 1e-9; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  if (pk > 0.98) { const k = 0.98 / pk; for (let i = 0; i < len; i++) { L[i] *= k; R[i] *= k; } }
  return { L, R, len };
}
const to16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
function encodeWav({ L, R, len }) {
  const buf = new ArrayBuffer(44 + len * 4), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + len * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, len * 4, true);
  let o = 44;
  for (let i = 0; i < len; i++) { dv.setInt16(o, to16(L[i]), true); dv.setInt16(o + 2, to16(R[i]), true); o += 4; }
  return new Uint8Array(buf);
}
async function encodeMp3({ L, R, len }) {
  if (!window.lamejs) await loadScript('lame.min.js');
  const enc = new lamejs.Mp3Encoder(2, SR, 128);
  const parts = [], B = 1152;
  const l16 = new Int16Array(B), r16 = new Int16Array(B);
  for (let i = 0; i < len; i += B) {
    const n = Math.min(B, len - i);
    for (let k = 0; k < n; k++) { l16[k] = to16(L[i + k]); r16[k] = to16(R[i + k]); }
    const out = enc.encodeBuffer(n === B ? l16 : l16.subarray(0, n), n === B ? r16 : r16.subarray(0, n));
    if (out.length) parts.push(new Uint8Array(out));
    if (i % (B * 200) === 0) await new Promise(r => setTimeout(r, 0));
  }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  let n = 0; for (const p of parts) n += p.length;
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
function encodeMidi() {
  const PPQ = 480, sc = st.score;
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const utf8 = (s) => Array.from(new TextEncoder().encode(s));
  const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];
  const trackChunk = (events) => {
    events.sort((a, b) => a.t - b.t || a.o - b.o);
    const bytes = []; let last = 0;
    for (const e of events) { bytes.push(...vlq(Math.max(0, e.t - last)), ...e.d); last = e.t; }
    bytes.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes];
  };
  const tick = (q) => Math.round(q * PPQ);
  const t0 = [{ t: 0, o: 0, d: meta(0x03, utf8(sc.title || st.fileBase)) }];
  for (const tp of sc.tempo) {
    const us = Math.round(60e6 / (tp.bpm * st.speed));
    t0.push({ t: tick(tp.q), o: 1, d: meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]) });
  }
  let lastSig = '';
  for (const s of sc.seq) {
    const tm = sc.measInfo[s.mi].time; const k = `${tm.beats}/${tm.beatType}`;
    if (k !== lastSig) { lastSig = k; t0.push({ t: tick(s.startQ), o: 2, d: meta(0x58, [tm.beats, Math.round(Math.log2(tm.beatType)), 24, 8]) }); }
  }
  const chunks = [trackChunk(t0)];
  st.tracks.forEach((tr, i) => {
    let ch = i % 15; if (ch >= 9) ch++;
    const ev = [{ t: 0, o: 0, d: meta(0x03, utf8(tr.name)) }, { t: 0, o: 1, d: [0xc0 | ch, tr.instrumental ? 0 : tr.hasLyrics ? 52 : 0] }];
    for (const n of tr.notes) {
      const a = tick(n.q), b = Math.max(a + 1, tick(n.q + n.d));
      if (n.lyric) ev.push({ t: a, o: 2, d: meta(0x05, utf8(n.lyric.text + ((n.lyric.syllabic === 'begin' || n.lyric.syllabic === 'middle') ? '-' : ''))) });
      for (const m of (tr.instrumental ? (n.all || [n.midi]) : [n.midi])) {
        const k = Math.max(0, Math.min(127, m + st.transpose));
        ev.push({ t: a, o: 3, d: [0x90 | ch, k, tr.instrumental ? 72 : 88] });
        ev.push({ t: b, o: 0, d: [0x80 | ch, k, 0] });
      }
    }
    chunks.push(trackChunk(ev));
  });
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, chunks.length, (PPQ >> 8) & 255, PPQ & 255, ...chunks.flat()]);
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(name, data) {
  const nb = new TextEncoder().encode(name), crc = crc32(data), sz = data.length;
  const lh = new DataView(new ArrayBuffer(30));
  lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
  lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nb.length, true);
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
  cd.setUint32(16, crc, true); cd.setUint32(20, sz, true); cd.setUint32(24, sz, true); cd.setUint16(28, nb.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nb.length, true); end.setUint32(16, 30 + nb.length + sz, true);
  return new Blob([lh.buffer, nb, data, cd.buffer, nb, end.buffer], { type: 'application/zip' });
}
let dlCap;
async function getDownloads() {
  if (dlCap !== undefined) return dlCap;
  dlCap = null;
  try { if (window.claude && typeof window.claude.use === 'function') dlCap = await window.claude.use('downloads'); } catch (e) { dlCap = null; }
  diag.downloads = dlCap ? 'mediante la plataforma (cada archivo dentro de un .zip)' : 'descarga directa del navegador';
  return dlCap;
}
async function offerFile(filename, bytes, mime) {
  const dl = await getDownloads();
  if (dl) {
    const zipName = filename.replace(/\.(\w+)$/, '-$1') + '.zip';
    try {
      await dl.save({ filename: zipName, data: zipStore(filename, bytes) });
      status(`Guardado ${zipName} (contiene ${filename}).`); say(`Archivo guardado: ${zipName}, que contiene ${filename}.`);
    } catch (e) {
      if (e && e.code === 'declined') { status('Descarga cancelada.'); say('Descarga cancelada.'); }
      else status('No se pudo guardar el archivo: ' + (e && e.message || e), true);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  status(`Descargado ${filename}.`); say(`Archivo descargado: ${filename}.`);
}
async function doExport(kind) {
  closeMenus();
  if (!st.score) { say('Primero abra una partitura.', true); return; }
  if ((kind === 'wav' || kind === 'mp3') && !st.ready) { say('Espere a que terminen de generarse las voces.', true); return; }
  try {
    status(`Preparando ${kind.toUpperCase()}…`); say(`Preparando archivo ${kind === 'xml' ? 'MusicXML' : kind.toUpperCase()}`);
    await new Promise(r => setTimeout(r, 30));
    const base = st.fileBase + (st.speed !== 1 && kind !== 'xml' ? `-${Math.round(st.speed * 100)}` : '');
    if (kind === 'wav') await offerFile(base + '.wav', encodeWav(mixDown(st.expMetro)), 'audio/wav');
    if (kind === 'mp3') await offerFile(base + '.mp3', await encodeMp3(mixDown(st.expMetro)), 'audio/mpeg');
    if (kind === 'mid') await offerFile(base + '.mid', encodeMidi(), 'audio/midi');
    if (kind === 'xml') await offerFile(base + '.musicxml', new TextEncoder().encode(st.xml), 'application/vnd.recordare.musicxml+xml');
  } catch (e) { status('Error al exportar: ' + e.message, true); say('Error al exportar.', true); }
}

// ------------------------------------------------------------------ diálogos
function openDialog(id) {
  closeMenus();
  const d = $(id);
  if (id === 'dlgKeys') $('keysBody').innerHTML = KEYS.map(k => `<tr><td><kbd>${k[1]}</kbd></td><td>${k[2]}</td></tr>`).join('');
  if (id === 'dlgDiag') renderDiag();
  if (!d.open) d.showModal();
  const first = d.querySelector('.guide-wrap, .keys-wrap') || d.querySelector('[data-close]');
  first.focus();
}
document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
async function renderDiag() {
  await getDownloads();
  const rows = [
    ['Motor de voz', diag.engine],
    ['Datos de voz', diag.voiceData || '—'],
    ['Visor de partitura', diag.viewer],
    ['Guardado de archivos', diag.downloads || '—'],
    ['Audio del navegador', (window.AudioContext || window.webkitAudioContext) ? 'disponible' + (ctx ? ` (${ctx.state})` : '') : 'no disponible'],
    ['Partitura', st.score ? `${st.score.title || st.fileBase} · ${st.source} · ${st.tracks.length} voces · ${st.score.measInfo.length} compases` : 'ninguna'],
    ['Navegador', navigator.userAgent],
    ['Últimos errores', diag.errors.length ? diag.errors.join(' | ') : 'ninguno'],
  ];
  $('diagList').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

// ------------------------------------------------------------------ menús
const MENUS = [
  { label: 'Archivo', items: [
    { label: 'Abrir partitura (MusicXML, MXL o braille BRF)…', keys: 'Alt+Mayús+O', aria: 'Alt+Shift+O', act: openFileDialog },
    { sep: true, group: 'Ejemplos' },
    { label: 'Ejemplo: Campanero (1 voz)', act: () => { closeMenus(); loadExample('campanero'); } },
    { label: 'Ejemplo: Campanero en canon (4 voces)', act: () => { closeMenus(); loadExample('canon'); } },
    { label: 'Ejemplo en braille: Campanero (BRF)', act: () => { closeMenus(); loadExample('brf'); } },
    { sep: true, group: 'Exportar' },
    { label: 'Exportar audio WAV', keys: 'Alt+Mayús+W', aria: 'Alt+Shift+W', act: () => doExport('wav'), enabled: () => st.ready },
    { label: 'Exportar audio MP3', keys: 'Alt+Mayús+E', aria: 'Alt+Shift+E', act: () => doExport('mp3'), enabled: () => st.ready },
    { label: 'Exportar MIDI', keys: 'Alt+Mayús+I', aria: 'Alt+Shift+I', act: () => doExport('mid'), enabled: () => !!st.score },
    { label: 'Exportar MusicXML', act: () => doExport('xml'), enabled: () => !!st.score },
    { type: 'check', label: 'Incluir el metrónomo en el audio exportado', checked: () => st.expMetro, act: () => { st.expMetro = !st.expMetro; say(`Metrónomo en la exportación ${st.expMetro ? 'incluido' : 'no incluido'}`); } },
  ] },
  { label: 'Reproducción', items: [
    { label: () => st.playing ? 'Pausar' : 'Reproducir', keys: 'Ctrl+Mayús+Espacio', aria: 'Control+Shift+Space Alt+Shift+P', act: () => { closeMenus(); togglePlay(); }, enabled: () => st.ready },
    { label: 'Detener y volver al inicio', keys: 'Alt+Mayús+S', aria: 'Alt+Shift+S', act: () => { closeMenus(); stop(); }, enabled: () => !!st.score },
    { label: 'Compás anterior', keys: 'Alt+Mayús+←', aria: 'Alt+Shift+ArrowLeft', act: () => { closeMenus(); prevMeasure(); }, enabled: () => !!st.score },
    { label: 'Compás siguiente', keys: 'Alt+Mayús+→', aria: 'Alt+Shift+ArrowRight', act: () => { closeMenus(); nextMeasure(); }, enabled: () => !!st.score },
    { label: 'Ir a un compás…', keys: 'Alt+Mayús+G', aria: 'Alt+Shift+G', act: gotoMeasurePrompt },
    { label: 'Decir la posición actual', keys: 'Alt+Mayús+A', aria: 'Alt+Shift+A', act: () => { closeMenus(); announcePosition(); } },
    { sep: true },
    { type: 'check', label: 'Metrónomo', keys: 'Alt+Mayús+M', aria: 'Alt+Shift+M', checked: () => $('chkMetro').checked, act: () => $('chkMetro').click() },
    { type: 'check', label: 'Compás de entrada', checked: () => $('chkCount').checked, act: () => $('chkCount').click() },
    { type: 'check', label: 'Repetir sección', keys: 'Ctrl+Mayús+L', aria: 'Control+Shift+L Alt+Shift+L', checked: () => $('chkLoop').checked, act: () => $('chkLoop').click() },
    { sep: true },
    { label: 'Más rápido (5 %)', keys: 'Alt+Mayús+↑', aria: 'Alt+Shift+ArrowUp', act: () => speedBy(5) },
    { label: 'Más lento (5 %)', keys: 'Alt+Mayús+↓', aria: 'Alt+Shift+ArrowDown', act: () => speedBy(-5) },
  ] },
  { label: 'Ver', items: [
    { sep: true, group: 'Fondo' },
    { type: 'radio', label: 'Fondo claro', checked: () => (prefs.theme || 'system') === 'light', act: () => setTheme('light') },
    { type: 'radio', label: 'Fondo oscuro', checked: () => prefs.theme === 'dark', act: () => setTheme('dark') },
    { type: 'radio', label: 'Fondo según el sistema', checked: () => (prefs.theme || 'system') === 'system', act: () => setTheme('system') },
    { label: 'Cambiar entre claro y oscuro', keys: 'Alt+Mayús+T', aria: 'Alt+Shift+T', act: toggleTheme },
    { type: 'check', label: 'Alto contraste', keys: 'Alt+Mayús+C', aria: 'Alt+Shift+C', checked: () => !!prefs.contrast, act: () => setContrast(!prefs.contrast) },
    { sep: true, group: 'Letra' },
    { label: 'Letra más grande', keys: 'Alt+Mayús+=', aria: 'Alt+Shift+Equal', act: () => setFont(0.4) },
    { label: 'Letra más pequeña', keys: 'Alt+Mayús+-', aria: 'Alt+Shift+Minus', act: () => setFont(-0.4) },
    { sep: true, group: 'Partitura' },
    { label: 'Acercar partitura', keys: 'Alt+Mayús+.', aria: 'Alt+Shift+Period', act: () => setZoom(zoom + 10) },
    { label: 'Alejar partitura', keys: 'Alt+Mayús+,', aria: 'Alt+Shift+Comma', act: () => setZoom(zoom - 10) },
    { label: 'Página siguiente', keys: 'Alt+Mayús+AvPág', aria: 'Alt+Shift+PageDown', act: () => pageBy(1) },
    { label: 'Página anterior', keys: 'Alt+Mayús+RePág', aria: 'Alt+Shift+PageUp', act: () => pageBy(-1) },
    { type: 'check', label: 'Seguir la reproducción', checked: () => prefs.follow !== false, act: () => { prefs.follow = prefs.follow === false; savePrefs(); say(`Seguir la reproducción ${prefs.follow ? 'activado' : 'desactivado'}`); } },
    { sep: true, group: 'Paneles' },
    ...PANELS.map(([id, name]) => ({ type: 'check', label: `Mostrar ${name}`, checked: () => panelVisible(id), act: () => togglePanel(id) })),
    { sep: true },
    { label: 'Ir a la reproducción', keys: 'Alt+Mayús+R', aria: 'Alt+Shift+R', act: () => { closeMenus(); $('btnPlay').focus(); } },
    { label: 'Ir a la letra', act: () => focusPanel('panelLyrics', 'hLetra') },
    { label: 'Ir al mezclador', keys: 'Ctrl+Mayús+X', aria: 'Control+Shift+X Alt+Shift+X', act: () => focusPanel('panelMixer', 'hMix') },
    { label: 'Ir a los ajustes', act: () => focusPanel('panelSettings', 'hSet') },
  ] },
  { label: 'Ayuda', items: [
    { label: 'Cómo funciona Corale', keys: 'Alt+Mayús+H', aria: 'Alt+Shift+H', act: () => openDialog('dlgGuide') },
    { label: 'Atajos de teclado', keys: 'Alt+Mayús+K', aria: 'Alt+Shift+K', act: () => openDialog('dlgKeys') },
    { label: 'Estado del sistema', act: () => openDialog('dlgDiag') },
    { label: 'Acerca de Corale', act: () => openDialog('dlgAbout') },
  ] },
];
function speedBy(d) { setSpeed(st.speed * 100 + d); say(`Velocidad ${Math.round(st.speed * 100)} por ciento`); }

const mb = $('menubar');
let openIdx = -1;
function buildMenubar() {
  mb.innerHTML = '';
  MENUS.forEach((m, i) => {
    const li = document.createElement('li'); li.setAttribute('role', 'none');
    const top = document.createElement('span');
    top.className = 'mb-item'; top.id = `mb-${i}`; top.textContent = m.label;
    top.setAttribute('role', 'menuitem'); top.setAttribute('aria-haspopup', 'menu'); top.setAttribute('aria-expanded', 'false');
    top.tabIndex = i === 0 ? 0 : -1;
    const menu = document.createElement('div');
    menu.className = 'menu'; menu.id = `menu-${i}`; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', m.label); menu.hidden = true;
    top.setAttribute('aria-controls', menu.id);
    li.append(top, menu); mb.appendChild(li);
    top.addEventListener('click', () => { openIdx === i ? closeMenus(true) : openMenu(i, 'first'); });
    top.addEventListener('mouseenter', () => { if (openIdx >= 0 && openIdx !== i) openMenu(i, null); });
    top.addEventListener('keydown', (e) => topKey(e, i));
    menu.addEventListener('keydown', (e) => menuKey(e, i));
  });
}
function renderMenu(i) {
  const menu = $(`menu-${i}`);
  menu.innerHTML = '';
  MENUS[i].items.forEach((it) => {
    if (it.sep) {
      if (menu.children.length) { const s = document.createElement('div'); s.setAttribute('role', 'separator'); menu.appendChild(s); }
      if (it.group) { const g = document.createElement('div'); g.className = 'grp-label'; g.setAttribute('role', 'presentation'); g.setAttribute('aria-hidden', 'true'); g.textContent = it.group; menu.appendChild(g); }
      return;
    }
    const el = document.createElement('div');
    const role = it.type === 'check' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem';
    el.setAttribute('role', role); el.tabIndex = -1;
    const label = typeof it.label === 'function' ? it.label() : it.label;
    const checked = it.checked ? it.checked() : false;
    if (it.type) el.setAttribute('aria-checked', String(checked));
    const enabled = it.enabled ? it.enabled() : true;
    if (!enabled) el.setAttribute('aria-disabled', 'true');
    if (it.aria) el.setAttribute('aria-keyshortcuts', it.aria);
    el.innerHTML = `<span class="chk" aria-hidden="true">${it.type ? (checked ? (it.type === 'radio' ? '●' : '✓') : '') : ''}</span><span>${esc(label)}</span><span class="mk" aria-hidden="true">${it.keys || ''}</span>`;
    el.addEventListener('click', () => activate(it, i));
    el.addEventListener('mouseenter', () => el.focus());
    menu.appendChild(el);
  });
}
function menuItems(i) { return Array.from($(`menu-${i}`).querySelectorAll('[role^="menuitem"]')); }
function openMenu(i, focus) {
  closeMenus(false);
  renderMenu(i);
  openIdx = i;
  const top = $(`mb-${i}`), menu = $(`menu-${i}`);
  setTopTab(i);
  top.setAttribute('aria-expanded', 'true'); menu.hidden = false;
  const items = menuItems(i);
  if (focus === 'first') items[0]?.focus();
  else if (focus === 'last') items[items.length - 1]?.focus();
  else top.focus();
}
function closeMenus(returnFocus = false) {
  if (openIdx < 0) return;
  const i = openIdx; openIdx = -1;
  $(`menu-${i}`).hidden = true;
  $(`mb-${i}`).setAttribute('aria-expanded', 'false');
  if (returnFocus) $(`mb-${i}`).focus();
}
function setTopTab(i) { MENUS.forEach((_, k) => { $(`mb-${k}`).tabIndex = k === i ? 0 : -1; }); }
function focusTop(i) { const n = MENUS.length; i = (i + n) % n; setTopTab(i); $(`mb-${i}`).focus(); return i; }
function activate(it, i) {
  if (it.enabled && !it.enabled()) { say('No disponible ahora.'); return; }
  const keepOpen = it.type === 'check' || it.type === 'radio';
  it.act();
  if (keepOpen && openIdx === i) {
    const idx = menuItems(i).indexOf(document.activeElement);
    renderMenu(i);
    const items = menuItems(i); (items[idx] || items[0]).focus();
  } else if (openIdx === i) closeMenus(false);
}
function topKey(e, i) {
  const k = e.key;
  if (k === 'ArrowRight') { e.preventDefault(); const n = (i + 1) % MENUS.length; openIdx >= 0 ? openMenu(n, 'first') : focusTop(n); }
  else if (k === 'ArrowLeft') { e.preventDefault(); const n = (i - 1 + MENUS.length) % MENUS.length; openIdx >= 0 ? openMenu(n, 'first') : focusTop(n); }
  else if (k === 'ArrowDown' || k === 'Enter' || k === ' ') { e.preventDefault(); openMenu(i, 'first'); }
  else if (k === 'ArrowUp') { e.preventDefault(); openMenu(i, 'last'); }
  else if (k === 'Home') { e.preventDefault(); focusTop(0); }
  else if (k === 'End') { e.preventDefault(); focusTop(MENUS.length - 1); }
  else if (k === 'Escape') { e.preventDefault(); closeMenus(true); }
  else if (k.length === 1 && /\p{L}/u.test(k)) {
    const n = MENUS.findIndex((m, x) => x !== i && m.label.toLowerCase().startsWith(k.toLowerCase()));
    if (n >= 0) { e.preventDefault(); focusTop(n); }
  }
}
function menuKey(e, i) {
  const items = menuItems(i);
  const cur = items.indexOf(document.activeElement);
  const k = e.key;
  if (k === 'ArrowDown') { e.preventDefault(); items[(cur + 1) % items.length].focus(); }
  else if (k === 'ArrowUp') { e.preventDefault(); items[(cur - 1 + items.length) % items.length].focus(); }
  else if (k === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (k === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (k === 'ArrowRight') { e.preventDefault(); openMenu((i + 1) % MENUS.length, 'first'); }
  else if (k === 'ArrowLeft') { e.preventDefault(); openMenu((i - 1 + MENUS.length) % MENUS.length, 'first'); }
  else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(true); }
  else if (k === 'Tab') { closeMenus(false); }
  else if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    const it = MENUS[i].items.filter(x => !x.sep)[cur];
    if (it) activate(it, i);
  } else if (k.length === 1 && /\S/.test(k)) {
    const start = cur + 1;
    for (let s = 0; s < items.length; s++) {
      const el = items[(start + s) % items.length];
      if (el.textContent.trim().toLowerCase().startsWith(k.toLowerCase())) { el.focus(); break; }
    }
  }
}
document.addEventListener('mousedown', (e) => { if (openIdx >= 0 && !mb.contains(e.target)) closeMenus(false); });
mb.addEventListener('focusout', (e) => { if (openIdx >= 0 && e.relatedTarget && !mb.contains(e.relatedTarget)) closeMenus(false); });
function focusMenubar() { closeMenus(false); focusTop(0); say('Barra de menús'); }

// ------------------------------------------------------------------ atajos globales
const KEYS = [
  // 5.º campo: tecla que también funciona con Ctrl+Mayús (sólo donde no choca con el navegador ni con lectores de pantalla)
  ['KeyF', 'Ctrl+Mayús+F, Alt+Mayús+F o F10', 'Ir a la barra de menús', focusMenubar, 'KeyF'],
  ['KeyO', 'Alt+Mayús+O', 'Abrir partitura (MusicXML, MXL o BRF)', openFileDialog],
  ['KeyP', 'Ctrl+Mayús+Espacio o Alt+Mayús+P', 'Reproducir o pausar', togglePlay, 'Space'],
  ['KeyS', 'Alt+Mayús+S', 'Detener y volver al inicio', () => stop()],
  ['ArrowLeft', 'Alt+Mayús+Flecha izquierda', 'Compás anterior', prevMeasure],
  ['ArrowRight', 'Alt+Mayús+Flecha derecha', 'Compás siguiente', nextMeasure],
  ['KeyG', 'Alt+Mayús+G', 'Ir a un compás', gotoMeasurePrompt],
  ['KeyA', 'Alt+Mayús+A', 'Decir la posición y la letra actuales', announcePosition],
  ['KeyM', 'Alt+Mayús+M', 'Metrónomo sí/no', () => $('chkMetro').click()],
  ['KeyL', 'Ctrl+Mayús+L o Alt+Mayús+L', 'Repetir sección sí/no', () => $('chkLoop').click(), 'KeyL'],
  ['ArrowUp', 'Alt+Mayús+Flecha arriba', 'Más rápido (5 %)', () => speedBy(5)],
  ['ArrowDown', 'Alt+Mayús+Flecha abajo', 'Más lento (5 %)', () => speedBy(-5)],
  ['Digit1', 'Ctrl+Mayús+1 a 9 o Alt+Mayús+1 a 9', 'Solo de la voz 1 a 9', null],
  ['Digit0', 'Ctrl+Mayús+0 o Alt+Mayús+0', 'Quitar todos los solos', () => { st.tracks.forEach(t => t.mix.solo = false); refreshTrackButtons(); applyGains(); say('Solos desactivados'); }, 'Digit0'],
  ['KeyT', 'Alt+Mayús+T', 'Cambiar entre fondo claro y oscuro', toggleTheme],
  ['KeyC', 'Alt+Mayús+C', 'Alto contraste sí/no', () => setContrast(!prefs.contrast)],
  ['Equal', 'Alt+Mayús+Igual (=)', 'Letra más grande', () => setFont(0.4)],
  ['Minus', 'Alt+Mayús+Menos (-)', 'Letra más pequeña', () => setFont(-0.4)],
  ['Period', 'Alt+Mayús+Punto', 'Acercar partitura', () => setZoom(zoom + 10)],
  ['Comma', 'Alt+Mayús+Coma', 'Alejar partitura', () => setZoom(zoom - 10)],
  ['PageDown', 'Alt+Mayús+Avance de página', 'Página siguiente de la partitura', () => pageBy(1)],
  ['PageUp', 'Alt+Mayús+Retroceso de página', 'Página anterior de la partitura', () => pageBy(-1)],
  ['KeyR', 'Alt+Mayús+R', 'Ir a los botones de reproducción (allí: P pausa o continúa, S detiene, flechas cambian de compás)', () => $('btnPlay').focus()],
  ['KeyX', 'Ctrl+Mayús+X o Alt+Mayús+X', 'Ir al mezclador', () => focusPanel('panelMixer', 'hMix'), 'KeyX'],
  ['KeyW', 'Alt+Mayús+W', 'Exportar audio WAV', () => doExport('wav')],
  ['KeyE', 'Alt+Mayús+E', 'Exportar audio MP3', () => doExport('mp3')],
  ['KeyI', 'Alt+Mayús+I', 'Exportar MIDI', () => doExport('mid')],
  ['KeyH', 'Alt+Mayús+H', 'Cómo funciona Corale', () => openDialog('dlgGuide')],
  ['KeyK', 'Alt+Mayús+K', 'Lista de atajos de teclado', () => openDialog('dlgKeys')],
];
// teclas sueltas dentro de la barra de reproducción
const TRANSPORT_KEYS = {
  KeyP: togglePlay, KeyS: () => stop(), ArrowLeft: prevMeasure, ArrowRight: nextMeasure,
  KeyA: announcePosition, KeyM: () => $('chkMetro').click(), KeyL: () => $('chkLoop').click(),
};
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
  const tr = $('transporte');
  if (!tr || !tr.contains(document.activeElement) || document.querySelector('dialog[open]')) return;
  const f = TRANSPORT_KEYS[e.code];
  if (!f) return;
  e.preventDefault(); e.stopPropagation(); f();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'F10' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); focusMenubar(); return; }
  const code = e.code === 'NumpadAdd' ? 'Equal' : e.code === 'NumpadSubtract' ? 'Minus' : e.code === 'Numpad0' ? 'Digit0' : e.code;
  // Ctrl+Mayús: sólo las teclas libres en Chrome, Edge, Firefox, JAWS y NVDA
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
    const mc = code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (mc) { e.preventDefault(); toggleSolo(+mc[1] - 1); return; }
    const kc = KEYS.find(x => x[4] === code && x[3]);
    if (kc) { e.preventDefault(); kc[3](); }
    return;
  }
  if (!(e.altKey && e.shiftKey) || e.ctrlKey || e.metaKey) return;
  const m = code.match(/^(?:Digit|Numpad)([1-9])$/);
  if (m) { e.preventDefault(); toggleSolo(+m[1] - 1); return; }
  const k = KEYS.find(x => x[0] === code && x[3]);
  if (k) { e.preventDefault(); k[3](); }
}, true);

// ------------------------------------------------------------------ inicio
try {
  buildMenubar();
  if (prefs.font) document.documentElement.style.setProperty('--lyric-size', prefs.font + 'rem');
  applyTheme();
  if (prefs.contrast) setContrast(true, false);
  if (prefs.lang) { st.lang = prefs.lang; $('selLang').value = prefs.lang; }
  applyPanels();
  $('zoomVal').textContent = `Zoom ${zoom} %`;
  status('Cargando motor de voz…');
  startEngine();
  startViewer();
  getDownloads();
  loadExample('canon');
} catch (e) { reportError(e.message); }
