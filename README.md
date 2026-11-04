# Corale

**Ensayo coral accesible con voz sintética.** Corale convierte una partitura coral en voces cantadas con su letra, para que cada estudiante escuche y practique su parte. Fue creada pensando en estudiantes con discapacidad visual o baja visión de la Universidad Nacional de Música (Lima, Perú), y sirve a cualquier corista que quiera estudiar su voz fuera del ensayo.

**Usar en línea:** @@PAGES_URL@@

## Qué hace

- **Lee partituras** en MusicXML (`.musicxml`, `.xml`, `.mxl`), exportadas desde MuseScore, Finale, Sibelius o Dorico, y en **braille musical** (`.brf`), para una voz o para coro, con acompañamiento de piano.
- **Canta cada voz con su letra** (soprano, contralto, tenor, bajo…), con afinación y ritmo exactos. Respeta repeticiones, casillas de 1.ª y 2.ª vez y estrofas.
- **Mezclador:** volumen, panorama, silencio y solo por voz, y modos de práctica: todas iguales, mi voz destacada, solo mi voz, o todas menos la mía para cantarla encima.
- **Práctica:** metrónomo, compás de entrada, velocidad de 40 % a 150 %, transporte de ±12 semitonos, ir a un compás y repetir una sección.
- **Pantalla:** letra en tamaño grande con la sílaba que suena resaltada, partitura con la nota actual marcada, fondo claro u oscuro y alto contraste.
- **Exporta** audio WAV y MP3, MIDI con la letra y MusicXML (útil para pasar a MuseScore una partitura leída desde braille).
- **Idiomas de la letra:** español, latín, italiano, inglés, alemán, francés, portugués, catalán, euskera y quechua.

## Accesibilidad

Todo funciona con teclado y con lector de pantalla (JAWS, NVDA). La lista completa de atajos está en **Ayuda › Atajos de teclado**.

| Atajo | Acción |
|---|---|
| Ctrl+Mayús+F o F10 | Ir a la barra de menús |
| Ctrl+Mayús+Espacio | Reproducir o pausar |
| Ctrl+Mayús+1 a 9 / Ctrl+Mayús+0 | Solo de cada voz / quitar los solos |
| Ctrl+Mayús+L | Repetir sección |
| Ctrl+Mayús+X | Ir al mezclador |
| Alt+Mayús+O | Abrir partitura |
| Alt+Mayús+R | Ir a la barra de reproducción |

Dentro de la barra de reproducción funcionan teclas sueltas: **P** pausa y continúa desde donde quedó, **S** detiene, **flechas izquierda y derecha** cambian de compás, **A** dice la posición, **M** activa el metrónomo y **L** repite la sección.

## Uso sin conexión

Descargue el repositorio (botón **Code › Download ZIP**), descomprímalo y abra `index.html` en Chrome, Edge o Firefox. No necesita instalación, servidor ni internet. Las partituras se procesan en la propia computadora: no se envían a ningún servidor.

La carpeta `ejemplos/` trae *Campanero* en MusicXML, en versión de canon a 4 voces y en braille (BRF).

## Braille musical (BRF)

La importación de braille es experimental. Admite:

- el formato vocal habitual: número de compás, letra en braille sin abreviar y línea de música;
- el formato coral línea por línea, con prefijos de parte (`>S'`, `>A'`/`>CO'`, `>T'`, `>B'`, `>CB'`, `>SA'`) y letras por parte (`,S'`, `,T',B'`);
- el acompañamiento de piano en formato compás sobre compás.

En pruebas con 11 obras reales, las voces coincidieron entre 91 % y 100 % de las notas con su versión MusicXML (salvo una obra cuyo braille tenía errores de octava). No lee braille abreviado (estenografía) en la letra y omite los adornos.

## Limitaciones

- La voz gratuita (eSpeak NG) tiene afinación y ritmo exactos, pero su timbre suena robótico.
- No interpreta D.C., D.S. ni Coda.
- Corale no es un editor: para crear o corregir partituras use MuseScore o un editor de braille musical.

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| `index.html` | La aplicación (interfaz y lectura de partituras) |
| `cantor-engine.js` | Motor de canto: eSpeak NG compilado a WebAssembly y síntesis de las notas |
| `cantor-voice-data.js` | Datos de idiomas de eSpeak NG |
| `verovio-toolkit-wasm.js` | Verovio, para dibujar la partitura |
| `lame.min.js` | lamejs, para exportar MP3 |
| `cantor-examples.js` | Ejemplos incluidos en el menú Archivo |
| `ejemplos/` | Partituras de prueba |
| `fuente/` | Código fuente y `build.py` para reconstruir la aplicación |

Para reconstruir después de modificar `fuente/`: `python3 fuente/build.py`.

## Licencia y créditos

Corale se distribuye bajo la licencia **GNU GPL versión 3** (ver `LICENSE`), la misma de su motor de voz.

Usa estos componentes de código abierto:

- [eSpeak NG](https://github.com/espeak-ng/espeak-ng), síntesis de voz, GPL-3.0, compilado a WebAssembly por el proyecto [Echogarden](https://github.com/echogarden-project/espeak-ng-emscripten).
- [Verovio](https://github.com/rism-digital/verovio), dibujo de partituras, LGPL-3.0.
- [lamejs](https://github.com/zhuker/lamejs), codificación MP3, LGPL-3.0.
- Tipografía [Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/), del Braille Institute (SIL Open Font License).
