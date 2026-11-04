# Construye Corale en la raíz del repositorio a partir de la carpeta fuente/.
# Uso: python3 fuente/build.py
import base64, os, re, json
F = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(F)
esp = open(F + '/espeak-ng.module.js', encoding='utf-8').read()
esp = esp.replace('import.meta.url', '"https://localhost/espeak-ng.js"')
esp = re.sub(r'export default Module;?\s*$', '', esp.rstrip())
eng = open(F + '/engine.js', encoding='utf-8').read()
open(R + '/cantor-engine.js', 'w', encoding='utf-8').write('/* Corale: motor de canto (eSpeak NG, GPL-3.0) */\nself.CANTOR_ENGINE_SRC = function () {\n' + esp + '\nconst createEspeak = Module;\n' + eng + '\n};\n')
data = open(F + '/datos/espeak-ng-data.wasm', 'rb').read()
open(R + '/cantor-voice-data.js', 'w').write('self.CANTOR_VOICE_DATA="' + base64.b64encode(data).decode() + '";\n')
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
