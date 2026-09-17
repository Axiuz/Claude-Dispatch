// ============ Pestaña Editor ============
// Monaco (el editor de VS Code) servido desde node_modules, sin build step: se
// carga con su loader AMD la primera vez que se abre la pestaña, no al arrancar
// el panel, porque son varios megas.
//
// El estado vive aquí dentro y no en app.js: lo único que comparte con el resto
// del panel son las variables CSS del tema y los proyectos de la lista.

const CodeEditor = (() => {
  const $ = (s) => document.querySelector(s);

  // ---- Extensión -> lenguaje de Monaco e icono del árbol ----
  // El icono son una o dos letras: en el árbol se ve mejor que un emoji.
  const FILE_KINDS = {
    js: { lang: "javascript", icon: "JS", color: "var(--amber)" },
    mjs: { lang: "javascript", icon: "JS", color: "var(--amber)" },
    cjs: { lang: "javascript", icon: "JS", color: "var(--amber)" },
    jsx: { lang: "javascript", icon: "JX", color: "var(--amber)" },
    ts: { lang: "typescript", icon: "TS", color: "var(--violet)" },
    tsx: { lang: "typescript", icon: "TX", color: "var(--violet)" },
    json: { lang: "json", icon: "{}", color: "var(--amber)" },
    jsonc: { lang: "json", icon: "{}", color: "var(--amber)" },
    json5: { lang: "json", icon: "{}", color: "var(--amber)" },
    html: { lang: "html", icon: "<>", color: "var(--accent)" },
    htm: { lang: "html", icon: "<>", color: "var(--accent)" },
    xml: { lang: "xml", icon: "<>", color: "var(--muted)" },
    svg: { lang: "xml", icon: "SV", color: "var(--violet)" },
    css: { lang: "css", icon: "CS", color: "var(--violet)" },
    scss: { lang: "scss", icon: "SC", color: "var(--violet)" },
    sass: { lang: "scss", icon: "SA", color: "var(--violet)" },
    less: { lang: "less", icon: "LE", color: "var(--violet)" },
    md: { lang: "markdown", icon: "MD", color: "var(--muted)" },
    mdx: { lang: "markdown", icon: "MX", color: "var(--muted)" },
    txt: { lang: "plaintext", icon: "TX", color: "var(--muted)" },
    log: { lang: "plaintext", icon: "LG", color: "var(--muted)" },
    csv: { lang: "plaintext", icon: "CV", color: "var(--green)" },
    yml: { lang: "yaml", icon: "YM", color: "var(--red)" },
    yaml: { lang: "yaml", icon: "YM", color: "var(--red)" },
    toml: { lang: "plaintext", icon: "TM", color: "var(--red)" },
    ini: { lang: "ini", icon: "IN", color: "var(--muted)" },
    env: { lang: "shell", icon: "EN", color: "var(--red)" },
    conf: { lang: "ini", icon: "CF", color: "var(--muted)" },
    py: { lang: "python", icon: "PY", color: "var(--green)" },
    rb: { lang: "ruby", icon: "RB", color: "var(--red)" },
    php: { lang: "php", icon: "PH", color: "var(--violet)" },
    java: { lang: "java", icon: "JV", color: "var(--red)" },
    kt: { lang: "kotlin", icon: "KT", color: "var(--violet)" },
    go: { lang: "go", icon: "GO", color: "var(--accent)" },
    rs: { lang: "rust", icon: "RS", color: "var(--accent)" },
    c: { lang: "c", icon: "C", color: "var(--muted)" },
    h: { lang: "c", icon: "H", color: "var(--muted)" },
    cpp: { lang: "cpp", icon: "C+", color: "var(--muted)" },
    hpp: { lang: "cpp", icon: "H+", color: "var(--muted)" },
    cs: { lang: "csharp", icon: "C#", color: "var(--green)" },
    swift: { lang: "swift", icon: "SW", color: "var(--accent)" },
    dart: { lang: "dart", icon: "DA", color: "var(--green)" },
    lua: { lang: "lua", icon: "LU", color: "var(--violet)" },
    r: { lang: "r", icon: "R", color: "var(--green)" },
    sh: { lang: "shell", icon: "SH", color: "var(--green)" },
    bash: { lang: "shell", icon: "SH", color: "var(--green)" },
    zsh: { lang: "shell", icon: "ZS", color: "var(--green)" },
    ps1: { lang: "powershell", icon: "PS", color: "var(--violet)" },
    sql: { lang: "sql", icon: "SQ", color: "var(--accent)" },
    prisma: { lang: "graphql", icon: "PR", color: "var(--green)" },
    graphql: { lang: "graphql", icon: "GQ", color: "var(--violet)" },
    gql: { lang: "graphql", icon: "GQ", color: "var(--violet)" },
    proto: { lang: "plaintext", icon: "PB", color: "var(--muted)" },
    tf: { lang: "hcl", icon: "TF", color: "var(--violet)" },
    dockerfile: { lang: "dockerfile", icon: "DK", color: "var(--accent)" },
    makefile: { lang: "plaintext", icon: "MK", color: "var(--muted)" },
    lock: { lang: "yaml", icon: "LK", color: "var(--muted)" },
  };
  // Archivos sin extensión que sí tienen lenguaje conocido
  const BY_NAME = { Dockerfile: "dockerfile", Makefile: "makefile", ".gitignore": "ini", ".env": "env" };

  function kindFor(name) {
    const byName = BY_NAME[name];
    const ext = byName || name.split(".").pop().toLowerCase();
    return FILE_KINDS[ext] || { lang: "plaintext", icon: "··", color: "var(--ghost)" };
  }

  // ---- Estado ----
  let monaco = null;
  let monacoPromise = null;
  let editor = null;
  let root = null; // carpeta del proyecto abierto
  const dirs = new Map(); // ruta de carpeta -> entradas ya leídas
  const expanded = new Set();
  const files = new Map(); // ruta -> {model, mtimeMs, saved}
  let activePath = null;
  let watchTimer = null;

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const baseName = (p) => p.split("/").pop();

  // ---- Carga de Monaco ----
  // El loader AMD se trae de /vendor/monaco, que es min/vs tal cual viene en
  // node_modules. Los workers se arrancan con ese mismo loader desde un blob.
  function workerUrl() {
    const base = `${location.origin}/vendor/monaco`;
    const src = [
      `self.MonacoEnvironment = { baseUrl: "${base}" };`,
      `importScripts("${base}/loader.js");`,
      `require.config({ paths: { vs: "${base}" } });`,
      `require(["vs/editor/editor.worker"], function () {});`,
    ].join("\n");
    return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  }

  function loadMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/monaco/editor/editor.main.css";
      document.head.appendChild(css);

      const script = document.createElement("script");
      script.src = "/vendor/monaco/loader.js";
      script.onerror = () => reject(new Error("No se pudo cargar Monaco desde /vendor/monaco"));
      script.onload = () => {
        window.require.config({ paths: { vs: "/vendor/monaco" } });
        window.MonacoEnvironment = { getWorkerUrl: workerUrl };
        window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
      };
      document.head.appendChild(script);
    });
    return monacoPromise;
  }

  // El tema sale de las variables de :root, para que el editor no desentone
  function defineTheme() {
    monaco.editor.defineTheme("dispatch", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": cssVar("--sunken"),
        "editor.foreground": cssVar("--code"),
        "editorGutter.background": cssVar("--sunken"),
        "editorLineNumber.foreground": cssVar("--ghost"),
        "editorLineNumber.activeForeground": cssVar("--accent"),
        "editorCursor.foreground": cssVar("--accent"),
        "editor.lineHighlightBackground": cssVar("--panel"),
        "editor.selectionBackground": cssVar("--panel-3"),
        "editorWidget.background": cssVar("--panel"),
        "editorWidget.border": cssVar("--border"),
        "editorSuggestWidget.background": cssVar("--panel"),
        "input.background": cssVar("--panel-2"),
        "minimap.background": cssVar("--sunken"),
        "scrollbarSlider.background": cssVar("--border-strong"),
      },
    });
    monaco.editor.setTheme("dispatch");
  }

  async function ensureEditor() {
    if (editor) return editor;
    monaco = await loadMonaco();
    defineTheme();
    editor = monaco.editor.create($("#edHost"), {
      automaticLayout: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.5,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 2,
      theme: "dispatch",
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    return editor;
  }

  // ---- Árbol de archivos ----
  async function loadDir(dir) {
    const res = await fetch(`/api/files/tree?path=${encodeURIComponent(dir)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    dirs.set(dir, data.entries);
    return data.entries;
  }

  function renderTree() {
    const host = $("#edTree");
    host.innerHTML = "";
    if (!root) {
      host.innerHTML = '<div class="ed-tree-empty">Elige un proyecto arriba.</div>';
      return;
    }
    host.appendChild(renderLevel(root, 0));
  }

  function renderLevel(dir, depth) {
    const wrap = document.createElement("div");
    (dirs.get(dir) || []).forEach((entry) => {
      const row = document.createElement("button");
      row.className = `ed-row ${entry.dir ? "dir" : "file"}${entry.path === activePath ? " active" : ""}`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const kind = entry.dir ? null : kindFor(entry.name);
      const mark = entry.dir ? (expanded.has(entry.path) ? "▾" : "▸") : "";
      row.innerHTML = entry.dir
        ? `<span class="ed-caret">${mark}</span><span class="ed-name">${escapeHtml(entry.name)}</span>`
        : `<span class="ed-icon" style="color:${kind.color}">${kind.icon}</span>` +
          `<span class="ed-name">${escapeHtml(entry.name)}</span>` +
          `<span class="ed-dot"${files.get(entry.path)?.saved === false ? "" : " hidden"}>●</span>`;
      row.addEventListener("click", () => (entry.dir ? toggleDir(entry.path) : openFile(entry.path)));
      wrap.appendChild(row);

      if (entry.dir && expanded.has(entry.path)) wrap.appendChild(renderLevel(entry.path, depth + 1));
    });
    return wrap;
  }

  async function toggleDir(dir) {
    if (expanded.has(dir)) expanded.delete(dir);
    else {
      expanded.add(dir);
      if (!dirs.has(dir)) {
        try {
          await loadDir(dir);
        } catch (err) {
          expanded.delete(dir);
          alert(err.message);
        }
      }
    }
    renderTree();
  }

  // ---- Archivos abiertos ----
  async function openFile(file) {
    await ensureEditor();
    if (!files.has(file)) {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(file)}`);
      const data = await res.json();
      if (!res.ok) return alert(data.error || `HTTP ${res.status}`);

      const model = monaco.editor.createModel(data.content, kindFor(baseName(file)).lang);
      const entry = { model, mtimeMs: data.mtimeMs, saved: true };
      model.onDidChangeContent(() => {
        if (entry.saved) {
          entry.saved = false;
          renderTabs();
          renderTree();
        }
      });
      files.set(file, entry);
    }
    activePath = file;
    editor.setModel(files.get(file).model);
    editor.focus();
    renderTabs();
    renderTree();
    $("#edPath").textContent = tildePath(file);
    startWatching();
  }

  function closeFile(file) {
    const entry = files.get(file);
    if (!entry) return;
    if (!entry.saved && !confirm(`"${baseName(file)}" tiene cambios sin guardar. ¿Cerrarlo igual?`)) return;
    entry.model.dispose();
    files.delete(file);
    if (activePath === file) {
      activePath = [...files.keys()][0] || null;
      if (activePath) editor.setModel(files.get(activePath).model);
      else editor.setModel(null);
      $("#edPath").textContent = activePath ? tildePath(activePath) : "";
    }
    renderTabs();
    renderTree();
  }

  function renderTabs() {
    const host = $("#edTabs");
    host.innerHTML = "";
    $("#edEmpty").hidden = files.size > 0;
    $("#edHost").hidden = files.size === 0;

    files.forEach((entry, file) => {
      const tab = document.createElement("div");
      tab.className = `ed-tab ${file === activePath ? "active" : ""}${entry.saved ? "" : " dirty"}`;
      tab.innerHTML =
        `<span class="ed-tab-name">${escapeHtml(baseName(file))}</span>` +
        `<button class="ed-tab-close" title="Cerrar">${entry.saved ? "✕" : "●"}</button>`;
      tab.addEventListener("click", (e) => {
        if (e.target.closest(".ed-tab-close")) closeFile(file);
        else openFile(file);
      });
      host.appendChild(tab);
    });
  }

  // ---- Guardar ----
  async function save() {
    if (!activePath) return;
    const entry = files.get(activePath);
    if (!entry) return;
    if (entry.saved) return flash("Sin cambios que guardar");

    const res = await fetch("/api/files/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: activePath, content: entry.model.getValue() }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || `HTTP ${res.status}`);

    entry.saved = true;
    entry.mtimeMs = data.mtimeMs;
    renderTabs();
    renderTree();
    flash(`Guardado ${baseName(activePath)}`);
  }

  function flash(text) {
    const el = $("#edSaved");
    el.textContent = text;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => (el.textContent = ""), 2200);
  }

  // ---- Vigilar cambios de Claude Code ----
  // Si Claude Code toca un archivo abierto y tú no lo has tocado, se recarga
  // solo. Si lo has tocado, no se pisa: se avisa y decides tú.
  function startWatching() {
    if (watchTimer) return;
    watchTimer = setInterval(checkExternalChanges, 3000);
  }

  async function checkExternalChanges() {
    const paths = [...files.keys()];
    if (!paths.length || document.hidden) return;

    try {
      const res = await fetch("/api/files/stat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) return;
      for (const row of await res.json()) {
        const entry = files.get(row.path);
        if (!entry || row.missing || row.mtimeMs === entry.mtimeMs) continue;
        if (!entry.saved) {
          flash(`${baseName(row.path)} cambió en disco y tienes cambios sin guardar`);
          entry.mtimeMs = row.mtimeMs;
          continue;
        }
        const read = await fetch(`/api/files/read?path=${encodeURIComponent(row.path)}`);
        if (!read.ok) continue;
        const data = await read.json();
        // setValue movería el cursor al principio: pushEditOperations lo respeta
        const model = entry.model;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: data.content }], () => null);
        model.pushStackElement();
        entry.mtimeMs = data.mtimeMs;
        entry.saved = true;
        flash(`${baseName(row.path)} se recargó: lo cambió Claude Code`);
        renderTabs();
      }
    } catch (_) {
      // el servidor puede estar reiniciándose: se reintenta al siguiente tic
    }
  }

  // ---- Proyecto ----
  function renderProjectPicker() {
    const sel = $("#edProject");
    const current = root;
    sel.innerHTML = '<option value="">Elige un proyecto…</option>';
    projects
      .filter((p) => p.exists !== false)
      .forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.path;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
    sel.value = current || "";
  }

  async function setRoot(dir, { force = false } = {}) {
    if (!dir) {
      root = null;
      return renderTree();
    }
    if (dir === root && !force) return;
    root = dir;
    dirs.clear();
    expanded.clear();
    try {
      await loadDir(root);
    } catch (err) {
      alert(err.message);
      root = null;
    }
    renderTree();
  }

  // ---- Entrada desde el panel ----
  // showTab("editor") llama aquí cada vez que se abre la pestaña.
  async function open() {
    renderProjectPicker();
    if (!root) {
      const first = projects.find((p) => p.exists !== false);
      if (first) {
        await setRoot(first.path);
        renderProjectPicker();
      } else {
        renderTree();
      }
    }
    if (files.size) await ensureEditor();
    renderTabs();
  }

  $("#edProject").addEventListener("change", (e) => setRoot(e.target.value));
  $("#edReloadBtn").addEventListener("click", () => setRoot(root, { force: true }));
  $("#edSaveBtn").addEventListener("click", () => save());

  // ⌘S funciona aunque el foco no esté dentro de Monaco
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      if (!document.querySelector("#tab-editor.active")) return;
      e.preventDefault();
      save();
    }
  });

  return { open, setRoot, openFile };
})();
