// ===================================================================== BRF
// Musicografía braille (BRF en ASCII braille norteamericano, o braille Unicode)
// -> MusicXML. Subconjunto: una voz melódica con letra en líneas de texto.
const BRL_ASCII = " A1B'K2L@CIF/MSP\"E3H9O6R^DJG>NTQ,*5<-U8V.%[$+X!&;:4\\0Z7(_?W]#Y)=";
const ASC2DOTS = (() => {
  const m = {};
  for (let i = 0; i < 64; i++) { m[BRL_ASCII[i]] = i; m[BRL_ASCII[i].toLowerCase()] = i; }
  m['`'] = m['@']; m['{'] = m['[']; m['|'] = m['\\']; m['}'] = m[']']; m['~'] = m['^'];
  return m;
})();
const dts = (s) => s.split('').reduce((b, c) => b | (1 << (+c - 1)), 0);

const NOTE_UP = { [dts('145')]: 0, [dts('15')]: 1, [dts('124')]: 2, [dts('1245')]: 3, [dts('125')]: 4, [dts('24')]: 5, [dts('245')]: 6 };
const VAL_BITS = dts('36');
const LARGE = { 0: 0.5, [dts('6')]: 1, [dts('3')]: 2, [dts('36')]: 4 };
const SMALL = { 0: 1 / 32, [dts('6')]: 1 / 16, [dts('3')]: 1 / 8, [dts('36')]: 1 / 4 };
const RESTS = { [dts('134')]: [4, 1 / 4], [dts('136')]: [2, 1 / 8], [dts('1236')]: [1, 1 / 16], [dts('1346')]: [0.5, 1 / 32] };
const OCT = { [dts('4')]: 1, [dts('45')]: 2, [dts('456')]: 3, [dts('5')]: 4, [dts('46')]: 5, [dts('56')]: 6, [dts('6')]: 7 };
const SHARP = dts('146'), FLAT = dts('126'), NATURAL = dts('16');
const AUG = dts('3'), NUM = dts('3456'), WORD = dts('345'), SLUR = dts('14'), TRIP = dts('23');
const UPDIG = { [dts('1')]: 1, [dts('12')]: 2, [dts('14')]: 3, [dts('145')]: 4, [dts('15')]: 5, [dts('124')]: 6, [dts('1245')]: 7, [dts('125')]: 8, [dts('24')]: 9, [dts('245')]: 0 };
const LODIG = { [dts('2')]: 1, [dts('23')]: 2, [dts('25')]: 3, [dts('256')]: 4, [dts('26')]: 5, [dts('235')]: 6, [dts('2356')]: 7, [dts('236')]: 8, [dts('35')]: 9, [dts('356')]: 0 };
const LETTERS = {
  a: '1', b: '12', c: '14', d: '145', e: '15', f: '124', g: '1245', h: '125', i: '24', j: '245', k: '13', l: '123', m: '134',
  n: '1345', o: '135', p: '1234', q: '12345', r: '1235', s: '234', t: '2345', u: '136', v: '1236', w: '2456', x: '1346', y: '13456', z: '1356',
};
const DOTS2LETTER = {};
for (const [k, v] of Object.entries(LETTERS)) DOTS2LETTER[dts(v)] = k;
Object.assign(DOTS2LETTER, { [dts('12356')]: 'á', [dts('2346')]: 'é', [dts('34')]: 'í', [dts('346')]: 'ó', [dts('23456')]: 'ú', [dts('1256')]: 'ü', [dts('12456')]: 'ñ' });
const HYPHEN = dts('36');
// intervalos (acordes): segunda … octava
const IV = { [dts('34')]: 2, [dts('346')]: 3, [dts('3456')]: 4, [dts('35')]: 5, [dts('356')]: 6, [dts('25')]: 7, [dts('36')]: 8 };
const DYN = ['ppp', 'pp', 'mp', 'mf', 'fff', 'ff', 'sfz', 'sf', 'fz', 'fp', 'cresc', 'decresc', 'dim', 'rit', 'rall', 'accel', 'p', 'f']
  .map(w => ({ w, cells: w.split('').map(c => dts(LETTERS[c])) }));

function toCells(line) {
  const out = [];
  for (const ch of line) {
    const c = ch.codePointAt(0);
    if (c >= 0x2800 && c <= 0x28ff) out.push((c - 0x2800) & 63);
    else if (ch === ' ' || ch === '\t') out.push(0);
    else if (ASC2DOTS[ch] !== undefined) out.push(ASC2DOTS[ch]);
    else out.push(-1);
  }
  return out;
}
const isNoteCell = (c) => c > 0 && NOTE_UP[c & 27] !== undefined && (c & ~(27 | VAL_BITS)) === 0;

// Analiza una línea de música. Si state es null sólo cuenta (para clasificar).
function scanMusic(cells, st) {
  let unknown = 0, recognized = 0, notes = 0;
  const ev = [];
  let i = 0, inChord = false;
  const n = cells.length;
  while (i < n) {
    const c = cells[i];
    if (c === 0) { ev.push({ k: 'bar' }); inChord = false; while (i < n && cells[i] === 0) i++; continue; }
    if (c < 0) { unknown++; i++; continue; }
    // intervalo de acorde tras una nota
    if (inChord && IV[c] !== undefined) {
      if (cells[i + 1] === c) { ev.push({ k: 'iv', iv: IV[c], doubled: true }); recognized += 2; i += 2; continue; }
      ev.push({ k: 'iv', iv: IV[c] }); recognized++; i++; continue;
    }
    // signo de repetición (2356) tras una figura: repite el grupo anterior
    if (c === dts('2356') && ev.length && ['note', 'rest', 'iv', 'dot', 'tie'].includes(ev[ev.length - 1].k)) { ev.push({ k: 'rep' }); recognized++; i++; continue; }
    // división de compás (46-13) y acorde parcial (5-2)
    if (c === dts('46') && cells[i + 1] === dts('13')) { ev.push({ k: 'mdiv' }); inChord = false; recognized += 2; i += 2; continue; }
    if (c === dts('5') && cells[i + 1] === dts('2')) { ev.push({ k: 'pinacc' }); inChord = false; recognized += 2; i += 2; continue; }
    // ligadura de acorde (46-14) tras nota
    if (inChord && c === dts('46') && cells[i + 1] === SLUR) { ev.push({ k: 'tie', chord: true }); recognized += 2; i += 2; continue; }
    // corchetes de fraseo (56-12 abre, 45-23 cierra): se omiten
    if ((c === dts('56') && cells[i + 1] === dts('12')) || (c === dts('45') && cells[i + 1] === dts('23'))) { recognized += 2; i += 2; continue; }
    // signo de número: compás, armadura con 4+ alteraciones o número de compás
    if (c === NUM) {
      let j = i + 1, up = '';
      while (j < n && UPDIG[cells[j]] !== undefined) { up += UPDIG[cells[j]]; j++; }
      if (up && (cells[j] === SHARP || cells[j] === FLAT)) { ev.push({ k: 'key', fifths: (cells[j] === SHARP ? 1 : -1) * +up }); recognized += j - i + 1; i = j + 1; continue; }
      let lo = '';
      while (j < n && LODIG[cells[j]] !== undefined) { lo += LODIG[cells[j]]; j++; }
      if (up && lo) ev.push({ k: 'time', beats: +up, beatType: +lo });
      recognized += j - i; i = j; continue;
    }
    // alteraciones: si siguen nota (u octava+nota) son accidentales; si no, armadura
    if (c === SHARP || c === FLAT || c === NATURAL) {
      let j = i; while (j < n && cells[j] === c) j++;
      const cnt = j - i;
      let k = j; if (OCT[cells[k]] !== undefined) { k++; if (OCT[cells[k]] !== undefined) k++; }
      if (isNoteCell(cells[k]) || (inChord && IV[cells[k]] !== undefined)) { ev.push({ k: 'acc', alter: c === SHARP ? cnt : c === FLAT ? -cnt : 0 }); recognized += cnt; i = j; continue; }
      if (c === FLAT && cnt === 1 && cells[j] === dts('13')) { ev.push({ k: 'final' }); recognized += 2; i = j + 1; continue; }
      if (c === FLAT && cnt === 1 && cells[j] === dts('2356')) { ev.push({ k: 'repStart' }); recognized += 2; i = j + 1; continue; }
      if (c === FLAT && cnt === 1 && cells[j] === dts('23')) { ev.push({ k: 'repEnd' }); recognized += 2; i = j + 1; continue; }
      if (c === FLAT && cnt === 1 && cells[j] === WORD) { ev.push({ k: 'inacc' }); inChord = false; recognized += 2; i = j + 1; continue; }
      // calderón (126-123): se omite
      if (c === FLAT && cnt === 1 && cells[j] === dts('123')) { ev.push({ k: 'fermata' }); recognized += 2; i = j + 1; continue; }
      // armadura sólo si va sola o seguida del compás; si no, es un signo que no se interpreta
      if (c !== NATURAL && !(j >= n || cells[j] === 0 || cells[j] === NUM || cells[j] === SHARP || cells[j] === FLAT || cells[j] === dts('46') || cells[j] === dts('456'))) { recognized += cnt + 1; i = j + 1; continue; }
      if (c !== NATURAL) { ev.push({ k: 'key', fifths: c === SHARP ? cnt : -cnt }); recognized += cnt; i = j; continue; }
      unknown++; i++; continue;
    }
    if (c === WORD) {
      const nx = cells[i + 1];
      if ((nx === dts('34') || nx === NUM || nx === dts('346')) && (cells[i + 2] === dts('123') || cells[i + 2] === dts('13'))) { ev.push({ k: 'clef', sign: nx === NUM ? 'F' : nx === dts('346') ? 'C' : 'G' }); recognized += 3; i += 3; continue; }
      let best = null;
      for (const d of DYN) { if (d.cells.every((x, t) => cells[i + 1 + t] === x) && (!best || d.cells.length > best.cells.length)) best = d; }
      if (best) { i += 1 + best.cells.length; recognized += 1 + best.cells.length; if (cells[i] === AUG) { i++; recognized++; } continue; }
      // signo de palabra + celda inferior (respiración, etc.): se omite
      if (LODIG[nx] !== undefined) { recognized += 2; i += 2; if (cells[i] === AUG) { i++; recognized++; } continue; }
      // expresión con letras (p. ej. >S' al inicio de la línea vocal): letras hasta un no-letra, y el terminador de punto 3
      const plain = (x) => /^[a-z]$/.test(DOTS2LETTER[x] || '');
      let j = i + 1;
      let t = j; while (t < n && plain(cells[t]) && t - i <= 10) t++;
      if (cells[t] === AUG && t > j) j = t + 1;           // palabra con terminador
      else if (plain(cells[j])) j = j + 1;                 // abreviatura de una letra
      recognized += j - i; i = j; continue;
    }
    // grupo irregular: 456 + número inferior + 3 (p. ej. _6' seisillo)
    if (c === dts('456') && LODIG[cells[i + 1]] !== undefined && LODIG[cells[i + 1]] > 1 && cells[i + 2] === AUG) { ev.push({ k: 'trip', n: LODIG[cells[i + 1]] }); recognized += 3; i += 3; continue; }
    // articulaciones: staccato (236), tenuto (456-236), acento (46-236), otras (6-236, 56-236, 5-236)
    if (c === dts('236')) { recognized++; i++; continue; }
    if ((c === dts('456') || c === dts('46') || c === dts('6') || c === dts('56') || c === dts('5')) && cells[i + 1] === dts('236')) { recognized += 2; i += 2; continue; }
    // relleno de alineación ('''''): un grupo formado sólo por puntos 3
    if (c === AUG && (i === 0 || cells[i - 1] === 0)) {
      let j = i; while (j < n && cells[j] === AUG) j++;
      if (j >= n || cells[j] === 0) { recognized += j - i; i = j; continue; }
    }
    // signos sin efecto en el canto: 34 fuera de acorde, apoyatura (26)
    if (!inChord && c === dts('34')) { recognized++; i++; continue; }
    if (c === dts('26') && cells[i + 1] === dts('12')) { recognized += 2; i += 2; continue; }
    if (c === dts('26') && (isNoteCell(cells[i + 1]) || OCT[cells[i + 1]] !== undefined)) { ev.push({ k: 'grace' }); recognized++; i++; continue; }
    if ((c === dts('46') || c === dts('456')) && cells[i + 1] === SLUR && !isNoteCell(cells[i + 2])) {
      ev.push(c === dts('46') ? { k: 'time', beats: 4, beatType: 4 } : { k: 'time', beats: 2, beatType: 2 });
      recognized += 2; i += 2; continue;
    }
    if (OCT[c] !== undefined || (c === dts('4') && cells[i + 1] === dts('4'))) {
      let oct = OCT[c], j = i + 1;
      if (c === dts('4') && cells[i + 1] === dts('4')) { oct = 0; j = i + 2; }
      else if (c === dts('6') && cells[i + 1] === dts('6')) { oct = 8; j = i + 2; }
      if (isNoteCell(cells[j]) || (inChord && IV[cells[j]] !== undefined)) { ev.push({ k: 'oct', oct }); recognized += j - i; i = j; continue; }
      if (c === dts('4') && cells[i + 1] === SLUR) { ev.push({ k: 'tie' }); recognized += 2; i += 2; continue; }
      if (c === dts('5') && i === n - 1) { ev.push({ k: 'hyphen' }); recognized++; i++; continue; }
      unknown++; i++; continue;
    }
    if (isNoteCell(c)) {
      const step = NOTE_UP[c & 27], vb = c & VAL_BITS;
      // indicación metronómica: nota + "=" + número
      const dotT = cells[i + 1] === AUG ? 1 : 0;
      if (cells[i + 1 + dotT] === dts('2356') && cells[i + 2 + dotT] === NUM) {
        let j = i + 3 + dotT, up = ''; while (j < n && UPDIG[cells[j]] !== undefined) { up += UPDIG[cells[j]]; j++; }
        if (up) ev.push({ k: 'tempo', bpm: +up * LARGE[vb] * (dotT ? 1.5 : 1) });
        recognized += j - i; i = j; continue;
      }
      ev.push({ k: 'note', step, vb }); inChord = true; notes++; recognized++; i++; continue;
    }
    if (RESTS[c]) { ev.push({ k: 'rest', vals: RESTS[c] }); inChord = false; notes++; recognized++; i++; continue; }
    if (c === AUG) { ev.push({ k: 'dot' }); recognized++; i++; continue; }
    if (c === SLUR) {
      if (cells[i + 1] === SLUR) { ev.push({ k: 'slur2' }); recognized += 2; i += 2; continue; }
      ev.push({ k: 'slur' }); recognized++; i++; continue;
    }
    if (c === TRIP) { ev.push({ k: 'trip', n: 3 }); recognized++; i++; continue; }
    unknown++; i++;
  }
  return { ev, unknown, recognized, notes };
}

function brfDecodeText(cells) {
  let s = '', cap = false;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === dts('46') || c === dts('6')) { cap = true; continue; }
    if (c === 0) { s += ' '; cap = false; continue; }
    if (c === HYPHEN) { s += '-'; continue; }
    if (c === NUM) { while (i + 1 < cells.length && UPDIG[cells[i + 1]] !== undefined) { s += UPDIG[cells[++i]]; } continue; }
    if (c === AUG && DOTS2LETTER[cells[i - 1]] && DOTS2LETTER[cells[i + 1]]) { s += "'"; continue; }
    const L = DOTS2LETTER[c];
    if (L) { s += cap ? L.toUpperCase() : L; cap = false; }
  }
  return s.replace(/\s+/g, ' ').trim();
}

// División silábica del español (para letras sin guiones)
function silabasEs(word, lang = 'es') {
  const w = word.toLowerCase();
  const es = /^es/.test(lang) || /^(qu|ca|gl|eu|pt)/.test(lang);
  const V = 'aeiouáéíóúüàèìòùäöy'.slice(0, es ? 11 : 19), strong = 'aeoáéíóúàèòäö';
  const isV = (c) => V.includes(c);
  // en italiano, latín y alemán las consonantes dobles se separan (bel-la, Stil-le)
  const insep = es ? ['pl', 'pr', 'bl', 'br', 'fl', 'fr', 'cl', 'cr', 'gl', 'gr', 'tr', 'dr', 'tl', 'ch', 'll', 'rr', 'kr', 'kl']
    : ['pl', 'pr', 'bl', 'br', 'fl', 'fr', 'cl', 'cr', 'gl', 'gr', 'tr', 'dr', 'ch', 'kr', 'kl', 'gn', 'qu', 'sch', 'ph', 'th'];
  const units = [];
  for (let i = 0; i < w.length; i++) {
    const two = w.slice(i, i + 2);
    if (!es && w.slice(i, i + 3) === 'sch') { units.push('sch'); i += 2; }
    else if (two === 'ch' || (es && (two === 'll' || two === 'rr'))) { units.push(two); i++; } else units.push(w[i]);
  }
  const nuclei = [];
  for (let i = 0; i < units.length; i++) {
    if (!isV(units[i])) continue;
    const prev = nuclei[nuclei.length - 1];
    const gu = (i >= 1 && (units[i - 1] === 'u') && (units[i - 2] === 'q' || units[i - 2] === 'g') && 'ei'.includes(units[i]));
    if (prev && prev.end === i - 1) {
      const a = units[i - 1], b = units[i];
      const hiatus = strong.includes(a) && strong.includes(b) && !(!es && a === b);
      if (!hiatus || gu) { prev.end = i; continue; }
    }
    if (prev && prev.end === i - 2 && units[i - 1] === 'h' && !(strong.includes(units[i - 2]) && strong.includes(units[i]))) { prev.end = i; continue; }
    nuclei.push({ start: i, end: i });
  }
  if (nuclei.length <= 1) return [word];
  const cuts = [];
  for (let k = 1; k < nuclei.length; k++) {
    const a = nuclei[k - 1].end + 1, b = nuclei[k].start;
    const cons = units.slice(a, b);
    let onset;
    if (cons.length <= 1) onset = cons.length;
    else if (!es && cons.length >= 3 && ['str', 'spr', 'spl', 'schl', 'schr', 'schw', 'schm', 'schn'].includes(cons.slice(-3).join('')) || (!es && ['schl', 'schr', 'schw', 'schm', 'schn'].includes(cons.slice(-2).join('')))) onset = ['schl', 'schr', 'schw', 'schm', 'schn'].includes(cons.slice(-2).join('')) ? 2 : 3;
    else if (!es && /^(st|sp)$/.test(cons.slice(-2).join('')) && /^de/.test(lang)) onset = 2;
    else if (insep.includes(cons.slice(-2).join(''))) onset = 2;
    else onset = 1;
    cuts.push(b - onset);
  }
  const out = []; let p = 0;
  const pos = (u) => units.slice(0, u).join('').length;
  for (const c of cuts) { out.push(word.slice(pos(p), pos(c))); p = c; }
  out.push(word.slice(pos(p)));
  return out.filter(Boolean);
}

// Cantidad estimada de sílabas en inglés
function silabasEnCount(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  w = w.replace(/([^aeiouyszcgx])es$/, '$1').replace(/([^aeiouytd])ed$/, '$1').replace(/([^aeiouyl])e$/, '$1').replace(/^y/, '');
  const m = w.match(/[aeiouy]+/g) || [];
  let n = m.length;
  for (const g of m) if (/^y[aeiou]|[^y]y[aeiou]|i[ao]|eo|ua|ae/.test(g)) n++;
  return Math.max(1, n);
}
// Divide una palabra en exactamente k trozos, cortando entre núcleos vocálicos
function splitWord(word, k, en = false) {
  if (k <= 1) return [word];
  const low = word.toLowerCase();
  if (en && k === 2) {
    // sufijos ingleses frecuentes en letras cantadas
    let m = low.match(/^(.*?([^aeiou])\2)(\2ing)$/) || low.match(/^(.*[aeiouy].*?)(ing)$/);
    if (m) { const cut = m[1].length; if (cut > 0 && cut < word.length) return [word.slice(0, cut), word.slice(cut)]; }
    m = low.match(/^(.*[aeiou](?:[aeiou][^aeiou]|[^aeiou]{2}))(er|est|ed)$/);
    if (m && !/(.)\1$/.test(m[1])) return [word.slice(0, m[1].length), word.slice(m[1].length)];
  }
  const isV = (ch, i) => /[aeiouáéíóúü]/.test(ch) || (ch === 'y' && i > 0 && !/[aeiou]/.test(low[i + 1] || ''));
  let groups = [];
  for (let i = 0; i < low.length; i++) {
    if (!isV(low[i], i)) continue;
    const g = groups[groups.length - 1];
    if (g && g[1] === i - 1) g[1] = i; else groups.push([i, i]);
  }
  // demasiados núcleos: unir los más cercanos (empezando por el final, p. ej. "e" muda)
  while (groups.length > k) {
    let best = groups.length - 2, bg = 1e9;
    for (let t = groups.length - 2; t >= 0; t--) { const gap = groups[t + 1][0] - groups[t][1]; if (gap < bg) { bg = gap; best = t; } }
    groups[best] = [groups[best][0], groups[best + 1][1]]; groups.splice(best + 1, 1);
  }
  // pocos núcleos: separar vocales de un grupo largo
  for (let t = 0; groups.length < k && t < groups.length; t++) {
    const g = groups[t];
    if (g[1] > g[0]) { groups.splice(t, 1, [g[0], g[0]], [g[0] + 1, g[1]]); t = -1; }
  }
  if (groups.length < k) {
    const out = [], L = word.length;
    for (let t = 0; t < k; t++) out.push(word.slice(Math.round(t * L / k), Math.round((t + 1) * L / k)));
    return out.filter(Boolean).length === k ? out : [word];
  }
  const cuts = [];
  for (let t = 1; t < groups.length; t++) {
    const a = groups[t - 1][1] + 1, b = groups[t][0];
    const c = b - a;
    cuts.push(c <= 1 ? b - c : b - ((en ? /^(pl|pr|bl|br|fl|fr|cl|cr|gl|gr|tr|dr|ch|th|sh|ph|wh)$/ : /^(pl|pr|bl|br|fl|fr|cl|cr|gl|gr|tr|dr|ch|ll|rr)$/).test(low.slice(b - 2, b)) ? 2 : 1));
  }
  const out = []; let p = 0;
  for (const c of cuts) { out.push(word.slice(p, c)); p = c; }
  out.push(word.slice(p));
  return out;
}
function detectLyricLang(text) {
  const w = text.toLowerCase().split(/[^a-záéíóúüñ']+/).filter(Boolean);
  const EN = new Set(['the', 'and', 'you', 'of', 'to', 'i', 'my', 'is', 'in', 'it', 'will', 'be', 'for', 'me', 'your', 'all', 'with', 'when', 'oh', 'come', 'love', 'we', 'he', 'she', 'shall', 'thy', 'thee', 'lord']);
  const ES = new Set(['el', 'la', 'de', 'que', 'y', 'en', 'los', 'las', 'mi', 'tu', 'por', 'con', 'del', 'se', 'no', 'un', 'una', 'es', 'al', 'su', 'te', 'yo', 'mi', 'qué', 'señor']);
  const LA = new Set(['et', 'in', 'dominus', 'deus', 'gloria', 'domine', 'kyrie', 'christe', 'eleison', 'sanctus', 'agnus', 'dei', 'est', 'qui', 'nobis', 'pacem', 'ave', 'maria']);
  const DE = new Set(['und', 'der', 'die', 'das', 'ich', 'du', 'nicht', 'ist', 'mit', 'wenn', 'gott', 'nacht', 'dich', 'mein', 'dein', 'ein', 'eine', 'im', 'zu', 'auf', 'wie', 'wird', 'wirst', 'sie', 'er', 'herz', 'liebe', 'guten']);
  const IT = new Set(['il', 'di', 'che', 'non', 'per', 'mio', 'mia', 'cor', 'core', 'amor', 'amore', 'sei', 'ti', 'sono', 'nel', 'della', 'gli', 'del']);
  let en = 0, es = 0, la = 0, de = 0, it = 0;
  for (const x of w) { if (EN.has(x)) en++; if (ES.has(x)) es++; if (LA.has(x)) la++; if (DE.has(x)) de++; if (IT.has(x)) it++; }
  const best = Math.max(en, es, la, de, it);
  if (de === best && de >= 2 && de > es) return 'de';
  if (it === best && it >= 2 && it > es) return 'it';
  if (la > en && la > es && la >= 2) return 'la';
  if (en >= 2 && en > es) return 'en-us';
  if (es >= 2 && es >= en) return 'es-419';
  return null;
}
// Reparte el texto de una línea entre n notas
function alignSyllables(text, n, lang, useHyphens) {
  // el braille español no distingue acento grave: en italiano casi siempre es grave (più, può, è)
  if (/^it/.test(lang)) text = text.replace(/\p{L}+/gu, w => /(ch|n|s|tr|poi|ben|fin)é$/i.test(w) && w.length > 2 || /^(né|sé)$/i.test(w) ? w : w.replace(/[áéíóú]/g, c => ({ á: 'à', é: 'è', í: 'ì', ó: 'ò', ú: 'ù' }[c])).replace(/[ÁÉÍÓÚ]/g, c => ({ Á: 'À', É: 'È', Í: 'Ì', Ó: 'Ò', Ú: 'Ù' }[c])));
  const words = text.split(' ').filter(w => /[a-záéíóúüñ]/i.test(w));
  const syl = [];
  const push = (parts) => parts.forEach((p, i) => syl.push({ text: p, syllabic: parts.length === 1 ? 'single' : i === 0 ? 'begin' : i === parts.length - 1 ? 'end' : 'middle' }));
  if (useHyphens) { for (const w of words) push(w.split('-').filter(Boolean)); return syl; }
  const en = lang.startsWith('en');
  let parts = words.map(w => en ? splitWord(w, silabasEnCount(w), true) : silabasEs(w.replace(/-/g, ''), lang));
  let total = parts.reduce((s, p) => s + p.length, 0);
  if (n > 0 && total !== n) {
    // sinalefa en español: unir final vocálico con inicio vocálico de la palabra siguiente
    if (!en && total > n) {
      for (let i = 0; i < parts.length - 1 && total > n; i++) {
        const a = parts[i], b = parts[i + 1];
        if (/[aeiouáéíóú]$/i.test(a[a.length - 1]) && /^h?[aeiouáéíóúy]/i.test(b[0]) && b.length >= 1) {
          a[a.length - 1] = a[a.length - 1] + '_' + b[0]; b.shift(); total--;
          if (!b.length) { parts.splice(i + 1, 1); i--; }
        }
      }
    }
    const counts = parts.map(p => p.length);
    // máximo de sílabas por palabra: en español, vocales (hiatos); en inglés, grupos vocálicos
    const vowels = words.map(w => en ? Math.max(1, ((w.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) || []).length)) : (w.toLowerCase().match(/[aeiouyáéíóú]/g) || []).length);
    let guard = 200;
    const score = (i) => (i > 0 && /^\p{Lu}/u.test(words[i]) && !/^(I|I'\w+)$/.test(words[i]) ? 10 : 0) + (/[^aeiou]e$/i.test(words[i]) && !/^\p{Lu}/u.test(words[i]) ? -1 : 0) + words[i].length / (counts[i] + 1);
    while (total < n && guard--) {
      let best = -1;
      for (let i = 0; i < counts.length; i++) if (counts[i] < vowels[i] && (best < 0 || score(i) > score(best))) best = i;
      if (best < 0 && !en) for (let i = 0; i < counts.length; i++) if (counts[i] < Math.max(2, vowels[i]) && (best < 0 || score(i) > score(best))) best = i;
      if (best < 0) break;
      counts[best]++; total++;
    }
    while (total > n && guard--) {
      let best = -1;
      for (let i = 0; i < counts.length; i++) if (counts[i] > 1 && (best < 0 || words[i].length / counts[i] < words[best].length / counts[best])) best = i;
      if (best < 0) break;
      counts[best]--; total--;
    }
    parts = parts.map((p, i) => p.length === counts[i] ? p : splitWord(p.join('').replace(/_/g, ' '), counts[i], en));
  }
  for (const p of parts) push(p);
  return syl;
}

function brfToMusicXML(raw, fileName = '', opts = {}) {
  const warnings = [];
  let lines = raw.replace(/\r\n?/g, '\n').replace(/\f/g, '\n').split('\n');
  lines = lines.map(l => l.replace(/\s{3,}#[A-Ja-j]+\s*$/, '').replace(/\s+$/, ''));
  let headerKey = null, headerTime = null, headerBpm = null, headerBpmExact = null, title = '', firstTitle = null;
  const TEMPI = [['grave', 40], ['largo', 50], ['lento', 55], ['adagio', 66], ['andantino', 84], ['andante', 76], ['moderato', 104], ['allegretto', 112], ['allegro', 132], ['vivace', 150], ['presto', 172]];
  const info = [];
  let accompaniment = false;
  const pianoLines = [];
  for (const l of lines) {
    if (accompaniment) { pianoLines.push(l); info.push({ kind: 'skip' }); continue; }
    const indent = l.match(/^\s*/)[0].length;
    const body = l.slice(indent);
    if (!body) { info.push({ kind: 'blank' }); continue; }
    if (firstTitle === null) { const t0 = brfDecodeText(toCells(body)).replace(/\s+\d+$/, ''); firstTitle = /musicxml|audiveris|^\d|^\s*$/i.test(t0) ? '' : t0; }
    // formato compás sobre compás (piano: signos de mano) -> acompañamiento: se omite el resto
    if (/^([A-Ja-j]+\s+)?["._;]>/.test(body) || /^[A-Ja-j]+\s+["._]?>/.test(body)) { accompaniment = true; pianoLines.push(l); info.push({ kind: 'skip' }); continue; }
    const cells = toCells(body);
    // línea sólo con número de compás (#A, #AJ...)
    if (/^#[A-Ja-j]+$/.test(body)) { info.push({ kind: 'mnum' }); continue; }
    const toks0 = body.split(/\s+/);
    const lastSig = toks0.length > 1 && (() => { const r = scanMusic(toCells(toks0[toks0.length - 1]), null); return r.unknown === 0 && r.ev.length && r.ev.every(e => e.k === 'key' || e.k === 'time'); })();
    if (indent >= 6 || (indent >= 3 && lastSig)) {
      // encabezado centrado: título, autor, tempo; puede terminar con armadura y compás
      const toks = body.split(/\s+/);
      const last = scanMusic(toCells(toks[toks.length - 1]), null);
      if (last.unknown === 0 && last.ev.length && last.ev.every(e => e.k === 'key' || e.k === 'time')) {
        for (const e of last.ev) { if (e.k === 'key') headerKey = e.fifths; if (e.k === 'time') headerTime = { beats: e.beats, beatType: e.beatType }; }
      }
      for (const tk of toks) { const sc2 = scanMusic(toCells(tk), null); const te = sc2.ev.find(e => e.k === 'tempo'); if (te && sc2.unknown === 0) headerBpmExact = te.bpm; }
      const txt = brfDecodeText(cells);
      const tw = TEMPI.find(([w]) => txt.toLowerCase().includes(w));
      if (tw && headerBpm == null) headerBpm = tw[1];
      else if (!title && txt && !/audiveris|detected|movement|musicxml|^op\b|^\d/i.test(txt) && !/^[A-Z]?\s*$/.test(txt)) title = txt;
      info.push({ kind: 'header' });
      continue;
    }
    let { music, sc } = brfIsMusic(cells);
    const pfx = brfPrefix(cells);
    // línea sangrada que sigue a una línea de letra: continuación de la letra (p. ej. «    HIN-»)
    const prevInfo = info[info.length - 1];
    if (music && indent >= 3 && prevInfo && prevInfo.kind === 'text' && !(pfx && pfx.kind === 'pmusic') && body[0] !== '>' && brfLooksLikeText(cells)) music = false;
    if (music) { info.push({ kind: 'music', cells, sc, indent, pfx }); continue; }
    info.push({ kind: 'text', cells, indent, pfx });
  }
  if (!info.some(x => x.kind === 'music') && !pianoLines.length) throw new Error('No se reconoció música braille en el archivo. Por ahora se admite una línea melódica en signografía musical braille.');

  // ¿formato coral con prefijos de parte (>S' >A' >T' >B')?
  const pkeys = new Set();
  for (const x of info) if (x.pfx && x.pfx.kind === 'pmusic') pkeys.add(x.pfx.abbr);
  const multi = pkeys.size >= 2 || info.some(x => x.pfx && x.pfx.kind === 'pmusic' && /^[SATB]{2,4}$/.test(x.pfx.abbr)) ||
    (pkeys.size === 1 && info.filter(x => x.pfx && x.pfx.kind === 'pmusic').length > 1 && (() => {
      // la misma parte repetida dentro de un bloque (p. ej. dos tenores)
      let seen = new Set(), dup = false;
      for (const x of info) {
        if (x.kind === 'blank' || x.kind === 'mnum' || x.kind === 'header') { seen = new Set(); continue; }
        if (x.pfx && x.pfx.kind === 'pmusic') { if (seen.has(x.pfx.abbr)) dup = true; seen.add(x.pfx.abbr); }
      }
      return dup;
    })());
  const lyricText = (cells) => brfDecodeText(cells).replace(/^\d+\s*/, '');
  const isJunk = (t) => /musicxml|music xml|audiveris|detected|movement|^part\b|^\s*\w?\s*$/i.test(t);

  // voces: [{ key, name, lines: [{ ev, lyric, unknown, block }] }]
  const voices = [];
  let nBlocks = 0;
  if (!multi) {
    // una sola voz: la letra precede a la línea de música
    const pendingText = [];
    const musicLines = [];
    let seenMusic = false;
    for (const x of info) {
      if (x.kind === 'blank' || x.kind === 'header' || x.kind === 'mnum') {
        if (pendingText.length && !seenMusic && !title) { const cand = pendingText.find(t => !isJunk(t)); if (cand) title = cand; }
        pendingText.length = 0; continue;
      }
      if (x.kind === 'music') seenMusic = true;
      if (x.kind === 'text') pendingText.push(brfDecodeText(x.cells));
      else if (x.kind === 'music') {
        if (x.sc.notes === 0) { if (!title && pendingText.length) title = pendingText.join(' '); pendingText.length = 0; }
        else if (!musicLines.length && pendingText.length > 1 && !title) { title = pendingText.shift(); }
        musicLines.push({ ev: x.sc.ev, lyric: x.sc.notes ? pendingText.join(' ') : '', unknown: x.sc.unknown, block: 0 });
        pendingText.length = 0;
      }
    }
    voices.push({ key: 'V', name: 'Voz', lines: musicLines });
    nBlocks = 1;
  } else {
    // bloques: número de compás, letras (con o sin prefijo) y una línea de música por parte
    const names = {};
    const blocks = [];
    let blk = null, lastLyr = null;
    const newBlock = () => { blk = { lyr: [], mus: [], musOcc: {}, lyrOcc: {} }; blocks.push(blk); lastLyr = null; };
    // >S' letra / >S' música: cuando una parte se repite en dos líneas seguidas, la primera es la letra
    info.forEach((x, i) => {
      const y = info[i + 1];
      if (x.pfx && x.pfx.kind === 'pmusic' && y && y.pfx && (y.pfx.kind === 'pmusic' || y.pfx.kind === 'plyric') && (y.pfx.abbr || y.pfx.abbrs[0]) === x.pfx.abbr && brfLooksLikeText(x.pfx.cells)) {
        x.pfx = { kind: 'plyric', abbrs: [x.pfx.abbr], cells: x.pfx.cells, inline: true }; x.kind = 'text';
      }
    });
    for (const x of info) {
      if (x.kind === 'blank' || x.kind === 'header' || x.kind === 'mnum' || x.kind === 'skip') { blk = null; lastLyr = null; continue; }
      const p = x.pfx;
      if (p && p.kind === 'pname') { names[p.abbr] = p.name; continue; }
      if (p && p.kind === 'pmusic') {
        if (!blk) newBlock();
        const occ = (blk.musOcc[p.abbr] = (blk.musOcc[p.abbr] || 0) + 1);
        blk.mus.push({ abbr: p.abbr, occ, ev: p.sc.ev, unknown: p.sc.unknown });
        lastLyr = null; continue;
      }
      // en este formato toda línea sin prefijo de música es letra
      // texto: letra
      const inline = p && p.kind === 'plyric' && p.inline;
      if (blk && blk.mus.length && !inline) newBlock();
      if (!blk) newBlock();
      if (!p && x.indent >= 3 && lastLyr) { lastLyr.text += ' ' + lyricText(x.cells); continue; }
      if (p && p.kind === 'plyric') {
        const keys = p.abbrs.flatMap(a => { const o = (blk.lyrOcc[a] = (blk.lyrOcc[a] || 0) + 1); return brfExpandAbbr(a).map(b => b + '#' + o); });
        lastLyr = { keys, text: lyricText(p.cells) };
      } else lastLyr = { keys: null, text: lyricText(x.cells) };
      blk.lyr.push(lastLyr);
    }
    // partes en orden de partitura (S, A, T, B…)
    const partSet = new Map();
    blocks.forEach(b => b.mus.forEach(mu => brfExpandAbbr(mu.abbr).forEach(a => { const k = a + '#' + mu.occ; if (!partSet.has(k)) partSet.set(k, { a, occ: mu.occ, first: partSet.size }); })));
    const plist = Array.from(partSet.entries()).sort((x, y) => ((BRF_ORDER[x[1].a] ?? 9) - (BRF_ORDER[y[1].a] ?? 9)) || (x[1].occ - y[1].occ) || (x[1].first - y[1].first));
    const cnt = {};
    for (const [, v] of plist) cnt[v.a] = (cnt[v.a] || 0) + 1;
    for (const [k, v] of plist) {
      const nm0 = names[v.a] && names[v.a].length > 2 ? names[v.a].toLowerCase().replace(/^\p{L}/u, c => c.toUpperCase()) : (BRF_PNAME[v.a] || v.a);
      voices.push({ key: k, name: cnt[v.a] > 1 ? `${nm0} ${v.occ}` : nm0, lines: [] });
    }
    const byKey = new Map(voices.map(v => [v.key, v]));
    blocks.forEach((b, bi) => {
      for (const mu of b.mus) {
        const targets = brfExpandAbbr(mu.abbr).map(a => a + '#' + mu.occ);
        const cand = [mu.abbr + '#' + mu.occ, ...targets];
        const pref = b.lyr.filter(l => l.keys && l.keys.some(k => cand.includes(k)));
        const lyric = (pref.length ? pref : b.lyr.filter(l => !l.keys)).map(l => l.text).join(' ').trim();
        for (const t of targets) byKey.get(t).lines.push({ ev: mu.ev, lyric, unknown: mu.unknown, block: bi });
      }
    });
    nBlocks = blocks.length;
    if (!title) { const t0 = blocks.length && blocks[0].lyr[0]; if (t0) title = t0.text; }
  }
  if (firstTitle) title = firstTitle;
  title = title.replace(/\s+/g, ' ').trim();
  if (title && title === title.toLowerCase()) title = title.replace(/^\p{L}/u, c => c.toUpperCase());
  const allLines = voices.flatMap(v => v.lines);
  const allLyric = allLines.map(m => m.lyric).join(' ');
  const lang = opts.lang && opts.lang !== 'auto' ? opts.lang : (detectLyricLang(allLyric) || 'es-419');
  const anyHyphen = allLines.some(m => /\p{L}-\p{L}/u.test(m.lyric));
  const unknownTotal = Array.from(new Set(allLines)).reduce((s, m) => s + m.unknown, 0);
  if (unknownTotal) warnings.push(`${unknownTotal} signos braille no reconocidos se omitieron.`);

  // ---- construir compases (todas las voces avanzan juntas, bloque por bloque)
  const init = { headerKey, headerTime };
  const builders = voices.map(v => brfVoiceBuilder(init, warnings, voices.length > 1 ? v.name : ''));
  for (let bi = 0; bi < nBlocks; bi++) {
    if (voices.length > 1) {
      const target = Math.max(...builders.map(b => b.count()));
      builders.forEach(b => b.padTo(target));
    }
    // una parte doble (dos tenores) con una sola línea en el bloque: va a la voz de altura más cercana
    if (voices.length > 1) {
      const groups = {};
      voices.forEach((v, vi) => { const a = v.key.split('#')[0]; (groups[a] = groups[a] || []).push(vi); });
      for (const idx of Object.values(groups)) {
        if (idx.length < 2) continue;
        const here = idx.filter(vi => voices[vi].lines.some(ml => ml.block === bi));
        if (here.length !== 1 || here[0] !== idx[0]) continue;
        const ml = voices[idx[0]].lines.filter(l => l.block === bi);
        const lastLyr = (vi) => { const ls = voices[vi].lines.filter(l => l.block < bi && l.lyric); return ls.length ? ls[ls.length - 1].lyric : ''; };
        let best = idx[0];
        const lyr = ml.map(l => l.lyric).join(' ').trim();
        const hy = idx.filter(vi => /-$/.test(lastLyr(vi)));
        if (/^-/.test(lyr) && hy.length === 1) best = hy[0];
        if (best !== idx[0]) {
          voices[idx[0]].lines = voices[idx[0]].lines.filter(l => l.block !== bi);
          voices[best].lines.push(...ml);
        }
      }
    }
    voices.forEach((v, vi) => { for (const ml of v.lines) if (ml.block === bi) builders[vi].feed(ml, lang, anyHyphen); });
  }
  if (voices.length > 1) { const target = Math.max(...builders.map(b => b.count())); builders.forEach(b => b.padTo(target)); }
  builders.forEach(b => b.finish());
  const vParts = voices.map((v, vi) => ({ ...v, measures: builders[vi].measures, b: builders[vi] }));
  const fifths = headerKey != null ? headerKey : builders[0].fifths();
  const bpm = builders.map(b => b.bpm).find(x => x != null) || headerBpmExact || headerBpm || 80;

  // ---- compás vigente en cada compás (común a todas las voces)
  const nMeasV = Math.max(0, ...vParts.map(p => p.measures.length));
  const timeAt = [], keyAt = [];
  for (const p of vParts) p.measures.forEach((m, mi) => { if (m.time && !timeAt[mi]) timeAt[mi] = m.time; if (m.key != null && keyAt[mi] == null) keyAt[mi] = m.key; });
  // cambios de compás escritos sólo en el compás sobre compás (p. ej. #D4 en el piano)
  if (pianoLines.length) {
    try {
      const pre = brfParsePiano(pianoLines, [], [], headerKey || 0, []);
      for (const [mi, b] of Object.entries(pre.bars)) if (b.time && !timeAt[+mi] && +mi > 0) timeAt[+mi] = b.time;
    } catch (e) { /* se informa más abajo */ }
  }
  let tSig = headerTime || { beats: 4, beatType: 4 };
  const sigs = [];
  for (let mi = 0; mi < nMeasV; mi++) { if (timeAt[mi]) tSig = timeAt[mi]; sigs[mi] = { ...tSig }; }

  // ---- resolver valores (braille no distingue, p. ej., blanca de fusa)
  const measLen = [];
  for (const p of vParts) {
    const who = vParts.length > 1 ? p.name.toLowerCase() : 'la voz';
    p.measures.forEach((m, mi) => {
      m.sig = sigs[mi];
      const expected = m.sig.beats * 4 / m.sig.beatType;
      const items = m.items;
      if (!items.length) return;
      if (items.length === 1 && items[0].k === 'rest' && items[0].large === 4) { items[0].measureRest = true; items[0].value = expected; }
      else if (!brfResolve(items, expected)) {
        const sum = items.reduce((t, it) => t + brfDur(it), 0);
        if (!(mi === 0 && sum < expected) && !(mi === p.measures.length - 1 && sum < expected) && Math.abs(sum - expected) > 1e-6) {
          warnings.push(`El compás ${mi + 1} de ${who} no suma lo que indica el compás (${sum} de ${expected} negras).`);
        }
      }
      if (items.length === 1 && items[0].k === 'rest' && items[0].large === 4) { items[0].measureRest = true; items[0].value = expected; }
      const len = items.reduce((t, it) => t + (it.measureRest ? expected : brfDur(it)), 0);
      measLen[mi] = Math.max(measLen[mi] || 0, len);
    });
  }
  for (let mi = 0; mi < nMeasV; mi++) if (!measLen[mi]) measLen[mi] = sigs[mi].beats * 4 / sigs[mi].beatType;

  // ---- piano (compás sobre compás)
  let piano = null;
  if (pianoLines.length) {
    try { piano = brfParsePiano(pianoLines, measLen, sigs, fifths, warnings); }
    catch (e) { warnings.push('No se pudo leer el acompañamiento de piano: ' + e.message); }
  }
  // repeticiones y barra final: comunes a todas las partes
  const repStartAt = [], repEndAt = [], finalAt = [];
  for (const p of vParts) p.measures.forEach((m, mi) => { if (m.repStart) repStartAt[mi] = true; if (m.repEnd) repEndAt[mi] = true; if (m.final) finalAt[mi] = true; });
  if (piano) for (const [mi, b] of Object.entries(piano.bars)) { if (b.repEnd) repEndAt[+mi] = true; if (b.repStart) repStartAt[+mi] = true; }
  if (!nMeasV && piano && piano.voice) {
    warnings.push('No se encontró la sección vocal con letra; la voz se tomó del compás sobre compás, sin letra.');
  }

  // ---- MusicXML
  const DIV = 96;
  const nMeas = Math.max(nMeasV, piano ? piano.count : 0);
  const sigAt = (mi) => sigs[mi] || sigs[sigs.length - 1] || tSig;
  const lenAt = (mi) => Math.round((measLen[mi] || (sigAt(mi).beats * 4 / sigAt(mi).beatType)) * DIV);
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n';
  const ttl = title || fileName.replace(/\.[^.]+$/, '');
  x += `<work><work-title>${brfEsc(ttl)}</work-title></work>\n`;
  x += '<identification><encoding><software>Corale (importación BRF)</software></encoding></identification>\n';
  x += '<part-list>';
  vParts.forEach((p, pi) => { x += `<score-part id="P${pi + 1}"><part-name>${brfEsc(p.name)}</part-name></score-part>`; });
  const pianoId = 'P' + (vParts.length + 1);
  if (piano) x += `<score-part id="${pianoId}"><part-name>Piano</part-name></score-part>`;
  x += '</part-list>\n';
  const barlinesRight = (mi) => repEndAt[mi] ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>\n'
    : (finalAt[mi] || mi === nMeas - 1) ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>\n' : '';
  const barlineLeft = (mi) => repStartAt[mi] ? '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>\n' : '';
  vParts.forEach((p, pi) => {
    const allNotes = p.measures.flatMap(m => m.items.filter(i => i.k === 'note'));
    const avgOct = allNotes.length ? allNotes.reduce((t, nt) => t + nt.oct * 7 + nt.step, 0) / allNotes.length / 7 : 4.5;
    const clefSign = p.b.clef || (avgOct < 3.9 ? 'F' : 'G');
    const tenorClef = clefSign === 'G' && avgOct < 4.3 && /^T/.test(p.key);
    x += `<part id="P${pi + 1}">\n`;
    for (let mi = 0; mi < nMeas; mi++) {
      const m = p.measures[mi] || { items: [] };
      const sig = sigAt(mi);
      x += `<measure number="${mi + 1}">\n`;
      x += barlineLeft(mi);
      if (mi === 0 || timeAt[mi] || keyAt[mi] != null) {
        x += '<attributes>';
        if (mi === 0) x += `<divisions>${DIV}</divisions>`;
        if (mi === 0 || keyAt[mi] != null) x += `<key><fifths>${keyAt[mi] != null ? keyAt[mi] : (headerKey != null ? headerKey : fifths)}</fifths></key>`;
        if (mi === 0 || timeAt[mi]) x += `<time><beats>${sig.beats}</beats><beat-type>${sig.beatType}</beat-type></time>`;
        if (mi === 0) x += clefSign === 'F' ? '<clef><sign>F</sign><line>4</line></clef>' : tenorClef ? '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>' : '<clef><sign>G</sign><line>2</line></clef>';
        x += '</attributes>\n';
      }
      if (mi === 0 && pi === 0) x += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(bpm)}"/></direction>\n`;
      if (!m.items.length) x += `<note><rest measure="yes"/><duration>${lenAt(mi)}</duration><voice>1</voice></note>\n`;
      let used = 0;
      for (const it of m.items) { x += brfNoteXml(it, 1, 0, DIV); used += it.measureRest ? lenAt(mi) : Math.max(1, Math.round(brfDur(it) * DIV)); }
      if (m.items.length && used < lenAt(mi) && mi > 0) x += `<forward><duration>${lenAt(mi) - used}</duration><voice>1</voice></forward>\n`;
      x += barlinesRight(mi);
      x += '</measure>\n';
    }
    x += '</part>\n';
  });
  if (piano) {
    x += `<part id="${pianoId}">\n`;
    for (let mi = 0; mi < nMeas; mi++) {
      const len = lenAt(mi);
      const sig = sigAt(mi);
      x += `<measure number="${mi + 1}">\n`;
      if (mi === 0) x += `<attributes><divisions>${DIV}</divisions><key><fifths>${fifths}</fifths></key><time><beats>${sig.beats}</beats><beat-type>${sig.beatType}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>\n`;
      else if (timeAt[mi] || keyAt[mi] != null) x += '<attributes>' + (keyAt[mi] != null ? `<key><fifths>${keyAt[mi]}</fifths></key>` : '') + (timeAt[mi] ? `<time><beats>${sig.beats}</beats><beat-type>${sig.beatType}</beat-type></time>` : '') + '</attributes>\n';
      const hands = [['rh', 1, [1, 2]], ['lh', 2, [5, 6]]];
      let first = true;
      for (const [h, staff, vnums] of hands) {
        const pm = piano[h][mi];
        const layers = pm ? pm.layers.filter((ly, k) => k === 0 || ly.some(it => it.k !== 'gap')) : [];
        if (!layers.length) {
          if (!first) x += `<backup><duration>${len}</duration></backup>\n`;
          x += `<note><rest measure="yes"/><duration>${len}</duration><voice>${vnums[0]}</voice><staff>${staff}</staff></note>\n`;
          first = false; continue;
        }
        layers.slice(0, 2).forEach((ly, k) => {
          if (!first) x += `<backup><duration>${len}</duration></backup>\n`;
          first = false;
          let used = 0;
          for (const it of ly) {
            if (it.k === 'gap') { const d = Math.round(it.dur * DIV); if (d > 0) x += `<forward><duration>${d}</duration><voice>${vnums[k]}</voice><staff>${staff}</staff></forward>\n`; used += d; continue; }
            x += brfNoteXml(it, vnums[k], staff, DIV); used += Math.max(1, Math.round(brfDur(it) * DIV));
          }
          if (used < len) x += `<forward><duration>${len - used}</duration><voice>${vnums[k]}</voice><staff>${staff}</staff></forward>\n`;
        });
      }
      x += barlinesRight(mi);
      x += '</measure>\n';
    }
    x += '</part>\n';
  }
  x += '</score-partwise>\n';
  return { xml: x, warnings: Array.from(new Set(warnings)), title: ttl, measures: nMeas, lang, piano: !!piano, parts: vParts.length };
}

// ---------------------------------------------------------------- partes corales
function brfIsMusic(cells) {
  const sc = scanMusic(cells, null);
  const total = cells.filter(c => c !== 0).length;
  const hasHyphen = cells.some((c, i) => c === HYPHEN && DOTS2LETTER[cells[i - 1]] && DOTS2LETTER[cells[i + 1]]);
  const music = !hasHyphen && sc.unknown / Math.max(1, total) < 0.06 && (sc.notes > 0 || sc.ev.some(e => e.k === 'time' || e.k === 'key'));
  return { music, sc };
}
const BRF_ABBR = ['S', 'S1', 'S2', 'M', 'MS', 'A', 'CO', 'C', 'T', 'BAR', 'BA', 'B', 'CB', 'SA', 'ST', 'AT', 'TB', 'SAT', 'ATB', 'SATB', 'V'];
const BRF_ORDER = { S: 0, M: 1, MS: 1, A: 2, CO: 2, C: 2, T: 3, BAR: 4, BA: 4, B: 5, CB: 6, V: 7 };
const BRF_PNAME = { S: 'Soprano', M: 'Mezzosoprano', MS: 'Mezzosoprano', A: 'Contralto', CO: 'Contralto', C: 'Contralto', T: 'Tenor', BAR: 'Barítono', BA: 'Barítono', B: 'Bajo', CB: 'Contrabajo', V: 'Voz' };
// partes que nombra una abreviatura (SA = soprano y contralto al unísono)
function brfExpandAbbr(a) {
  if (BRF_PNAME[a]) return [a];
  if (/^[SATB]{2,4}$/.test(a)) return a.split('');
  return [a];
}
// Prefijo de parte al inicio de la línea: >S' (música o letra), ,S' / ,T',B' / CO'T'B' (letra), o «.SOPRANO   >S'» (lista de partes)
function brfPrefix(cells) {
  const asc = cells.map(c => c < 0 ? '?' : BRL_ASCII[c]).join('');
  let m = asc.match(/^\.([A-Z][A-Z ]*?)[ "]{2,}>?([A-Z]{1,4})'$/);
  if (m && BRF_ABBR.includes(m[2])) return { kind: 'pname', abbr: m[2], name: m[1].trim() };
  m = asc.match(/^>([A-Z]{1,4})' */);
  if (m && BRF_ABBR.includes(m[1])) {
    const rest = cells.slice(m[0].length);
    const r = brfIsMusic(rest);
    if (r.music || (r.sc.notes > 0 && !brfLooksLikeText(rest) && r.sc.unknown / Math.max(1, rest.filter(c => c !== 0).length) < 0.2)) return { kind: 'pmusic', abbr: m[1], cells: rest, sc: r.sc };
    return { kind: 'plyric', abbrs: [m[1]], cells: rest, inline: true };
  }
  m = asc.match(/^((?:[,>]?[A-Z]{1,4}')+) */);
  if (m) {
    const abbrs = m[1].split("'").filter(Boolean).map(s => s.replace(/^[,>]/, ''));
    if (abbrs.every(a => BRF_ABBR.includes(a))) return { kind: 'plyric', abbrs, cells: cells.slice(m[0].length) };
  }
  return null;
}

// ¿la línea parece texto (palabras con vocales) más que música?
function brfLooksLikeText(cells) {
  const toks = [];
  let cur = [];
  for (const c of cells.concat([0])) { if (c === 0) { if (cur.length) toks.push(cur); cur = []; } else cur.push(c); }
  const real = toks.filter(t => !t.every(c => c === AUG));
  if (!real.length) return false;
  let words = 0;
  for (const t of real) {
    const w = t.filter((c, i) => !(i === 0 && (c === dts('46') || c === dts('6')))).map(c => DOTS2LETTER[c] || ([dts('2'), AUG, dts('256'), dts('25'), dts('235'), HYPHEN, dts('236')].includes(c) ? '' : '#')).join('');
    if (w.length >= 2 && !w.includes('#') && /[aeiouyáéíóúü]/.test(w) && /[^aeiouyáéíóúü]/.test(w)) words++;
  }
  return words / real.length >= 0.5;
}

// altura media aproximada (octava*7 + nota) de una línea que empieza con signo de octava
function brfLinePitch(ev) {
  let prev = null, po = null, sum = 0, k = 0;
  for (const e of ev) {
    if (e.k === 'oct') po = e.oct;
    else if (e.k === 'note') {
      let o;
      if (po != null) o = po; else if (prev == null) return null; else { const p0 = Math.floor(prev / 7); o = p0; let bd = 9; for (const c of [p0 - 1, p0, p0 + 1]) { const d = Math.abs(c * 7 + e.step - prev); if (d < bd) { bd = d; o = c; } } }
      po = null; prev = o * 7 + e.step; sum += prev; k++;
    }
  }
  return k ? sum / k : null;
}

// Construye los compases de una voz a partir de sus líneas de música (con letra)
function brfVoiceBuilder(init, warnings, label) {
  let fifths = init.headerKey || 0, time = init.headerTime || { beats: 4, beatType: 4 };
  const B = { measures: [], bpm: null, clef: null, lineNotes: [] };
  let cur = null, prevAbs = null, pendingOct = null, pendingAcc = null, tripLeft = 0, tupN = 3;
  let tieNext = false, slurLong = false, slurNext = false, graceNext = false, inGrace = false;
  const newMeasure = () => { cur = { items: [], time: null, key: null, acc: {} }; B.measures.push(cur); };
  const keyAlter = (step) => {
    const sharps = [3, 0, 4, 1, 5, 2, 6], flats = [6, 2, 5, 1, 4, 0, 3];
    if (fifths > 0 && sharps.slice(0, fifths).includes(step)) return 1;
    if (fifths < 0 && flats.slice(0, -fifths).includes(step)) return -1;
    return 0;
  };
  newMeasure();
  if (init.headerTime) cur.time = { ...init.headerTime };
  if (init.headerKey != null) cur.key = init.headerKey;
  B.fifths = () => fifths;
  const recent = [];
  B.avgAbs = () => recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  // cantidad de compases ya empezados
  B.count = () => B.measures.length - (cur.items.length ? 0 : 1);
  B.padTo = (n) => {
    if (cur.items.length) newMeasure();
    while (B.measures.length - 1 < n) { cur.pad = true; newMeasure(); }
  };
  B.finish = () => { if (!cur.items.length && !cur.pad) B.measures.pop(); };
  B.feed = (ml, lang, anyHyphen) => {
    const notesThisLine = [];
    let lastWasHyphen = false;
    let skipToBar = false;
    for (const e of ml.ev) {
      lastWasHyphen = false;
      if (skipToBar) { if (e.k !== 'bar') continue; skipToBar = false; }
      switch (e.k) {
        case 'inacc': case 'pinacc': skipToBar = true; break;
        case 'bar': if (cur.items.length) newMeasure(); break;
        case 'hyphen': lastWasHyphen = true; break;
        case 'time': time = { beats: e.beats, beatType: e.beatType }; if (!cur.items.length) cur.time = { ...time }; break;
        case 'key': fifths = e.fifths; if (!cur.items.length) cur.key = fifths; break;
        case 'clef': B.clef = e.sign; break;
        case 'tempo': if (B.bpm == null) B.bpm = e.bpm; break;
        case 'final': cur.final = true; break;
        case 'repStart': if (cur.items.length) newMeasure(); cur.repStart = true; break;
        case 'repEnd': cur.repEnd = true; break;
        case 'grace': graceNext = true; break;
        case 'oct': pendingOct = e.oct; break;
        case 'acc': pendingAcc = e.alter; break;
        case 'trip': tripLeft = tupN = e.n || 3; break;
        case 'dot': { if (inGrace) break; const it = cur.items[cur.items.length - 1]; if (it) it.dots = (it.dots || 0) + 1; break; }
        case 'tie': { if (inGrace) break; const it = cur.items[cur.items.length - 1]; if (it && it.k === 'note') { it.tieStart = true; tieNext = true; } break; }
        case 'slur2': { const it = cur.items[cur.items.length - 1]; if (it) { slurLong = true; } break; }
        case 'slur': { if (inGrace) { inGrace = false; break; } if (slurLong) { slurLong = false; slurNext = true; } else slurNext = true; break; }
        case 'rest': {
          cur.items.push({ k: 'rest', large: e.vals[0], small: e.vals[1], trip: tripLeft > 0 ? tupN : 0 });
          if (tripLeft) tripLeft--;
          pendingOct = null; pendingAcc = null; break;
        }
        case 'note': {
          let oct;
          if (pendingOct != null) oct = pendingOct;
          else if (prevAbs == null) { oct = 4; warnings.push('La primera nota no tenía signo de octava; se asumió la 4.ª octava.'); }
          else {
            const po = Math.floor(prevAbs / 7);
            let best = null;
            for (const o of [po - 1, po, po + 1]) { const d = Math.abs(o * 7 + e.step - prevAbs); if (d <= 2 && (!best || d < best.d)) best = { o, d }; }
            oct = best ? best.o : po;
          }
          pendingOct = null;
          if (graceNext) { graceNext = false; inGrace = true; pendingAcc = null; prevAbs = oct * 7 + e.step; break; }
          inGrace = false;
          const key = e.step + ':' + oct;
          let alter;
          if (pendingAcc != null) { alter = pendingAcc; cur.acc[key] = alter; } else alter = cur.acc[key] !== undefined ? cur.acc[key] : keyAlter(e.step);
          const it = { k: 'note', step: e.step, oct, alter, explicitAcc: pendingAcc, large: LARGE[e.vb], small: SMALL[e.vb], vb: e.vb, trip: tripLeft > 0 ? tupN : 0, tieStop: tieNext, melisma: tieNext || slurNext || slurLong };
          pendingAcc = null; tieNext = false; slurNext = false;
          if (tripLeft) tripLeft--;
          cur.items.push(it); notesThisLine.push(it);
          prevAbs = oct * 7 + e.step;
          recent.push(prevAbs); if (recent.length > 16) recent.shift();
          break;
        }
      }
    }
    if (!lastWasHyphen && cur.items.length) newMeasure();
    if (ml.lyric) {
      const slots = notesThisLine.filter(nt => !nt.melisma);
      const syl = alignSyllables(ml.lyric, slots.length, lang, anyHyphen);
      slots.forEach((nt, k) => { if (k < syl.length) nt.lyric = syl[k]; });
      const who = label ? label + ': ' : '';
      if (syl.length > slots.length) warnings.push(`${who}sobran ${syl.length - slots.length} sílabas en la línea «${ml.lyric.slice(0, 40)}».`);
      else if (syl.length < slots.length) warnings.push(`${who}faltan ${slots.length - syl.length} sílabas en la línea «${ml.lyric.slice(0, 40)}».`);
    }
    B.lineNotes.push(notesThisLine);
  };
  return B;
}

// ---------------------------------------------------------------- utilidades compartidas
function brfDotF(it) { let f = 1, a = 0.5; for (let d = 0; d < (it.dots || 0); d++) { f += a; a /= 2; } return f; }
function brfTupF(n) { if (!n) return 1; if (n === true) n = 3; if (n === 2) return 3 / 2; let p = 1; while (p * 2 < n) p *= 2; return p / n; }
function brfDur(it) { return it.value * brfDotF(it) * brfTupF(it.trip); }
function brfEsc(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Elige para cada figura el valor grande o pequeño (y agrupaciones) para completar 'expected'
function brfResolve(items, expected) {
  const val = (it, base) => base * brfDotF(it) * brfTupF(it.trip);
  let best = null, steps = 0;
  const choice = new Array(items.length);
  const dfs = (i, sum, leader, smalls) => {
    if (++steps > 60000) return;
    if (sum > expected + 1e-6) return;
    if (i === items.length) {
      if (Math.abs(sum - expected) < 1e-6 && (!best || smalls < best.smalls)) best = { smalls, ch: choice.slice() };
      return;
    }
    const it = items[i];
    choice[i] = it.large; dfs(i + 1, sum + val(it, it.large), null, smalls);
    choice[i] = it.small; dfs(i + 1, sum + val(it, it.small), it.k === 'note' ? it.small : null, smalls + 1);
    if (leader && it.k === 'note' && it.vb === 0) { choice[i] = leader; dfs(i + 1, sum + val(it, leader), leader, smalls + 1); }
  };
  if (items.length && items.length <= 28) dfs(0, 0, null, 0);
  if (best) { items.forEach((it, i) => { it.value = best.ch[i]; }); return true; }
  items.forEach(it => { it.value = it.large; });
  return items.length === 0;
}
const BRF_TYPES = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd'], [1 / 16, '64th'], [1 / 32, '128th']];
function brfNoteXml(it, voice, staff, DIV) {
  const typeOf = (v) => (BRF_TYPES.find(t => Math.abs(t[0] - v) < 1e-9) || [0, 'quarter'])[1];
  const dur = Math.max(1, Math.round((it.measureRest ? it.value : brfDur(it)) * DIV));
  const ACC = { '-2': 'flat-flat', '-1': 'flat', '0': 'natural', '1': 'sharp', '2': 'double-sharp' };
  const one = (p, isChord, withLyric) => {
    let x = '<note>';
    if (isChord) x += '<chord/>';
    if (it.k === 'rest') x += it.measureRest ? '<rest measure="yes"/>' : '<rest/>';
    else x += `<pitch><step>${'CDEFGAB'[p.step]}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.oct}</octave></pitch>`;
    x += `<duration>${dur}</duration>`;
    const ts = it.tieStop && (!isChord || it.chordTieStop), tst = it.tieStart && (!isChord || it.chordTie);
    if (ts) x += '<tie type="stop"/>';
    if (tst) x += '<tie type="start"/>';
    x += `<voice>${voice}</voice>`;
    if (!it.measureRest) x += `<type>${typeOf(it.value)}</type>` + '<dot/>'.repeat(it.dots || 0);
    if (it.k === 'note' && p.explicitAcc != null) x += `<accidental>${ACC[p.explicitAcc] || 'natural'}</accidental>`;
    if (it.trip && !it.measureRest) { const n = it.trip === true ? 3 : it.trip; x += `<time-modification><actual-notes>${n}</actual-notes><normal-notes>${Math.round(n * brfTupF(n))}</normal-notes></time-modification>`; }
    if (staff) x += `<staff>${staff}</staff>`;
    if (ts || tst) x += `<notations>${ts ? '<tied type="stop"/>' : ''}${tst ? '<tied type="start"/>' : ''}</notations>`;
    if (withLyric && it.lyric) x += `<lyric number="1"><syllabic>${it.lyric.syllabic}</syllabic><text>${brfEsc(it.lyric.text)}</text></lyric>`;
    return x + '</note>\n';
  };
  let x = one(it, false, true);
  for (const c of (it.chord || [])) x += one(c, true, false);
  return x;
}

// Piano en formato compás sobre compás: etiquetas de compás (A=1 … AJ=10), líneas .> (mano derecha) y _> (izquierda)
function brfParsePiano(lines, measLen, sigs, fifths, warnings) {
  const lab = (t) => parseInt(t.toUpperCase().split('').map(ch => 'JABCDEFGHI'.indexOf(ch)).join(''), 10);
  const src = { rh: new Map(), lh: new Map(), voice: new Map() };
  let curLabel = null;
  for (const raw of lines) {
    const t = raw.replace(/\s+$/, '');
    let hand = null, rest = null, m;
    if ((m = t.match(/^\s*([A-Ja-j]+)\s+(["._])>(.*)$/))) { curLabel = lab(m[1]); hand = m[2]; rest = m[3]; }
    else if ((m = t.match(/^\s*(["._])>(.*)$/)) && curLabel != null) { hand = m[1]; rest = m[2]; }
    else continue;
    const key = hand === '.' ? 'rh' : hand === '_' ? 'lh' : 'voice';
    rest = rest.replace(/^'/, '');
    const segs0 = rest.split(/\s+/).filter(z => z && !/^'+$/.test(z));
    // un grupo que sólo tiene armadura o compás pertenece al compás siguiente
    const segs = [];
    for (let k = 0; k < segs0.length; k++) {
      const r = scanMusic(toCells(segs0[k]), null);
      if (k + 1 < segs0.length && r.unknown === 0 && r.ev.length && r.ev.every(e => e.k === 'time' || e.k === 'key')) { segs0[k + 1] = segs0[k] + segs0[k + 1]; continue; }
      segs.push(segs0[k]);
    }
    segs.forEach((sg, k) => src[key].set(curLabel + k, sg));
  }
  const count = Math.max(0, ...src.rh.keys(), ...src.lh.keys());
  if (!count) throw new Error('no se encontraron líneas de mano derecha ni izquierda');
  const sharps = [3, 0, 4, 1, 5, 2, 6], flats = [6, 2, 5, 1, 4, 0, 3];
  const keyAlter = (step) => (fifths > 0 && sharps.slice(0, fifths).includes(step)) ? 1 : (fifths < 0 && flats.slice(0, -fifths).includes(step)) ? -1 : 0;
  const out = { rh: [], lh: [], count, voice: src.voice.size > 0, bars: {} };
  for (const key of ['voice', 'rh', 'lh']) {
    for (const [num, str] of src[key]) {
      let beforeNote = true;
      for (const e of scanMusic(toCells(str.replace(/^7/, '')), null).ev) {
        if (e.k === 'repEnd' || e.k === 'repStart' || e.k === 'final') (out.bars[num - 1] = out.bars[num - 1] || {})[e.k] = true;
        if (e.k === 'note' || e.k === 'rest') beforeNote = false;
        if (e.k === 'time' && beforeNote) (out.bars[num - 1] = out.bars[num - 1] || {}).time = { beats: e.beats, beatType: e.beatType };
      }
    }
  }
  let problems = 0;
  for (const hand of ['rh', 'lh']) {
    let prevAbs = null;
    const dir = hand === 'lh' ? 1 : -1;
    let tieFrom = null;
    const doubled0 = new Map();   // intervalos duplicados vigentes en la voz principal (cruzan compases)
    for (let num = 1; num <= count; num++) {
      const str = src[hand].get(num);
      const mi = num - 1;
      if (!str) { out[hand][mi] = null; continue; }
      let cellsM = toCells(str);
      let repeatPrev = false;
      if (cellsM[0] === dts('2356')) { repeatPrev = true; cellsM = cellsM.slice(1); }
      const ev = scanMusic(cellsM, null).ev;
      const segs = [{ parts: [[]] }];
      if (repeatPrev) {
        const prev = out[hand][mi - 1];
        if (prev && prev.segsRaw) {
          segs.length = 0;
          for (const sg of prev.segsRaw) segs.push({ parts: sg.parts.map(pp => pp.map(it => ({ ...it, chord: (it.chord || []).map(c => ({ ...c })), tieStop: false, tieStart: false, chordTie: false, chordTieStop: false, _done: true }))) });
        }
      }
      let part = segs[segs.length - 1].parts[0], last = null, pendingOct = null, pendingAcc = null, tripLeft = 0, tupN = 3;
      if (repeatPrev) {
        const fl = part[part.length - 1]; if (fl && fl.k === 'note') last = fl;
        const first = segs[0].parts[0][0];
        if (tieFrom && first && first.k === 'note' && first.step === tieFrom.step && first.oct === tieFrom.oct) { first.tieStop = true; if (tieFrom.chordTie) first.chordTieStop = true; }
        tieFrom = null;
        if (last) prevAbs = last.oct * 7 + last.step;
      }
      const acc0 = {};
      let acc = acc0, doubled = doubled0, group = null;
      const finishChord = () => {
        if (!last || last.k !== 'note' || last._done) return;
        last._done = true;
        // intervalos duplicados no escritos: se insertan según su tamaño
        const written = last._iv || [];
        const list = written.slice();
        for (const [ivn, info] of doubled) {
          if (written.some(w => w.iv === ivn)) continue;
          const at = list.findIndex(w => w.iv > ivn);
          list.splice(at < 0 ? list.length : at, 0, { iv: ivn, acc: null, oct: null });
        }
        let prev = last.oct * 7 + last.step;
        for (const w of list) {
          let abs = last.oct * 7 + last.step + dir * (w.iv - 1);
          if (w.oct != null) abs = w.oct * 7 + (((abs % 7) + 7) % 7);
          else while ((abs - prev) * dir <= 0) abs += dir * 7;
          prev = abs;
          const step = ((abs % 7) + 7) % 7, oct = Math.floor(abs / 7);
          last.chord.push({ step, oct, alter: pitchOf(step, oct, w.acc), explicitAcc: w.acc });
        }
        for (const w of written) {
          if (w.doubled) doubled.set(w.iv, true);
          else if (doubled.has(w.iv)) doubled.delete(w.iv);
        }
        delete last._iv;
      };
      const pitchOf = (step, oct, explicit) => {
        const k = step + ':' + oct;
        let alter;
        if (explicit != null) { alter = explicit; acc[k] = alter; } else alter = acc[k] !== undefined ? acc[k] : keyAlter(step);
        return alter;
      };
      for (const e of ev) {
        if (!['iv', 'oct', 'acc', 'dot', 'tie', 'slur', 'slur2'].includes(e.k)) finishChord();
        switch (e.k) {
          case 'mdiv': segs.push({ parts: [[]] }); part = segs[segs.length - 1].parts[0]; last = null; acc = acc0; doubled = doubled0; group = null; break;
          case 'inacc': case 'pinacc': { const sg = segs[segs.length - 1]; sg.parts.push([]); part = sg.parts[sg.parts.length - 1]; last = null; acc = {}; doubled = new Map(); group = null; break; }
          case 'rep': {
            if (!group) group = part.slice();
            for (const it of group) part.push({ ...it, chord: (it.chord || []).map(c => ({ ...c })), tieStart: false, tieStop: false });
            last = null; break;
          }
          case 'oct': pendingOct = e.oct; break;
          case 'acc': pendingAcc = e.alter; break;
          case 'trip': tripLeft = tupN = e.n || 3; break;
          case 'dot': { const it = part[part.length - 1]; if (it) it.dots = (it.dots || 0) + 1; break; }
          case 'tie': if (last) { last.tieStart = true; if (e.chord) last.chordTie = true; tieFrom = last; } break;
          case 'rest': part.push({ k: 'rest', large: e.vals[0], small: e.vals[1], trip: tripLeft > 0 ? tupN : 0 }); if (tripLeft) tripLeft--; last = null; pendingOct = pendingAcc = null; break;
          case 'note': {
            let oct;
            if (pendingOct != null) oct = pendingOct;
            else if (prevAbs == null) oct = hand === 'lh' ? 3 : 4;
            else {
              const po = Math.floor(prevAbs / 7);
              let best = null;
              for (const o of [po - 1, po, po + 1]) { const d = Math.abs(o * 7 + e.step - prevAbs); if (d <= 2 && (!best || d < best.d)) best = { o, d }; }
              oct = best ? best.o : po;
            }
            const it = { k: 'note', step: e.step, oct, alter: pitchOf(e.step, oct, pendingAcc), explicitAcc: pendingAcc, large: LARGE[e.vb], small: SMALL[e.vb], vb: e.vb, trip: tripLeft > 0 ? tupN : 0, chord: [] };
            if (tieFrom && tieFrom.step === it.step && tieFrom.oct === it.oct) { it.tieStop = true; if (tieFrom.chordTie) it.chordTieStop = true; }
            tieFrom = null;
            pendingOct = pendingAcc = null;
            if (tripLeft) tripLeft--;
            part.push(it); last = it;
            prevAbs = oct * 7 + e.step;
            break;
          }
          case 'iv': {
            if (!last) break;
            (last._iv = last._iv || []).push({ iv: e.iv, acc: pendingAcc, oct: pendingOct, doubled: !!e.doubled });
            pendingOct = pendingAcc = null;
            break;
          }
        }
      }
      finishChord();
      // duraciones: la primera capa completa el compás; las demás, su sección
      const expected = measLen[mi] || ((sigs[mi] || { beats: 4, beatType: 4 }).beats * 4 / (sigs[mi] || { beatType: 4 }).beatType);
      const layer0 = segs.flatMap(sg => sg.parts[0]);
      if (!brfResolve(layer0, expected)) problems++;
      for (const sg of segs) {
        sg.dur = sg.parts[0].reduce((t2, it) => t2 + brfDur(it), 0);
        for (const pp of sg.parts.slice(1)) if (!brfResolve(pp, sg.dur)) problems++;
      }
      if (layer0.length === 1 && layer0[0].k === 'rest' && layer0[0].large === 4) { layer0[0].measureRest = true; layer0[0].value = expected; }
      const layers = [layer0, []];
      for (const sg of segs) {
        if (sg.parts[1] && sg.parts[1].length) layers[1].push(...sg.parts[1]);
        else layers[1].push({ k: 'gap', dur: sg.dur });
      }
      out[hand][mi] = { layers, segsRaw: segs };
    }
  }
  if (problems) warnings.push(`En el piano, ${problems} fragmentos no completaron el compás; revise el resultado exportando MusicXML.`);
  return out;
}
