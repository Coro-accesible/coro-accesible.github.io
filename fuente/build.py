# Construye Corole en la raíz del repositorio a partir de la carpeta fuente/.
# Uso: python3 fuente/build.py
import base64, os, re, json
F = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(F)
esp = open(F + '/espeak-ng.module.js', encoding='utf-8').read()
esp = esp.replace('import.meta.url', '"https://localhost/espeak-ng.js"')
esp = re.sub(r'export default Module;?\s*$', '', esp.rstrip())
eng = open(F + '/engine.js', encoding='utf-8').read()
open(R + '/cantor-engine.js', 'w', encoding='utf-8').write('/* Corole: motor de canto (eSpeak NG, GPL-3.0) */\nself.CANTOR_ENGINE_SRC = function () {\n' + esp + '\nconst createEspeak = Module;\n' + eng + '\n};\n')
data = open(F + '/datos/espeak-ng-data.wasm', 'rb').read()
open(R + '/cantor-voice-data.js', 'w').write('self.CANTOR_VOICE_DATA="' + base64.b64encode(data).decode() + '";\n')
# Piano Salamander (Alexander Holm, CC BY 3.0): 30 notas, una cada tercera menor desde La0
NM = {0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A'}
pn = []
for m in range(21, 109, 3):
    f = F + '/datos/piano/%s%d.mp3' % (NM[m % 12], m // 12 - 1)
    pn.append('[%d,"%s"]' % (m, base64.b64encode(open(f, 'rb').read()).decode()))
open(R + '/cantor-piano.js', 'w').write('/* Salamander Grand Piano V2 (Yamaha C5), de Alexander Holm, CC BY 3.0 */\nself.CANTOR_PIANO=[' + ',\n'.join(pn) + '];\n')
# Coro «Aah» y «Ooh» del banco de sonidos MS Basic de MuseScore (MIT; ver datos/coro/LICENCIA-MS-Basic.md)
zon = json.load(open(F + '/datos/coro/zonas.json', encoding='utf-8'))
b64 = lambda f: base64.b64encode(open(F + '/datos/coro/' + f, 'rb').read()).decode()
for k in zon:
    for z in zon[k]:
        z['d'] = b64(z.pop('f')); fr = z.pop('fr', None)
        if fr: z['dr'] = b64(fr)
open(R + '/cantor-coro.js', 'w').write('/* Coro Aah / Ooh de MS Basic (MuseScore): FluidR3 de Frank Wen, FluidR3Mono de Michael Cowgill,\n   adaptado por S. Christian Collins. Licencia MIT (fuente/datos/coro/LICENCIA-MS-Basic.md). */\nself.CANTOR_CHOIR=' + json.dumps(zon) + ';\n')
ex = {}
for k, f in [('campanero', 'Campanero.musicxml'), ('canon', 'Campanero-canon-SATB.musicxml'), ('brf', 'Campanero.brf')]:
    ex[k] = open(R + '/ejemplos/' + f, encoding='utf-8').read()
open(R + '/cantor-examples.js', 'w', encoding='utf-8').write('self.CANTOR_EXAMPLES=' + json.dumps(ex, ensure_ascii=True) + ';\n')
app = open(F + '/app.js', encoding='utf-8').read()
score = re.sub(r'^export ', '', open(F + '/score.js', encoding='utf-8').read(), flags=re.M)
brf = open(F + '/brf.js', encoding='utf-8').read()
html = open(F + '/head.html', encoding='utf-8').read() + open(F + '/body.html', encoding='utf-8').read() + '\n<script>\n"use strict";\n' + score + '\n' + brf + '\n' + app + '\n</script>\n'
open(R + '/index.html', 'w', encoding='utf-8').write('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + html + '</body></html>')
print('Listo: index.html y scripts actualizados en', R)
