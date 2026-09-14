# Orquestador de Agentes

Panel para ver y controlar cómo Claude Code delega trabajo a tus agentes de IA locales (LM Studio).

## Arrancar

```bash
npm install
npm start
```

Abre **http://localhost:3131**. Requiere LM Studio corriendo con un modelo cargado.

Luego copia el `CLAUDE.md` que viene junto a este proyecto al directorio raíz de tu proyecto de código. Ese archivo es lo que le enseña a Claude Code el flujo completo.

## El flujo

```
Tú le pides algo a Claude Code
        ↓
Claude Code entra en plan mode: lee tus archivos, arma el plan
        ↓
Te presenta el plan  ──────────▶  tú apruebas o corriges
        ↓
Registra el plan en este panel  →  lo ves con sus pasos
        ↓
Ejecuta: unos pasos los hace él, otros los delega a agentes locales
        ↓  (cada delegación aparece aquí en vivo)
Revisa lo que devolvió cada agente, integra, y te reporta
```

Claude Code es el único que toca tu código. Los agentes locales solo reciben texto y devuelven texto — Claude Code les pasa el contexto que necesiten.

## Plan mode ya es nativo

El ciclo plan → aprobación → ejecución no lo inventa este proyecto: Claude Code lo trae de fábrica. Actívalo con **Shift+Tab dos veces** o el comando **`/plan`**. En ese modo solo tiene herramientas de lectura, así que no puede modificar nada hasta que apruebes.

Lo que agrega este panel es visibilidad: ver el plan y su avance, y ver qué le pide a cada agente y qué devuelven.

## Las 4 pestañas

- **Tablero** — el plan activo con su progreso, las tarjetas de agentes (libre/trabajando), y el timeline de delegaciones con las respuestas apareciendo token por token.
- **Agentes** — crea y edita agentes. El campo **"Cuándo usarlo"** es lo que Claude Code lee para elegir a quién delegar.
- **Consola** — prueba un agente a mano.
- **Conexión** — genera las instrucciones actualizadas para tu `CLAUDE.md`.

## API

```bash
GET  /api/manifest              # agentes disponibles y cuándo usarlos
GET  /api/status                # ¿está arriba LM Studio?

POST /api/plan                  # registrar plan aprobado
POST /api/plan/step/{stepId}    # marcar un paso que hizo Claude Code
DELETE /api/plan                # cerrar el plan

POST /agent/{id}                # invocar un agente
POST /delegate                  # varios agentes en paralelo (máx 4)
```

Al invocar un agente, incluir `"step_id"` hace que el paso del plan se marque solo cuando termine.

## Agentes incluidos

| Agente | Para qué |
|---|---|
| ⚒️ Coder | Código puntual: funciones, utilidades, boilerplate |
| 🔍 Reviewer | Revisar diffs buscando bugs y malas prácticas |
| 🧪 Tester | Tests unitarios con casos borde |
| 📝 Documenter | Docstrings, READMEs, documentación |
| 💡 Explainer | Explicar código ajeno |

## Notas

- Un solo modelo cargado en LM Studio sirve a todos los agentes; cada agente es un system prompt distinto. Cinco agentes no consumen más RAM que uno.
- El límite de 4 en paralelo viene de LM Studio (lo ves como "Parallel N" en su pestaña Developer).
- Los agentes se guardan en `data/agents.json`; puedes editarlo a mano y versionarlo.
- El plan y el historial viven en memoria: se reinician al parar el proceso.
