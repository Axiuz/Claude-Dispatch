// ============================================================================
// graph.js — pestaña "Mapa": constelación de archivos y funciones.
//
// El servidor (/api/graph) devuelve nodos y aristas; aquí se colocan con una
// simulación de fuerzas propia y se dibujan en un canvas. Al pulsar un nodo, el
// inspector de la derecha dice dónde está definido, a qué llama y quién lo usa.
//
// Reutiliza los ayudantes globales de app.js: $, api, escapeHtml, tildePath,
// cssVar, flash, formatCount.
// ============================================================================

const CodeMap = (() => {
  const PALETTE = ["--graph-1", "--graph-2", "--graph-3", "--graph-4", "--graph-5",
                   "--graph-6", "--graph-7", "--graph-8", "--graph-9", "--graph-10"];

  // Parámetros de la simulación. Tocados a ojo hasta que el dibujo respira.
  const SIM = {
    ticks: 420,        // iteraciones antes de quedarse quieto
    cell: 78,          // tamaño de celda de la rejilla de repulsión
    repulsion: 520,
    spring: 0.022,
    gravity: 0.006,
    cluster: 0.02,     // atracción hacia el centro de su carpeta
    damping: 0.82,
  };

  let graph = null;        // respuesta cruda del servidor
  let nodes = [];          // nodos de la vista actual (con x, y, vx, vy)
  let edges = [];          // aristas de la vista actual (con a, b resueltos)
  let byId = new Map();
  let adjacency = new Map();

  let mode = "fn";
  let currentPath = null;
  let selectedId = null;
  let hoveredId = null;
  let matches = new Set();

  let camera = { x: 0, y: 0, k: 1 };
  let alpha = 0;
  let frame = null;
  let drag = null;

  let canvas, ctx, stage;
  const dirColors = new Map();
  let loading = false;

  // ============ Colores ============
  function colorFor(node) {
    const key = node.dir || "/";
    if (!dirColors.has(key)) {
      let hash = 0;
      for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      dirColors.set(key, cssVar(PALETTE[hash % PALETTE.length]));
    }
    return dirColors.get(key);
  }

  // ============ Carga ============
  async function load(dirPath, refresh) {
    if (!dirPath || loading) return;
    loading = true;
    currentPath = dirPath;
    overlay(`Leyendo ${tildePath(dirPath)}…`, true);
    try {
      const url = `/api/graph?path=${encodeURIComponent(dirPath)}${refresh ? "&refresh=1" : ""}`;
      graph = await api(url);
      selectedId = null;
      hoveredId = null;
      buildView();
      renderStats();
      renderLegend();
      renderInspector();
      overlay(null);
    } catch (err) {
      graph = null;
      nodes = [];
      edges = [];
      overlay(`No se pudo analizar la carpeta: ${err.message}`);
      renderStats();
    } finally {
      loading = false;
    }
  }

  // Arma la vista (nodos y aristas visibles) según el modo elegido.
  function buildView() {
    if (!graph) return;
    const all = new Map(graph.nodes.map((n) => [n.id, n]));
    let picked;
    let links;

    if (mode === "file") {
      picked = graph.nodes.filter((n) => n.type === "file");
      // Las llamadas entre funciones se resumen en una arista archivo → archivo
      const merged = new Map();
      for (const e of graph.edges) {
        const a = fileOf(e.source, all);
        const b = fileOf(e.target, all);
        if (!a || !b || a === b) continue;
        const key = `${a}|${b}`;
        const acc = merged.get(key) || { source: a, target: b, kind: e.kind, count: 0, sites: [], ambiguous: true };
        acc.count += e.count;
        if (!e.ambiguous) acc.ambiguous = false;
        if (e.kind === "import") acc.kind = "import";
        merged.set(key, acc);
      }
      links = [...merged.values()];
    } else {
      const used = new Set();
      links = graph.edges.filter((e) => e.kind === "call");
      links.forEach((e) => {
        used.add(e.source);
        used.add(e.target);
      });
      picked = graph.nodes.filter(
        (n) => n.type === "fn" || used.has(n.id) || n.defs === 0
      );
    }

    const keep = new Set(picked.map((n) => n.id));
    edges = links
      .filter((e) => keep.has(e.source) && keep.has(e.target))
      .map((e) => ({ ...e }));

    // Conserva la posición de los nodos que ya estaban: al cambiar de modo el
    // dibujo no salta de golpe.
    const previous = byId;
    nodes = picked.map((n) => {
      const old = previous.get(n.id);
      return { ...n, x: old ? old.x : 0, y: old ? old.y : 0, vx: 0, vy: 0, degree: 0, pinned: false };
    });
    byId = new Map(nodes.map((n) => [n.id, n]));

    adjacency = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const e of edges) {
      e.a = byId.get(e.source);
      e.b = byId.get(e.target);
      e.a.degree++;
      e.b.degree++;
      adjacency.get(e.source).add(e.target);
      adjacency.get(e.target).add(e.source);
    }

    seedPositions();
    alpha = 1;
    startLoop();
  }

  const fileOf = (id, all) => {
    const node = all.get(id);
    return node ? `f:${node.file}` : null;
  };

  // Posición inicial: cada carpeta en su propio sector del círculo. La
  // simulación parte de algo ya agrupado y converge mucho antes.
  function seedPositions() {
    const dirs = [...new Set(nodes.map((n) => n.dir))].sort();
    const radius = 220 + nodes.length * 0.9;
    nodes.forEach((n) => {
      if (n.x || n.y) return;
      const idx = dirs.indexOf(n.dir);
      const angle = ((idx + 0.5) / dirs.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
      const r = radius * (0.35 + Math.random() * 0.65);
      n.x = Math.cos(angle) * r;
      n.y = Math.sin(angle) * r;
    });
  }

  // ============ Simulación ============
  function tick() {
    const cell = SIM.cell;
    const grid = new Map();
    for (const n of nodes) {
      const key = `${Math.round(n.x / cell)},${Math.round(n.y / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(n);
    }

    // Repulsión, solo contra las celdas vecinas (la lejana no mueve la aguja)
    for (const n of nodes) {
      const cx = Math.round(n.x / cell);
      const cy = Math.round(n.y / cell);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const bucket = grid.get(`${cx + i},${cy + j}`);
          if (!bucket) continue;
          for (const m of bucket) {
            if (m === n) continue;
            let dx = n.x - m.x;
            let dy = n.y - m.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 0.01;
            }
            const d = Math.sqrt(d2);
            const force = SIM.repulsion / d2;
            n.vx += (dx / d) * force;
            n.vy += (dy / d) * force;
          }
        }
      }
    }

    // Resortes: las aristas acercan; cuanto más conectado, más largo el resorte
    for (const e of edges) {
      const rest = 46 + Math.min(70, (e.a.degree + e.b.degree) * 1.6);
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const force = (d - rest) * SIM.spring;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      e.a.vx += fx;
      e.a.vy += fy;
      e.b.vx -= fx;
      e.b.vy -= fy;
    }

    // Centro de cada carpeta: es lo que crea los racimos de colores
    const centers = new Map();
    for (const n of nodes) {
      const c = centers.get(n.dir) || { x: 0, y: 0, n: 0 };
      c.x += n.x;
      c.y += n.y;
      c.n++;
      centers.set(n.dir, c);
    }
    for (const n of nodes) {
      const c = centers.get(n.dir);
      n.vx += (c.x / c.n - n.x) * SIM.cluster - n.x * SIM.gravity;
      n.vy += (c.y / c.n - n.y) * SIM.cluster - n.y * SIM.gravity;
    }

    for (const n of nodes) {
      if (n.pinned) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.vx *= SIM.damping;
      n.vy *= SIM.damping;
    }
  }

  function startLoop() {
    if (frame) return;
    const step = () => {
      frame = null;
      if (alpha > 0.02) {
        // Varias iteraciones por fotograma: converge rápido sin congelar la UI
        for (let i = 0; i < 4 && alpha > 0.02; i++) {
          tick();
          alpha *= 1 - 3 / SIM.ticks;
        }
        if (alpha <= 0.02) fitToView();
        frame = requestAnimationFrame(step);
      }
      draw();
    };
    frame = requestAnimationFrame(step);
  }

  function fitToView() {
    if (!nodes.length || !canvas) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const k = Math.min(w / (maxX - minX + 120), h / (maxY - minY + 120), 2.2);
    camera.k = Math.max(0.08, k);
    camera.x = -(minX + maxX) / 2;
    camera.y = -(minY + maxY) / 2;
  }

  // ============ Dibujo ============
  const toScreen = (n) => ({
    x: (n.x + camera.x) * camera.k + stage.clientWidth / 2,
    y: (n.y + camera.y) * camera.k + stage.clientHeight / 2,
  });

  const toWorld = (px, py) => ({
    x: (px - stage.clientWidth / 2) / camera.k - camera.x,
    y: (py - stage.clientHeight / 2) / camera.k - camera.y,
  });

  const radiusOf = (n) =>
    (n.type === "file" ? 4.2 : 2.8) + Math.min(5.5, Math.sqrt(n.degree) * 1.25);

  function draw() {
    if (!ctx) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const focus = hoveredId || selectedId;
    const near = focus ? adjacency.get(focus) || new Set() : null;
    const filtering = matches.size > 0;

    // --- Aristas
    ctx.lineWidth = 1;
    for (const e of edges) {
      const hot = focus && (e.source === focus || e.target === focus);
      if (focus && !hot) ctx.strokeStyle = cssVar("--graph-dim");
      else if (hot) ctx.strokeStyle = cssVar("--graph-edge-hot");
      else ctx.strokeStyle = cssVar("--graph-edge");
      ctx.globalAlpha = focus && !hot ? 0.25 : 1;
      ctx.setLineDash(e.ambiguous ? [3, 3] : []);
      const a = toScreen(e.a);
      const b = toScreen(e.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // --- Nodos
    const labels = [];
    for (const n of nodes) {
      const p = toScreen(n);
      if (p.x < -60 || p.y < -60 || p.x > w + 60 || p.y > h + 60) continue;
      const r = radiusOf(n) * Math.min(1.6, Math.max(0.65, camera.k));
      const dimmed = (focus && n.id !== focus && !near.has(n.id)) || (filtering && !matches.has(n.id));

      ctx.globalAlpha = dimmed ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (n.type === "file") {
        ctx.strokeStyle = colorFor(n);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else {
        ctx.fillStyle = colorFor(n);
        ctx.fill();
      }

      if (n.id === selectedId || matches.has(n.id)) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = cssVar("--accent");
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      const important = n.id === focus || n.id === selectedId || (near && near.has(n.id)) || matches.has(n.id);
      if (important || (camera.k > 1.15 && n.degree >= 3) || nodes.length < 90) {
        labels.push({ p, n, dimmed, r });
      }
    }

    // --- Etiquetas encima de todo
    ctx.globalAlpha = 1;
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textBaseline = "middle";
    for (const { p, n, dimmed, r } of labels) {
      ctx.fillStyle = dimmed ? cssVar("--faint") : cssVar("--text-2");
      ctx.globalAlpha = dimmed ? 0.35 : 1;
      ctx.fillText(n.label, p.x + r + 5, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ============ Interacción ============
  function nodeAt(px, py) {
    let best = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      const p = toScreen(n);
      const d = Math.hypot(p.x - px, p.y - py);
      const r = radiusOf(n) * Math.min(1.6, Math.max(0.65, camera.k)) + 5;
      if (d < r && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  function bindCanvas() {
    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const node = nodeAt(px, py);
      if (node) {
        node.pinned = true;
        drag = { type: "node", node, moved: false };
      } else {
        drag = { type: "pan", x: px, y: py, moved: false };
        canvas.classList.add("dragging");
      }
    });

    window.addEventListener("mousemove", (e) => {
      if (!canvas || !stage.offsetParent) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      if (drag && drag.type === "node") {
        const world = toWorld(px, py);
        drag.node.x = world.x;
        drag.node.y = world.y;
        drag.moved = true;
        alpha = Math.max(alpha, 0.35);
        startLoop();
        return;
      }
      if (drag && drag.type === "pan") {
        camera.x += (px - drag.x) / camera.k;
        camera.y += (py - drag.y) / camera.k;
        drag.x = px;
        drag.y = py;
        drag.moved = true;
        draw();
        return;
      }

      const node = nodeAt(px, py);
      const id = node ? node.id : null;
      if (id !== hoveredId) {
        hoveredId = id;
        canvas.title = node ? `${node.label} — ${node.file}${node.line ? ":" + node.line : ""}` : "";
        draw();
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      if (drag.type === "node") {
        drag.node.pinned = false;
        if (!drag.moved) select(drag.node.id);
      } else if (!drag.moved) {
        select(null);
      }
      canvas.classList.remove("dragging");
      drag = null;
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const before = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      const factor = Math.exp(-e.deltaY * 0.0016);
      camera.k = Math.min(6, Math.max(0.06, camera.k * factor));
      const after = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      camera.x += after.x - before.x;
      camera.y += after.y - before.y;
      draw();
    }, { passive: false });

    canvas.addEventListener("dblclick", () => {
      fitToView();
      draw();
    });
  }

  function select(id) {
    selectedId = id;
    renderInspector();
    draw();
  }

  // Centra la cámara en un nodo y lo selecciona
  function focusNode(id) {
    const node = byId.get(id);
    if (!node) return;
    camera.x = -node.x;
    camera.y = -node.y;
    camera.k = Math.max(camera.k, 1.1);
    select(id);
  }

  // ============ Inspector ============
  function renderInspector() {
    const box = $("#mapInspector");
    if (!box) return;
    const node = selectedId ? byId.get(selectedId) : null;

    if (!node) {
      box.innerHTML = `
        <span class="field-label">INSPECTOR</span>
        <div class="hint">
          Pulsa un punto para ver dónde está definido, a qué llama y desde dónde se usa.<br /><br />
          Rueda para acercar, arrastra para mover, doble clic para encuadrar todo.
          Las líneas punteadas son llamadas que el análisis no pudo atribuir con certeza.
        </div>`;
      return;
    }

    const outgoing = graph.edges.filter((e) => e.source === node.id);
    const incoming = graph.edges.filter((e) => e.target === node.id);
    const where = node.type === "fn" ? `${node.file}:${node.line}` : node.file;
    const meta = node.type === "fn"
      ? `${node.kind} · ${node.endLine - node.line + 1} líneas`
      : `${node.lang} · ${node.loc} líneas · ${node.defs} definiciones`;

    box.innerHTML = `
      <div class="map-group">
        <div class="row baseline">
          <span class="map-ins-title">${escapeHtml(node.label)}</span>
          <span class="map-kind">${escapeHtml(node.type === "fn" ? node.kind : "archivo")}</span>
        </div>
        <span class="map-ins-sub">${escapeHtml(where)}</span>
        <span class="map-ins-sub">${escapeHtml(meta)}</span>
      </div>
      <div class="map-ins-actions">
        <button class="btn" data-copy="path">Copiar ruta</button>
        <button class="btn primary" data-copy="context">Copiar contexto para Claude</button>
      </div>
      ${refGroup(node.type === "fn" ? "LLAMA A" : "IMPORTA", outgoing, "target")}
      ${refGroup(node.type === "fn" ? "SE USA EN" : "LO IMPORTAN", incoming, "source")}
    `;

    box.querySelectorAll("[data-goto]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.goto;
        if (byId.has(id)) focusNode(id);
        else flashInspector("Ese nodo no está en la vista actual");
      });
    });
    box.querySelector('[data-copy="path"]').addEventListener("click", () => {
      navigator.clipboard.writeText(`${currentPath}/${node.file}`);
      flashInspector("Ruta copiada");
    });
    box.querySelector('[data-copy="context"]').addEventListener("click", () => {
      navigator.clipboard.writeText(buildContext(node, outgoing, incoming));
      flashInspector("Contexto copiado: pégaselo a Claude Code");
    });
  }

  function refGroup(title, list, side) {
    if (!list.length) {
      return `<div class="map-group"><span class="field-label">${title}</span>
        <span class="map-empty-group">Nada por aquí.</span></div>`;
    }
    const rows = list
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
      .map((e) => {
        const id = e[side];
        const other = graph.nodes.find((n) => n.id === id);
        if (!other) return "";
        const site = e.sites && e.sites[0];
        const place = side === "source"
          ? `${other.file}${site ? ":" + site.line : ""}`
          : `${other.file}${other.line ? ":" + other.line : ""}`;
        return `
          <button class="map-ref ${e.ambiguous ? "guess" : ""}" data-goto="${escapeAttr(id)}"
                  title="${escapeAttr(place)}${e.ambiguous ? " — atribución dudosa" : ""}">
            <span class="dot" style="background:${colorFor(other)}"></span>
            <span>${escapeHtml(other.label)}${e.count > 1 ? ` ×${e.count}` : ""}</span>
            <span class="where">${escapeHtml(place)}</span>
          </button>`;
      })
      .join("");
    return `<div class="map-group"><span class="field-label">${title} · ${list.length}</span>${rows}</div>`;
  }

  // El texto que el usuario pega en Claude Code para decirle dónde trabajar.
  function buildContext(node, outgoing, incoming) {
    const name = (id) => {
      const n = graph.nodes.find((x) => x.id === id);
      return n ? `${n.label} (${n.file}${n.line ? ":" + n.line : ""})` : id;
    };
    const lines = [];
    lines.push(`Proyecto: ${currentPath}`);
    if (node.type === "fn") {
      lines.push(`Función: ${node.label}`);
      lines.push(`Definida en: ${node.file}:${node.line}-${node.endLine}`);
    } else {
      lines.push(`Archivo: ${node.file} (${node.loc} líneas, ${node.lang}, ${node.defs} definiciones)`);
    }
    lines.push("");
    lines.push(outgoing.length ? "Depende de:" : "No depende de nada del proyecto.");
    outgoing.slice(0, 25).forEach((e) => lines.push(`- ${name(e.target)}${e.ambiguous ? " [dudoso]" : ""}`));
    lines.push("");
    lines.push(incoming.length ? "Se usa en:" : "No se usa en ningún otro sitio del proyecto.");
    incoming.slice(0, 25).forEach((e) => {
      const site = e.sites && e.sites[0];
      const from = site ? `${site.file}:${site.line}${site.fn ? ` (dentro de ${site.fn})` : ""}` : name(e.source);
      lines.push(`- ${from}${e.ambiguous ? " [dudoso]" : ""}`);
    });
    lines.push("");
    lines.push("Datos de un análisis estático por expresiones regulares: verifica antes de tocar.");
    return lines.join("\n");
  }

  function flashInspector(msg) {
    const box = $("#mapInspector");
    let tag = box.querySelector(".saved-msg");
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "saved-msg";
      box.prepend(tag);
    }
    tag.textContent = msg;
    tag.style.opacity = "1";
    clearTimeout(tag._t);
    tag._t = setTimeout(() => (tag.style.opacity = "0"), 2200);
  }

  // ============ Cromo de la pestaña ============
  function overlay(text, busy) {
    const el = $("#mapOverlay");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.classList.toggle("busy", !!busy);
    el.innerHTML = `<span class="plan-empty-title">${escapeHtml(text)}</span>`;
  }

  function renderStats() {
    const el = $("#mapStats");
    if (!el) return;
    if (!graph) {
      el.textContent = "";
      return;
    }
    const s = graph.stats;
    el.textContent = `${s.analyzed}/${s.files} archivos · ${s.functions} funciones · ${s.calls} llamadas${s.truncated ? " · recortado" : ""}`;
  }

  function renderLegend() {
    const el = $("#mapLegend");
    if (!el || !graph) return;
    const dirs = [...new Set(graph.nodes.map((n) => n.dir))].sort().slice(0, 12);
    el.innerHTML = dirs
      .map((d) => `<span><i style="background:${colorFor({ dir: d })}"></i>${escapeHtml(d || "raíz")}</span>`)
      .join("");
  }

  async function fillProjects() {
    const select = $("#mapProject");
    if (!select) return;
    let list = [];
    try {
      list = await api("/api/projects");
    } catch (_) {
      return;
    }
    const preferred = currentPath || (typeof currentPlan !== "undefined" && currentPlan?.project) || list[0]?.path;
    select.innerHTML =
      '<option value="">Elige una carpeta…</option>' +
      list
        .filter((p) => p.exists)
        .map((p) => `<option value="${escapeAttr(p.path)}">${escapeHtml(p.name)} — ${escapeHtml(tildePath(p.path))}</option>`)
        .join("");
    if (preferred && [...select.options].some((o) => o.value === preferred)) select.value = preferred;
  }

  function applySearch(term) {
    matches = new Set();
    const q = term.trim().toLowerCase();
    if (q) {
      for (const n of nodes) {
        if (n.label.toLowerCase().includes(q) || n.file.toLowerCase().includes(q)) matches.add(n.id);
      }
    }
    draw();
  }

  // ============ Arranque ============
  function bind() {
    stage = $("#mapStage");
    canvas = $("#mapCanvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    bindCanvas();

    $("#mapProject").addEventListener("change", (e) => {
      byId = new Map(); // posiciones de otro proyecto no sirven
      if (e.target.value) load(e.target.value);
    });
    $("#mapRefreshBtn").addEventListener("click", () => currentPath && load(currentPath, true));
    $("#mapSearch").addEventListener("input", (e) => applySearch(e.target.value));
    $("#mapSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && matches.size) focusNode([...matches][0]);
    });
    $("#mapMode").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      $$("#mapMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
      selectedId = null;
      buildView();
      renderInspector();
    });

    new ResizeObserver(() => draw()).observe(stage);
    renderInspector();
  }

  return {
    // Se llama al entrar en la pestaña
    async open() {
      if (!ctx) bind();
      await fillProjects();
      const select = $("#mapProject");
      if (!select.value) {
        overlay("Elige una carpeta arriba para dibujar su mapa");
        return;
      }
      if (!graph) load(select.value);
      else draw();
    },
    resize: () => draw(),
  };
})();
