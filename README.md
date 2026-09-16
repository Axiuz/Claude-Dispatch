# Claude Dispatch

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
- **Muestra todo en vivo.** Cada delegación es un *run*: su prompt, el
  razonamiento del modelo (si lo emite) y la respuesta aparecen token a token.
- **Sigue el plan.** Claude Code registra el plan que aprobaste y el panel lo
  pinta como un kanban (pendiente, en curso, hecho, error) que avanza solo.
- **Abre Claude Code por proyecto.** Eliges una carpeta y se abre una terminal
  con `claude` corriendo ahí, que ya sabe qué agentes tiene y cómo llamarlos.
- **Edita los agentes.** Nombre, cuándo usarlo, system prompt, temperatura y
  límite de tokens, desde el panel.

**Un solo modelo cargado sirve a todos los agentes.** Cada agente es un system
prompt distinto, no un modelo distinto: cinco agentes no ocupan más RAM que uno.

---

## Requisitos

- macOS 13 o superior (la app es universal: Apple Silicon e Intel)
- Node.js 18 o superior y [pnpm](https://pnpm.io)
- [LM Studio](https://lmstudio.ai) con un modelo descargado (probado con
  OmniCoder-9B Q4_K_M) y su CLI `lms` activada en *Settings > Developer*
- [Claude Code](https://claude.com/claude-code) instalado (`claude` en el PATH)
  para la terminal integrada

---

## Instalación

### Opción A: la app de macOS

```bash
cd orquestador-agentes && pnpm install && cd ..
bash Scripts/build-dmg.sh
```

Genera `dist/Claude-Dispatch-<versión>.dmg`. Arrastra la app a Aplicaciones y
ábrela. Al arrancar:

1. `launcher.sh` levanta el servidor de LM Studio con `--bind 127.0.0.1` y carga
   el modelo en segundo plano.
2. Arranca el orquestador con los datos en
   `~/Library/Application Support/Claude Dispatch` (sobreviven a reinstalar).
3. La ventana nativa carga el panel. Al cerrar la app se detiene el orquestador;
   LM Studio sigue corriendo.

Logs en `~/Library/Logs/Claude Dispatch/`.

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

1. Abre un proyecto desde el panel (**+ carpeta**). Se abre la pestaña
   **Sesión** con Claude Code corriendo en esa carpeta.
2. Pídele algo. Para tareas de más de un paso entra en plan mode, lee lo
   necesario y te presenta un plan indicando qué paso hace él y cuál delega.
3. Apruébalo. Claude Code lo registra con `POST /api/plan` y aparece en
   **Tablero**.
4. Ejecuta: marca sus pasos con `POST /api/plan/step/{id}` y delega los demás
   con `POST /agent/{id}` o `POST /delegate`. Lo sigues en **En vivo**.
5. Revisa cada respuesta, integra, te reporta y cierra el plan.

Si abres Claude Code **fuera** del panel, copia las instrucciones de la pestaña
**Conexión** al `CLAUDE.md` de tu proyecto (o usa el `CLAUDE.md` de la raíz de
este repo como plantilla).

### Las pestañas

| Pestaña | Para qué |
|---|---|
| **Tablero** | Plan activo como kanban con barra de progreso, e historial de delegaciones |
| **En vivo** | Un panel por run en curso (hasta el límite de paralelismo), con razonamiento y respuesta en streaming |
| **Sesión** | Terminal con Claude Code; varias sesiones abiertas a la vez, una visible |
| **Mapa** | Grafo de un proyecto: un punto por función, unidos por quién llama a quién. Dice dónde está definida y dónde se usa, y copia ese contexto para pegárselo a Claude Code |
| **Agentes** | Crear, editar, activar o eliminar agentes |
| **Consola** | Probar un agente a mano (⌘↵ para enviar) |
| **Conexión** | Instrucciones para `CLAUDE.md`, URL de LM Studio, modelo y paralelismo |

El carril izquierdo lista los proyectos recientes (con su rama de git) y el
derecho muestra el estado de cada agente, métricas (tareas hoy, tiempo medio,
tasa de error, tokens estimados) y una gráfica de runs de las últimas 24 h.

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

`POST /delegate` lanza varios runs a la vez con `Promise.allSettled`: si uno
falla, los demás siguen.

### Tiempo real (SSE)

El panel se suscribe a `GET /api/stream` y recibe:

```
run:start  run:token  run:update  runs:cleared
plan:new   plan:update  plan:cleared
agents:updated  projects:updated  terminals:updated
```

Un ping cada 20 s mantiene viva la conexión. El frontend parchea solo el
fragmento del DOM que cambia (timeline, paneles en vivo, modal, tarjeta del
agente) para que el streaming no parpadee ni pierda el scroll.

### Terminal integrada

- Cada carpeta tiene como mucho una sesión: un pty (`node-pty`) con tu shell de
  login ejecutando `claude --append-system-prompt "$DISPATCH_INSTRUCTIONS"` y,
  al salir, una shell interactiva.
- Las instrucciones (`buildInstructions()`) se generan a partir de los agentes
  activos y viajan por variable de entorno, sin escapar comillas en el comando.
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
| Runs, plan, sesiones de terminal | solo en memoria: se pierden al reiniciar |

---

## Configuración

`data/config.json`:

| Clave | Por defecto | Qué es |
|---|---|---|
| `lmstudio_url` | `http://127.0.0.1:1234` | URL del servidor de LM Studio |
| `model` | `omnicoder-9b` | Identificador del modelo cargado |
| `app_port` | `3131` | Puerto del orquestador |
| `max_runs_kept` | `300` | Runs que se conservan en memoria |
| `max_parallel` | `4` | Máximo de tareas por llamada a `/delegate`; debe coincidir con *Parallel* de LM Studio |

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
GET    /api/instructions           texto para CLAUDE.md
GET    /api/graph?path=&refresh=   mapa de código de una carpeta (nodos, aristas y estadísticas)

POST   /agent/:id                  {prompt, task_label?, step_id?, temperature?, max_tokens?}
POST   /delegate                   {tasks: [{agent, prompt, task_label?, step_id?}]}

POST   /api/plan                   {title, goal?, project?, steps: [{description, agent|null}]}
GET    /api/plan
POST   /api/plan/step/:stepId      {status, note?}
DELETE /api/plan

GET    /api/agents
POST   /api/agents                 guarda el array completo
POST   /api/agents/new             {id, name?, use_when?, system_prompt?}
DELETE /api/agents/:id

GET    /api/runs
GET    /api/runs/:id
DELETE /api/runs
POST   /api/test                   {agentId, prompt}

GET    /api/config
POST   /api/config

GET    /api/projects
POST   /api/projects               {path}
DELETE /api/projects               {path}

GET    /api/terminals
POST   /api/terminals              {path, cols, rows}
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
curl -s http://localhost:3131/api/plan    # 2/2 en done
```

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
    public/                   panel: index.html, styles.css, app.js, graph.js
    data/                     agents.json, config.json
    test/                     tests del escáner (pnpm test)
    dev/mock-lmstudio.js      simulador de LM Studio
  macos/
    ClaudeDispatch.swift      ventana nativa (WKWebView), portapapeles y selector de carpeta
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
- No se puede cancelar un run en curso ni hay timeout: si LM Studio se cuelga a
  mitad de un stream, el run queda en `running`.
- Runs, plan y métricas viven en memoria; reiniciar los borra.
- El conteo de tokens es una estimación.
- El editor de agentes guarda el array completo: dos pestañas editando a la vez
  se pisan.
