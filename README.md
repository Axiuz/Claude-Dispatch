# Singularity

Panel local para ver y controlar cómo Claude Code delega trabajo a modelos de IA
que corren en tu Mac (LM Studio). Incluye una app nativa de macOS que arranca todo
con un doble clic y abre Claude Code en una terminal integrada.

```
Claude Code ──curl──▶ Orquestador :3131 ──API OpenAI──▶ LM Studio :1234
     ▲                     │
     │                     ├──SSE──▶ Panel (ventana de la app o navegador)
     └──── pty ────────────┘         terminal integrada con `claude`
```

Claude Code sigue siendo el único que lee archivos y toca tu código. Los agentes
locales reciben texto y devuelven texto: Claude Code les pega el contexto que
necesitan y revisa lo que devuelven antes de usarlo.

---

## Qué hace

- **Rutea delegaciones.** Claude Code llama a `POST /agent/{id}` y el orquestador
  manda la petición a LM Studio con el system prompt de ese agente.
- **Muestra todo en vivo.** Cada delegación es un *run*: su tarjeta de agente
  marca el estado y, al abrirla, el prompt, el razonamiento del modelo (si lo
  emite) y la respuesta aparecen token a token.
- **Sigue el plan.** Claude Code registra el plan que aprobaste y el panel lo
  pinta como un kanban de cinco columnas que avanza solo. También puedes
  arrastrar las tarjetas y escribir las tuyas.
- **Abre una terminal por proyecto.** Eliges una carpeta y se abre tu shell de
  siempre ahí. Escribe `claude` y trabaja como de costumbre; las instrucciones
  para que sepa qué agentes tiene salen de la pestaña Conexión. La terminal se ve
  desde cualquier pestaña, en el carril derecho.
- **Cuenta lo que gasta Claude Code.** El carril derecho lee sus transcripts y
  desglosa los tokens del día, con la caché aparte.
- **Edita el código sin salir.** La pestaña Editor trae Monaco, el editor de VS
  Code, con el árbol del proyecto y guardado con ⌘S.
- **Edita los agentes.** Nombre, cuándo usarlo, system prompt, temperatura y
  límite de tokens, desde el panel.

**Un solo modelo cargado sirve a todos los agentes.** Cada agente es un system
prompt distinto, no un modelo distinto: cinco agentes no ocupan más RAM que uno.

---

## Requisitos

- macOS 13 o superior (la app es universal: Apple Silicon e Intel)
- Node.js 18 o superior y [pnpm](https://pnpm.io)
- [LM Studio](https://lmstudio.ai) con uno o dos modelos descargados (probado
  con Qwen3 4B y Gemma 3 4B, uno por par de agentes) y su CLI `lms` activada en
  *Settings > Developer*
- [Claude Code](https://claude.com/claude-code) instalado (`claude` en el PATH)
  para la terminal integrada

---

## Instalación

### Opción A: la app de macOS

```bash
cd orquestador-agentes && pnpm install && cd ..
bash Scripts/build-dmg.sh
```

Genera `dist/Singularity-<versión>.dmg`. Arrastra la app a Aplicaciones y
ábrela. Al arrancar:

1. `launcher.sh` levanta el servidor de LM Studio con `--bind 127.0.0.1` y carga
   el modelo en segundo plano.
2. Arranca el orquestador con los datos en
   `~/Library/Application Support/Singularity` (sobreviven a reinstalar).
3. La ventana nativa carga el panel. Al cerrar la app se detiene el orquestador
   y también LM Studio (`lms unload --all` y `lms server stop`): cerrar Singularity
   deja la RAM libre.

Logs en `~/Library/Logs/Singularity/`.

La firma es ad-hoc: la primera vez macOS puede pedir abrirla con clic derecho >
Abrir.

### Opción B: desarrollo

```bash
cd orquestador-agentes
pnpm install
pnpm mock      # LM Studio simulado en :1234 (no hace falta cargar el modelo)
pnpm start     # orquestador en http://localhost:3131
```

Si LM Studio real ya ocupa el 1234, usa `MOCK_PORT=1235 pnpm mock` y cambia la
URL en la pestaña Conexión.

El mock entiende dos palabras clave dentro del prompt:

| Palabra | Efecto |
|---|---|
| `FORZAR_ERROR` | responde 500, para probar el manejo de errores |
| `FORZAR_RAZONAMIENTO` | manda `reasoning_content` antes de la respuesta |

---

## Cómo se usa

1. Abre un proyecto desde el panel (**+ carpeta**). Se abre una terminal en esa
   carpeta, en el carril derecho y en la pestaña **Sesión**; arranca `claude` ahí.
2. Pídele algo. Para tareas de más de un paso entra en plan mode, lee lo
   necesario y te presenta un plan indicando qué paso hace él y cuál delega.
3. Apruébalo. Claude Code lo registra con `POST /api/plan` y aparece en
   **Tablero**.
4. Ejecuta: marca sus pasos con `POST /api/plan/step/{id}` y delega los demás
   con `POST /agent/{id}` o `POST /delegate`. Lo sigues en **Tablero**.
5. Revisa cada respuesta, integra, te reporta y cierra el plan.

Si abres Claude Code **fuera** del panel, copia las instrucciones de la pestaña
**Conexión** al `CLAUDE.md` de tu proyecto (o usa el `CLAUDE.md` de la raíz de
este repo como plantilla).

### Las pestañas

| Pestaña | Para qué |
|---|---|
| **Tablero** | Plan activo como kanban con barra de progreso, e historial de delegaciones |
| **Sesión** | Una terminal por carpeta, con tu shell de siempre; varias abiertas a la vez, una visible |
| **Editor** | Monaco con el árbol del proyecto: abre, edita y guarda con ⌘S, solo dentro de tus carpetas de Proyectos |
| **Mapa** | Grafo de un proyecto: un punto por función, unidos por quién llama a quién. Dice dónde está definida y dónde se usa, y copia ese contexto para pegárselo a Claude Code |
| **Agentes** | Crear, editar, activar o eliminar agentes |
| **Consola** | Probar un agente a mano (⌘↵ para enviar) |
| **Conexión** | Instrucciones para `CLAUDE.md`, URL de LM Studio, modelo y paralelismo |

El carril izquierdo lista los proyectos recientes (con su rama de git) y el
derecho muestra la terminal, el estado de cada agente, los tokens que gasta
Claude Code y el control de código de la carpeta abierta.

**La tarjeta de control de código** es lo que enseña VS Code en su barra lateral,
recortado a lo que cabe en el carril: la rama, cuántos commits te faltan por
subir o por traer, los archivos que tienes tocados (un clic los abre en el
Editor) y los últimos commits, con los que aún no están en el remoto marcados
como "sin subir".

Y desde ahí mismo se trabaja: el nombre de la rama abre el selector —las locales
con su ahead/behind, las remotas que todavía no tienes y "crear rama nueva"—, el
`+` de cada archivo lo prepara, y la caja de mensaje lleva el botón dividido de
siempre: **Commit**, **Commit (Amend)**, **Commit & Push** y **Commit & Sync**.
Sin nada preparado, el commit toma todos los cambios rastreados, y te lo pregunta
antes. Lo que git conteste, bien o mal, se enseña tal cual. Los diffs y los
conflictos siguen siendo cosa de la terminal.

**Los tokens de Claude Code son su gasto real**, no una estimación: salen
de los transcripts que el propio Claude Code escribe en `~/.claude/projects`, de
donde se lee el `usage` que devolvió la API. Debajo, la tarjeta de desglose
reparte el día en entrada, salida y caché, y dice cuántas sesiones han escrito
hoy y cuántas siguen activas. Se actualiza en cuanto Claude Code responde, sin
recargar nada. Los tokens de los agentes locales no salen aquí: se ven en cada
run, y esos sí son una estimación por longitud.

### Agentes incluidos

| Id | Para qué |
|---|---|
| `coder` | Código puntual y acotado: funciones, parsers, boilerplate |
| `reviewer` | Revisar un diff buscando bugs y malas prácticas |
| `tester` | Tests unitarios con casos borde y de error |
| `documenter` | Docstrings y documentación a partir del código |
| `explainer` | Explicar código ajeno |

El campo **"Cuándo usarlo"** (`use_when`) es lo que Claude Code lee para elegir
agente: cambiarlo cambia el ruteo.

---

## Cómo funciona por dentro

Todo el backend está en `orquestador-agentes/server.js` (Express) y todo el
frontend en `public/app.js` (JavaScript sin frameworks ni build step).

### Ciclo de un run

1. **`createRun()`** crea el run en memoria y emite `run:start`. Si trae
   `step_id`, marca ese paso del plan como `running`.
2. **`runAgent()`** llama a `/v1/chat/completions` de LM Studio con
   `stream: true`. Lee el stream línea a línea, acumula `delta.content` en la
   respuesta y `delta.reasoning_content` en el razonamiento, y emite `run:token`
   como mucho cada 120 ms para no saturar la conexión.
3. **`updateRun()`** guarda el resultado (duración, tokens estimados como
   `longitud / 4`), emite `run:update` y marca el paso como `done` o `error`.

`POST /delegate` acepta un lote de hasta 12 tareas. No las lanza todas juntas:
cada run pide turno en la cola **de su modelo** y solo corren `max_parallel` a la
vez por modelo, en estado `queued` mientras esperan. Mandarle varias peticiones
juntas al mismo modelo no las acelera: multiplica el KV cache y en 16 GB acaba
tirando de swap.

De ahí sale el paralelismo real. Con dos modelos pequeños cargados a la vez y un
par de agentes en cada uno —Qwen3 4B para `coder` y `tester`, Gemma 3 4B para
`documenter` y `explainer`— un lote de tests y documentación corre de verdad en
paralelo, mientras que dos tareas del mismo modelo esperan turno. Sale mejor que
un solo modelo grande que ocupe toda la RAM y se quede sin contexto.

`freeSlot()` le pasa el turno al primero que espera por ese mismo modelo: el
turno de Qwen no sirve para arrancar un run de Gemma. Los carriles se crean solos
al primer run de cada modelo y desaparecen al quedarse vacíos.

Cada run lleva un `AbortController` con dos relojes: uno de inactividad
(`stall_timeout_ms`, se rearma con cada token) y un tope total
(`run_timeout_ms`). Si salta alguno, el run queda en `error` con el motivo y
libera su turno, en vez de quedarse colgado. `DELETE /api/runs/:id` hace lo mismo
a mano y lo deja en `cancelled`.

Los prompts de más de `max_prompt_chars` se rechazan con 413: no cabrían en el
contexto y LM Studio los truncaría por dentro sin avisar.

### Tiempo real (SSE)

El panel se suscribe a `GET /api/stream` y recibe:

```
run:start  run:token  run:update  queue:updated  runs:cleared
plan:new   plan:update  plan:cleared
agents:updated  projects:updated  terminals:updated  claude:usage
```

Un ping cada 20 s mantiene viva la conexión. El frontend parchea solo el
fragmento del DOM que cambia (timeline, modal, tarjeta del agente) para que el
streaming no parpadee ni pierda el scroll.

### Terminal integrada

- Cada carpeta tiene como mucho una sesión: un pty (`node-pty`) con tu shell de
  login (`-l -i`) abierta en esa carpeta. Es una terminal normal: no lanza nada
  por su cuenta, y si quieres Claude Code ahí dentro lo escribes tú.
- Las instrucciones para Claude Code (`buildInstructions()`) siguen estando en la
  pestaña **Conexión**, para copiarlas al `CLAUDE.md` del proyecto.
- La salida se agrupa en ráfagas de 16 ms y se manda por SSE. Se guardan los
  últimos 256 KB para reproducirlos al reconectar. El teclado llega por POST,
  una petición a la vez para conservar el orden.
- xterm.js se sirve desde `node_modules` en `/vendor/xterm`.
- Al recibir SIGTERM o SIGINT el servidor mata todas las sesiones.

### Proyectos recientes

Hasta 30 carpetas, guardadas en `data/projects.json`. Se añaden al abrirlas
desde el panel o cuando un plan trae `project`. La rama se lee directamente de
`.git/HEAD` (también en worktrees), sin lanzar procesos de git. Si la carpeta ya
no existe se marca como "Suprimido".

### Qué se guarda y qué no

| Dato | Dónde |
|---|---|
| Agentes | `data/agents.json` |
| Configuración | `data/config.json` |
| Proyectos recientes | `data/projects.json` (ignorado por git) |
| Plan de commits | `data/commitplans.json` (ignorado por git) |
| Notas y to-dos | `data/notes.json` (ignorado por git) |
| Runs, plan, sesiones de terminal | solo en memoria: se pierden al reiniciar |

---

## Configuración

`data/config.json`:

| Clave | Por defecto | Qué es |
|---|---|---|
| `lmstudio_url` | `http://127.0.0.1:1234` | URL del servidor de LM Studio |
| `model` | `qwen/qwen3-4b-2507` | Modelo por defecto: el que usa un agente que no fije el suyo |
| `app_port` | `3131` | Puerto del orquestador |
| `max_runs_kept` | `300` | Runs que se conservan en memoria |
| `max_parallel` | `1` | Runs que corren a la vez **por cada modelo**; el resto espera en cola. Conviene igualarlo a *Max Concurrency* de LM Studio |
| `stall_timeout_ms` | `90000` | Corta el run si el modelo no envía nada en ese tiempo |
| `run_timeout_ms` | `600000` | Tope duro de duración de un run |
| `max_prompt_chars` | `16000` | Prompts más largos se rechazan con 413 (~4000 tokens) |

Variables de entorno:

| Variable | Qué hace |
|---|---|
| `ORQ_DATA_DIR` | Carpeta de datos alternativa; se siembra con los valores por defecto |
| `ORQ_APP_ONLY` | Sirve el panel solo a la app nativa; la API sigue abierta para Claude Code |
| `MOCK_PORT` | Puerto del mock de LM Studio |

---

## API

```
GET    /api/stream                 SSE del panel
GET    /api/manifest               agentes activos y cómo llamarlos
GET    /api/status                 ¿responde LM Studio? + modelos cargados
GET    /api/claude-usage           tokens gastados por Claude Code (?refresh=1 relee)
GET    /api/instructions           texto para CLAUDE.md
GET    /api/graph?path=&refresh=   mapa de código de una carpeta (nodos, aristas y estadísticas)

POST   /agent/:id                  {prompt, task_label?, step_id?, temperature?, max_tokens?}
POST   /delegate                   {tasks: [{agent, prompt, task_label?, step_id?}]}

POST   /api/plan                   {title, goal?, project?, steps: [{description, agent|null}]}
GET    /api/plan
POST   /api/plan/step/:stepId      {status?, column?, note?}
POST   /api/plan/step/:id/move     {column, index} — arrastrar una tarjeta
DELETE /api/plan/step/:stepId      quitar una tarjeta del tablero
POST   /api/plan/tasks             {description, column?, agent?} — tarjeta a mano
DELETE /api/plan

GET    /api/agents
POST   /api/agents                 guarda el array completo
POST   /api/agents/new             {id, name?, use_when?, system_prompt?}
DELETE /api/agents/:id

GET    /api/runs
GET    /api/runs/:id
DELETE /api/runs/:id               cancela un run en curso o en cola
DELETE /api/runs
POST   /api/test                   {agentId, prompt}

GET    /api/config
POST   /api/config

GET    /api/projects
POST   /api/projects               {path}
DELETE /api/projects               {path}

GET    /api/files/tree?path=       un nivel del árbol de un proyecto
GET    /api/files/read?path=       {content, size, mtimeMs}
POST   /api/files/write            {path, content}
POST   /api/files/stat             {paths: []} — fechas de los archivos abiertos

GET    /api/git?path=&refresh=     rama, archivos cambiados y últimos commits
GET    /api/git/branches?path=     ramas locales y remotas, con ahead/behind
POST   /api/git/checkout           {path, branch, create?, track?}
POST   /api/git/stage              {path, files?, all?}
POST   /api/git/unstage            {path, files?, all?}
POST   /api/git/commit             {path, message, amend?, all?, then?: push|sync}
POST   /api/git/remote             {path, action: push|pull|sync}
GET    /api/git/plan?path=         plan de commits del repositorio
POST   /api/git/plan               {path, text} o {path, commits: []}
DELETE /api/git/plan               {path, index?} — un commit o el plan entero

GET    /api/notes?path=            notas y to-dos de una carpeta
POST   /api/notes                  {path, text} — añade una nota
POST   /api/notes/item             {path, id, text?, done?} — edita o marca
DELETE /api/notes                  {path, id} una nota | {path, done: true} las hechas

GET    /api/terminals
POST   /api/terminals              {path, kind, cols, rows} — kind: claude | shell
GET    /api/terminals/:id/stream   SSE: buffer, data, exit
POST   /api/terminals/:id/input    {data}
POST   /api/terminals/:id/resize   {cols, rows}
DELETE /api/terminals/:id
```

Respuesta de `/agent/:id`: `{"content": "...", "durationMs": 1234, "runId": "..."}`.

Prueba de humo con el mock:

```bash
curl -s http://localhost:3131/api/status
curl -s -X POST http://localhost:3131/api/plan -H "Content-Type: application/json" \
  -d '{"title":"prueba","steps":[{"description":"manual","agent":null},{"description":"delegado","agent":"coder"}]}'
curl -s -X POST http://localhost:3131/api/plan/step/step-1 -H "Content-Type: application/json" -d '{"status":"done"}'
curl -s -X POST http://localhost:3131/agent/coder -H "Content-Type: application/json" \
  -d '{"prompt":"hola","task_label":"prueba","step_id":"step-2"}'
curl -s http://localhost:3131/api/plan    # step-1 en done, step-2 en review
```

---

## Editor, tablero y terminal

### El tablero

Cinco columnas: **TODO**, **EN PROGRESO**, **REVISIÓN**, **HECHO** y **APROBADO**.
Las tarjetas se arrastran de una a otra y el orden se guarda.

Los pasos que registra Claude Code entran en TODO y se mueven solos: a EN PROGRESO
cuando arranca el agente y a **REVISIÓN** cuando termina. No van directos a HECHO a
propósito. El modelo local es de 9B y se equivoca más que tú: REVISIÓN es la
columna donde compruebas lo que escribió antes de darlo por bueno. HECHO y APROBADO
los pones tú, arrastrando.

Un run cancelado vuelve a TODO. Uno que falla se queda en REVISIÓN con el borde
rojo y el motivo en la tarjeta.

También puedes escribir tarjetas tuyas con **+ Agregar la tarea**, con o sin plan
registrado. Por eso el tablero ahora se guarda en `data/plan.json` y sobrevive a
reiniciar el servidor; los runs siguen viviendo solo en memoria.

### El editor

La pestaña **Editor** trae Monaco, el mismo editor que usa VS Code: árbol de
archivos a la izquierda, pestañas de archivos abiertos, resaltado de sintaxis,
buscar y reemplazar, y minimapa. Se guarda con **⌘S**.

Solo ve y escribe dentro de las carpetas que ya tienes en **Proyectos**. Fuera
quedan `node_modules`, `.git`, los archivos de más de 2 MB y los binarios. Si
Claude Code cambia un archivo que tienes abierto y tú no lo has tocado, se recarga
solo sin moverte el cursor; si lo tenías a medio editar, te avisa y no lo pisa.

### Las terminales

Son dos, y son distintas. La **sesión de Claude Code** ocupa la pestaña **Sesión**
a tamaño completo: se arranca sola al abrir un proyecto, con las instrucciones del
orquestador ya puestas. La **shell del dock** vive en el carril derecho y se ve
desde cualquier pestaña, para comandos sueltos; se pliega y se estira, y se crea
cuando la pides.

El dock sigue siempre a la carpeta de la sesión activa. Cada carpeta puede tener
una de cada tipo, las dos siguen vivas en el servidor aunque cambies de proyecto,
y al volver se reproduce el scrollback.

### Notas y to-dos

El dock tiene dos pestañas, **TERMINAL** y **NOTAS**, y se cambian como las de
Chrome: las dos comparten la misma caja y el mismo alto, y la shell sigue viva
mientras miras las notas. Al lado del nombre de la pestaña va el número de
pendientes.

Se escriben en el campo de arriba y se añaden con Enter. Cada nota se marca como
hecha con su casilla, se edita haciendo clic en su texto —Enter guarda, Escape
cancela— y se borra con la ✕. Abajo, el contador de pendientes y un botón para
limpiar las hechas de una vez.

Las notas se guardan en `data/notes.json` del orquestador, **no dentro de tu
repositorio**: son tuyas, no del proyecto, y así no acaban en un commit ni te
obligan a mantener una línea en su `.gitignore`. Sobreviven al reinicio del
servidor.

Están indexadas por carpeta y siguen a la misma que la tarjeta de Control de
código: cambiar de proyecto cambia la lista. El tope es de 200 notas por
proyecto y 4000 caracteres por nota.

---

## Control de código

La tarjeta **Control de código** vive en el carril derecho, debajo de la terminal
del dock: la barra lateral de Git de VS Code reducida a un carril. Muestra la rama
actual, la caja del mensaje con el botón dividido de commit, los archivos
preparados y sin preparar, los últimos commits y el plan de commits.

Sigue siempre a la carpeta que tiene delante el dock y se repregunta cada 5
segundos, solo mientras la pestaña está visible: Git cambia por fuera del panel
—Claude Code, la terminal, otro editor— y no hay ningún evento que avise.

Desde ahí se cambia de rama, se crea una, se saca una remota, se preparan y se
quitan archivos del stage, se commitea (normal, `--amend`, con push o con sync) y
se hace pull o push suelto. Un clic en un archivo de la lista lo abre en el
Editor. Lo que no está —diffs, conflictos, rebase, tags y stash— se sigue haciendo
en la terminal.

### Plan de commits

Al cerrar una tarea, Claude Code le pide al agente **documenter** que agrupe en
commits los archivos que tocó y manda el resultado al panel con
`POST /api/git/plan`. Aparece dentro de la tarjeta como una lista, un renglón por
commit, con su título y sus archivos. Cada renglón trae tres botones:

- **＋** prepara sus archivos y escribe su mensaje en la caja.
- **✓** prepara y commitea; el commit ejecutado desaparece de la lista.
- **✕** lo quita del plan.

El plan también se pega a mano: el botón **pegar** abre un área de texto donde van
los bloques tal cual los devolvió el documenter.

```
COMMIT 1
ARCHIVOS: src/auth/login.js, src/auth/perfil.js
MENSAJE: corrige el flujo de autenticación
FIN
```

El parseo es tolerante a propósito —acepta numeración, viñetas, comas, bloques de
código y que falte el `FIN`— porque el documenter corre en un modelo de 4B y
repegar el plan por una viñeta de más no tiene sentido. Lo que no se negocia son
las rutas: van a `git add`, así que se filtran igual que las del resto del panel.

Se guarda uno por repositorio en `data/commitplans.json`, ignorado por git porque
lleva rutas reales y trabajo sin commitear. Singularity nunca commitea solo:
cada commit es un clic tuyo.

---

## Seguridad

El panel puede abrir una terminal en tu Mac, así que solo acepta peticiones
locales:

- El servidor escucha únicamente en `127.0.0.1`.
- Rechaza cualquier `Host` que no sea `localhost:<puerto>` o `127.0.0.1:<puerto>`
  (evita DNS rebinding) y cualquier `Origin` ajeno (evita que una web abierta en
  el navegador llame a la API). No usa `cors()`: Claude Code llama con curl.
- LM Studio se arranca con `--bind 127.0.0.1` para que no quede expuesto a la
  red aunque su última configuración lo estuviera.

---

## Estructura

```
orquestador-agentes/          raíz del repo
  CLAUDE.md                   plantilla del flujo para tus otros proyectos
  orquestador-agentes/
    server.js                 backend completo
    codegraph.js              escáner estático para el mapa de código
    kanban.js                 columnas del tablero y colocación de tarjetas
    git.js                    estado y operaciones de Git de una carpeta
    commitplan.js             parser del plan de commits del documenter
    notes.js                  notas y to-dos de cada proyecto: normalizador y topes
    claudeusage.js            tokens que gasta Claude Code, leídos de sus transcripts
    safepath.js               contención de rutas del editor
    public/                   panel: index.html, styles.css, app.js, graph.js, editor.js
    data/                     agents.json, config.json (y plan.json, projects.json,
                              commitplans.json, notes.json, ignorados por git)
    test/                     tests del escáner, el tablero, las rutas, Git y el
                              plan de commits (pnpm test)
    dev/mock-lmstudio.js      simulador de LM Studio
  macos/
    Singularity.swift         ventana nativa (WKWebView), portapapeles y selector de carpeta
    launcher.sh               arranca/detiene LM Studio y el orquestador
    make-icon.swift, logo.jpg icono de la app
  Scripts/build-dmg.sh        compila la app y genera el .dmg
```

---

## Limitaciones conocidas

- El mapa de código es un análisis por expresiones regulares, no un compilador:
  cuando un nombre existe en varios archivos y no hay import que lo desempate, la
  arista se marca como dudosa y se dibuja punteada.
- Un solo plan a la vez: registrar otro pisa el anterior.
- La cola es por modelo y sin prioridades dentro de cada una: con un solo modelo
  cargado hay un solo carril, y un lote largo retrasa a la delegación que llegue
  después.
- Los runs y las métricas viven en memoria; reiniciar los borra. El tablero no:
  se guarda en `data/plan.json`.
- El editor abre, edita y guarda, pero no crea ni borra archivos, y no muestra
  el estado de Git.
- Las notas son texto plano y sin orden propio: no hay carpetas, etiquetas,
  fechas de vencimiento ni arrastrar para reordenar. La nueva va arriba.
- La tarjeta de Git cambia de rama, prepara archivos y commitea, pero no enseña
  diffs ni resuelve conflictos: un merge con conflictos, un rebase, un stash o un
  push forzado se siguen haciendo en la terminal.
- El conteo de tokens de los agentes locales es una estimación. El de Claude Code
  es real, pero sale de sus archivos: solo se leen los últimos 7 días y, si los
  borras, el histórico se va con ellos.
- El editor de agentes guarda el array completo: dos pestañas editando a la vez
  se pisan.
