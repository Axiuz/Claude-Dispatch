// ============ Pestaña Editor ============
// Monaco (el editor de VS Code) servido desde node_modules, sin build step: se
// carga con su loader AMD la primera vez que se abre la pestaña, no al arrancar
// el panel, porque son varios megas.
//
// El estado vive aquí dentro y no en app.js: lo único que comparte con el resto
// del panel son las variables CSS del tema y los proyectos de la lista.

const CodeEditor = (() => {
  const $ = (s) => document.querySelector(s);

  const FILE_KINDS = {
    js: { lang: "javascript", icon: "JS", color: "var(--amber)" },
    mjs: { lang: "javascript", icon: "JS", color: "var(--amber)" },
    cjs: { lang: "javascript", icon: "JS", color: "var(--amber)" },
    jsx: { lang: "javascript", icon: "JX", color: "var(--amber)" },
    ts: { lang: "typescript", icon: "TS", color: "var(--violet)" },
    tsx: { lang: "typescript", icon: "TX", color: "var(--violet)" },
    mts: { lang: "typescript", icon: "TS", color: "var(--violet)" },
    cts: { lang: "typescript", icon: "TS", color: "var(--violet)" },
    coffee: { lang: "coffeescript", icon: "CF", color: "var(--amber)" },
    json: { lang: "json", icon: "{}", color: "var(--amber)" },
    jsonc: { lang: "json", icon: "{}", color: "var(--amber)" },
    json5: { lang: "json", icon: "{}", color: "var(--amber)" },
    jsonl: { lang: "json", icon: "{}", color: "var(--amber)" },
    geojson: { lang: "json", icon: "{}", color: "var(--green)" },
    webmanifest: { lang: "json", icon: "{}", color: "var(--muted)" },

    html: { lang: "html", icon: "<>", color: "var(--accent)" },
    htm: { lang: "html", icon: "<>", color: "var(--accent)" },
    xhtml: { lang: "html", icon: "<>", color: "var(--accent)" },
    pug: { lang: "pug", icon: "PG", color: "var(--red)" },
    jade: { lang: "pug", icon: "PG", color: "var(--red)" },
    hbs: { lang: "handlebars", icon: "HB", color: "var(--amber)" },
    handlebars: { lang: "handlebars", icon: "HB", color: "var(--amber)" },
    twig: { lang: "twig", icon: "TW", color: "var(--green)" },
    liquid: { lang: "liquid", icon: "LQ", color: "var(--green)" },
    erb: { lang: "ruby", icon: "ER", color: "var(--red)" },
    cshtml: { lang: "razor", icon: "RZ", color: "var(--violet)" },
    razor: { lang: "razor", icon: "RZ", color: "var(--violet)" },

    css: { lang: "css", icon: "CS", color: "var(--violet)" },
    scss: { lang: "scss", icon: "SC", color: "var(--violet)" },
    sass: { lang: "scss", icon: "SA", color: "var(--violet)" },
    less: { lang: "less", icon: "LE", color: "var(--violet)" },

    xml: { lang: "xml", icon: "<>", color: "var(--muted)" },
    svg: { lang: "xml", icon: "SV", color: "var(--violet)" },
    xsd: { lang: "xml", icon: "XS", color: "var(--muted)" },
    xsl: { lang: "xml", icon: "XL", color: "var(--muted)" },
    plist: { lang: "xml", icon: "PL", color: "var(--muted)" },
    storyboard: { lang: "xml", icon: "SB", color: "var(--muted)" },
    csproj: { lang: "xml", icon: "PJ", color: "var(--green)" },
    gradle: { lang: "xml", icon: "GR", color: "var(--green)" },

    md: { lang: "markdown", icon: "MD", color: "var(--muted)" },
    markdown: { lang: "markdown", icon: "MD", color: "var(--muted)" },
    mdx: { lang: "mdx", icon: "MX", color: "var(--muted)" },
    rst: { lang: "restructuredtext", icon: "RS", color: "var(--muted)" },

    yml: { lang: "yaml", icon: "YM", color: "var(--red)" },
    yaml: { lang: "yaml", icon: "YM", color: "var(--red)" },
    lock: { lang: "yaml", icon: "LK", color: "var(--muted)" },
    toml: { lang: "ini", icon: "TM", color: "var(--red)" },
    ini: { lang: "ini", icon: "IN", color: "var(--muted)" },
    cfg: { lang: "ini", icon: "CF", color: "var(--muted)" },
    conf: { lang: "ini", icon: "CF", color: "var(--muted)" },
    properties: { lang: "ini", icon: "PR", color: "var(--muted)" },
    editorconfig: { lang: "ini", icon: "EC", color: "var(--muted)" },

    py: { lang: "python", icon: "PY", color: "var(--green)" },
    pyw: { lang: "python", icon: "PY", color: "var(--green)" },
    pyi: { lang: "python", icon: "PI", color: "var(--green)" },
    rb: { lang: "ruby", icon: "RB", color: "var(--red)" },
    rake: { lang: "ruby", icon: "RK", color: "var(--red)" },
    gemspec: { lang: "ruby", icon: "GS", color: "var(--red)" },
    php: { lang: "php", icon: "PH", color: "var(--violet)" },
    phtml: { lang: "php", icon: "PH", color: "var(--violet)" },
    pl: { lang: "perl", icon: "PL", color: "var(--violet)" },
    pm: { lang: "perl", icon: "PM", color: "var(--violet)" },
    lua: { lang: "lua", icon: "LU", color: "var(--violet)" },
    r: { lang: "r", icon: "R", color: "var(--green)" },
    rmd: { lang: "r", icon: "RM", color: "var(--green)" },
    jl: { lang: "julia", icon: "JL", color: "var(--violet)" },
    tcl: { lang: "tcl", icon: "TC", color: "var(--muted)" },
    tk: { lang: "tcl", icon: "TK", color: "var(--muted)" },
    ex: { lang: "elixir", icon: "EX", color: "var(--violet)" },
    exs: { lang: "elixir", icon: "EX", color: "var(--violet)" },
    clj: { lang: "clojure", icon: "CJ", color: "var(--green)" },
    cljs: { lang: "clojure", icon: "CJ", color: "var(--green)" },
    cljc: { lang: "clojure", icon: "CJ", color: "var(--green)" },
    edn: { lang: "clojure", icon: "ED", color: "var(--green)" },
    scm: { lang: "scheme", icon: "SM", color: "var(--muted)" },
    ss: { lang: "scheme", icon: "SM", color: "var(--muted)" },

    java: { lang: "java", icon: "JV", color: "var(--red)" },
    kt: { lang: "kotlin", icon: "KT", color: "var(--violet)" },
    kts: { lang: "kotlin", icon: "KT", color: "var(--violet)" },
    scala: { lang: "scala", icon: "SL", color: "var(--red)" },
    sc: { lang: "scala", icon: "SL", color: "var(--red)" },
    sbt: { lang: "scala", icon: "SB", color: "var(--red)" },
    groovy: { lang: "java", icon: "GV", color: "var(--green)" },
    go: { lang: "go", icon: "GO", color: "var(--accent)" },
    rs: { lang: "rust", icon: "RS", color: "var(--accent)" },
    dart: { lang: "dart", icon: "DA", color: "var(--green)" },
    swift: { lang: "swift", icon: "SW", color: "var(--accent)" },
    m: { lang: "objective-c", icon: "OC", color: "var(--accent)" },
    mm: { lang: "objective-c", icon: "OC", color: "var(--accent)" },
    cs: { lang: "csharp", icon: "C#", color: "var(--green)" },
    csx: { lang: "csharp", icon: "C#", color: "var(--green)" },
    fs: { lang: "fsharp", icon: "F#", color: "var(--violet)" },
    fsi: { lang: "fsharp", icon: "F#", color: "var(--violet)" },
    fsx: { lang: "fsharp", icon: "F#", color: "var(--violet)" },
    vb: { lang: "vb", icon: "VB", color: "var(--violet)" },
    bas: { lang: "vb", icon: "BA", color: "var(--violet)" },
    vbs: { lang: "vb", icon: "VB", color: "var(--violet)" },
    pas: { lang: "pascal", icon: "PA", color: "var(--muted)" },
    pp: { lang: "pascal", icon: "PA", color: "var(--muted)" },
    abap: { lang: "abap", icon: "AB", color: "var(--muted)" },
    cls: { lang: "apex", icon: "AX", color: "var(--muted)" },
    trigger: { lang: "apex", icon: "AX", color: "var(--muted)" },

    c: { lang: "c", icon: "C", color: "var(--muted)" },
    h: { lang: "c", icon: "H", color: "var(--muted)" },
    cpp: { lang: "cpp", icon: "C+", color: "var(--muted)" },
    cc: { lang: "cpp", icon: "C+", color: "var(--muted)" },
    cxx: { lang: "cpp", icon: "C+", color: "var(--muted)" },
    hpp: { lang: "cpp", icon: "H+", color: "var(--muted)" },
    hh: { lang: "cpp", icon: "H+", color: "var(--muted)" },
    hxx: { lang: "cpp", icon: "H+", color: "var(--muted)" },
    ino: { lang: "cpp", icon: "AR", color: "var(--green)" },
    s: { lang: "mips", icon: "AS", color: "var(--ghost)" },
    asm: { lang: "mips", icon: "AS", color: "var(--ghost)" },
    v: { lang: "systemverilog", icon: "VL", color: "var(--muted)" },
    vh: { lang: "systemverilog", icon: "VL", color: "var(--muted)" },
    sv: { lang: "systemverilog", icon: "SV", color: "var(--muted)" },
    svh: { lang: "systemverilog", icon: "SV", color: "var(--muted)" },
    wgsl: { lang: "wgsl", icon: "WG", color: "var(--violet)" },
    qs: { lang: "qsharp", icon: "Q#", color: "var(--violet)" },
    sol: { lang: "solidity", icon: "SO", color: "var(--muted)" },

    sh: { lang: "shell", icon: "SH", color: "var(--green)" },
    bash: { lang: "shell", icon: "SH", color: "var(--green)" },
    zsh: { lang: "shell", icon: "ZS", color: "var(--green)" },
    fish: { lang: "shell", icon: "FI", color: "var(--green)" },
    ksh: { lang: "shell", icon: "KS", color: "var(--green)" },
    env: { lang: "shell", icon: "EN", color: "var(--red)" },
    envrc: { lang: "shell", icon: "EN", color: "var(--red)" },
    ps1: { lang: "powershell", icon: "PS", color: "var(--violet)" },
    psm1: { lang: "powershell", icon: "PS", color: "var(--violet)" },
    psd1: { lang: "powershell", icon: "PS", color: "var(--violet)" },
    bat: { lang: "bat", icon: "BT", color: "var(--ghost)" },
    cmd: { lang: "bat", icon: "BT", color: "var(--ghost)" },
    azcli: { lang: "azcli", icon: "AZ", color: "var(--accent)" },

    sql: { lang: "sql", icon: "SQ", color: "var(--accent)" },
    ddl: { lang: "sql", icon: "SQ", color: "var(--accent)" },
    dml: { lang: "sql", icon: "SQ", color: "var(--accent)" },
    mysql: { lang: "mysql", icon: "MY", color: "var(--accent)" },
    pgsql: { lang: "pgsql", icon: "PG", color: "var(--accent)" },
    redshift: { lang: "redshift", icon: "RS", color: "var(--accent)" },
    redis: { lang: "redis", icon: "RE", color: "var(--red)" },
    cyp: { lang: "cypher", icon: "CY", color: "var(--green)" },
    cypher: { lang: "cypher", icon: "CY", color: "var(--green)" },
    sparql: { lang: "sparql", icon: "SP", color: "var(--green)" },
    rq: { lang: "sparql", icon: "SP", color: "var(--green)" },
    dax: { lang: "msdax", icon: "DX", color: "var(--accent)" },
    pq: { lang: "powerquery", icon: "PQ", color: "var(--accent)" },
    ecl: { lang: "ecl", icon: "EC", color: "var(--muted)" },
    st: { lang: "st", icon: "ST", color: "var(--muted)" },

    graphql: { lang: "graphql", icon: "GQ", color: "var(--violet)" },
    gql: { lang: "graphql", icon: "GQ", color: "var(--violet)" },
    prisma: { lang: "graphql", icon: "PR", color: "var(--green)" },
    proto: { lang: "protobuf", icon: "PB", color: "var(--muted)" },
    tsp: { lang: "typespec", icon: "TP", color: "var(--violet)" },

    tf: { lang: "hcl", icon: "TF", color: "var(--violet)" },
    tfvars: { lang: "hcl", icon: "TV", color: "var(--violet)" },
    hcl: { lang: "hcl", icon: "HC", color: "var(--violet)" },
    bicep: { lang: "bicep", icon: "BC", color: "var(--accent)" },
    dockerfile: { lang: "dockerfile", icon: "DK", color: "var(--accent)" },
    csp: { lang: "csp", icon: "CP", color: "var(--muted)" },

    txt: { lang: "plaintext", icon: "TX", color: "var(--muted)" },
    log: { lang: "plaintext", icon: "LG", color: "var(--muted)" },
    csv: { lang: "plaintext", icon: "CV", color: "var(--green)" },
    tsv: { lang: "plaintext", icon: "TV", color: "var(--green)" },
    diff: { lang: "plaintext", icon: "DF", color: "var(--amber)" },
    patch: { lang: "plaintext", icon: "PT", color: "var(--amber)" },
    map: { lang: "plaintext", icon: "MP", color: "var(--ghost)" },
    bak: { lang: "plaintext", icon: "BK", color: "var(--ghost)" },
    tmpl: { lang: "plaintext", icon: "TM", color: "var(--ghost)" },
    makefile: { lang: "plaintext", icon: "MK", color: "var(--muted)" },
    mk: { lang: "plaintext", icon: "MK", color: "var(--muted)" },
    cmake: { lang: "plaintext", icon: "CM", color: "var(--muted)" },
    gitignore: { lang: "ini", icon: "GI", color: "var(--ghost)" },
    gitattributes: { lang: "ini", icon: "GA", color: "var(--ghost)" },
    npmrc: { lang: "ini", icon: "NP", color: "var(--ghost)" },
    nvmrc: { lang: "plaintext", icon: "NV", color: "var(--ghost)" },
    dockerignore: { lang: "ini", icon: "DI", color: "var(--ghost)" },
    eslintignore: { lang: "ini", icon: "ES", color: "var(--ghost)" },
    prettierignore: { lang: "ini", icon: "PY", color: "var(--ghost)" },
  };

  const BY_NAME = {
    dockerfile: "dockerfile",
    containerfile: "dockerfile",
    makefile: "makefile",
    gnumakefile: "makefile",
    "cmakelists.txt": "cmake",
    gemfile: "rb",
    rakefile: "rb",
    podfile: "rb",
    brewfile: "rb",
    procfile: "txt",
    license: "txt",
    "go.sum": "txt",
    "go.mod": "txt",
    "cargo.lock": "toml",
    "pnpm-lock.yaml": "lock",
  };

  const UNKNOWN_KIND = { lang: "plaintext", icon: "\u00b7\u00b7", color: "var(--ghost)" };

  // Normaliza el nombre a la clave de FILE_KINDS: quita los puntos del principio
  // para que .gitignore o .env caigan en su entrada, y BY_NAME resuelve los archivos
  // que no llevan extensión.
  function kindKey(name) {
    const lower = name.toLowerCase();
    if (BY_NAME[lower]) return BY_NAME[lower];
    if (lower.startsWith(".env")) return "env";
    const bare = lower.replace(/^\.+/, "");
    const dot = bare.lastIndexOf(".");
    return dot === -1 ? bare : bare.slice(dot + 1);
  }

  function kindFor(name) {
    return FILE_KINDS[kindKey(name)] || UNKNOWN_KIND;
  }

  // Índice de lenguajes construido una sola vez para evitar recalcularlo al iniciar,
  // usando los registros de Monaco y un mapa curado manualmente (FILE_KINDS) para
  // priorizar extensiones específicas como .prisma, que se abre como GraphQL.
  let langIndex = null;

  // Construye un índice que mapea extensiones y nombres de archivo a ids de lenguaje,
  // con los datos de monaco.languages.getLanguages(). Se guarda para reutilizarlo en
  // lugar de reconstruirlo.
  function buildLangIndex() {
    const index = { byExt: new Map(), byFile: new Map() };
    for (const lang of monaco.languages.getLanguages()) {
      (lang.extensions || []).forEach((e) => index.byExt.set(e.toLowerCase(), lang.id));
      (lang.filenames || []).forEach((f) => index.byFile.set(f.toLowerCase(), lang.id));
    }
    return index;
  }

  // Determina el lenguaje asociado a un nombre de archivo, priorizando reglas manuales
  // (FILE_KINDS) sobre el registro de Monaco, y usando una clave normalizada (kindKey)
  // para evitar problemas con puntos en nombres como .gitignore o .env.
  function langFor(name) {
    const curated = FILE_KINDS[kindKey(name)];
    if (curated) return curated.lang;
    if (!monaco) return UNKNOWN_KIND.lang;
    if (!langIndex) langIndex = buildLangIndex();
    const lower = name.toLowerCase();
    const byFile = langIndex.byFile.get(lower);
    if (byFile) return byFile;
    const dot = lower.lastIndexOf(".");
    const ext = dot > 0 ? lower.slice(dot) : "";
    return (ext && langIndex.byExt.get(ext)) || UNKNOWN_KIND.lang;
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
  let selectedDir = null;
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

  // Convierte un nombre de variable CSS (como --syn-comment) en un color hex
  // quitándole el # inicial: el foreground de una regla de Monaco va sin almohadilla.
  const hex = (name) => cssVar(name).replace("#", "");

  // Lista de reglas de sintaxis para Monaco, cada entrada es [token, css-var, estilo].
  // Los tonos se toman de las variables --syn-* en :root, evitando colores sueltos,
  // y se pasan a hex mediante hex() para compatibilidad con Monaco.
  const SYNTAX_RULES = [
    ["comment", "--syn-comment", "italic"],
    ["string", "--syn-string"],
    ["string.escape", "--syn-regexp"],
    ["regexp", "--syn-regexp"],
    ["number", "--syn-number"],
    ["constant", "--syn-constant"],
    ["keyword", "--syn-keyword"],
    ["keyword.flow", "--syn-control"],
    ["keyword.control", "--syn-control"],
    ["keyword.operator", "--syn-operator"],
    ["type", "--syn-type"],
    ["type.identifier", "--syn-type"],
    ["namespace", "--syn-type"],
    ["entity.name.class", "--syn-type"],
    ["entity.name.function", "--syn-function"],
    ["support.function", "--syn-function"],
    ["function", "--syn-function"],
    ["identifier", "--syn-variable"],
    ["variable", "--syn-variable"],
    ["variable.parameter", "--syn-variable"],
    ["operator", "--syn-operator"],
    ["operators", "--syn-operator"],
    ["delimiter", "--syn-operator"],
    ["tag", "--syn-tag"],
    ["metatag", "--syn-tag"],
    ["attribute.name", "--syn-attr"],
    ["attribute.value", "--syn-string"],
    ["annotation", "--syn-keyword"],
    ["key", "--syn-tag"],
    ["string.key", "--syn-tag"],
    ["string.value", "--syn-string"],
    ["invalid", "--syn-invalid"],
  ];

  function defineTheme() {
    monaco.editor.defineTheme("dispatch", {
      base: "vs-dark",
      inherit: true,
      rules: SYNTAX_RULES.map(([token, name, fontStyle]) =>
        fontStyle ? { token, foreground: hex(name), fontStyle } : { token, foreground: hex(name) }
      ),
      colors: {
        "editor.background": cssVar("--sunken"),
        "editor.foreground": cssVar("--code"),
        "editorGutter.background": cssVar("--sunken"),
        "editorLineNumber.foreground": cssVar("--ghost"),
        "editorLineNumber.activeForeground": cssVar("--accent"),
        "editorCursor.foreground": cssVar("--accent"),
        "editor.lineHighlightBackground": cssVar("--syn-line"),
        "editor.selectionBackground": cssVar("--syn-selection"),
        "editor.inactiveSelectionBackground": cssVar("--syn-selection-soft"),
        "editor.selectionHighlightBackground": cssVar("--syn-selection-soft"),
        "editor.wordHighlightBackground": cssVar("--syn-selection-soft"),
        "editor.findMatchBackground": cssVar("--syn-find"),
        "editor.findMatchHighlightBackground": cssVar("--syn-selection-soft"),
        "editorBracketMatch.background": cssVar("--syn-selection-soft"),
        "editorBracketMatch.border": cssVar("--border-strong"),
        "editorIndentGuide.background1": cssVar("--syn-guide"),
        "editorIndentGuide.activeBackground1": cssVar("--syn-guide-active"),
        "editorWhitespace.foreground": cssVar("--syn-guide-active"),
        "editorBracketHighlight.foreground1": cssVar("--syn-bracket-1"),
        "editorBracketHighlight.foreground2": cssVar("--syn-bracket-2"),
        "editorBracketHighlight.foreground3": cssVar("--syn-bracket-3"),
        "editorBracketHighlight.foreground4": cssVar("--syn-bracket-4"),
        "editorBracketHighlight.foreground5": cssVar("--syn-bracket-5"),
        "editorBracketHighlight.foreground6": cssVar("--syn-bracket-6"),
        "editorWidget.background": cssVar("--panel"),
        "editorWidget.border": cssVar("--border"),
        "editorSuggestWidget.background": cssVar("--panel"),
        "editorSuggestWidget.selectedBackground": cssVar("--panel-3"),
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
      fontSize: 13,
      fontWeight: "450",
      lineHeight: 1.55,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
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
      const marked = entry.dir ? entry.path === selectedDir : entry.path === activePath;
      row.className = `ed-row ${entry.dir ? "dir" : "file"}${marked ? " active" : ""}`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const kind = entry.dir ? null : kindFor(entry.name);
      const mark = entry.dir ? (expanded.has(entry.path) ? "▾" : "▸") : "";
      row.innerHTML = entry.dir
        ? `<span class="ed-caret">${mark}</span><span class="ed-name">${escapeHtml(entry.name)}</span>`
        : `<span class="ed-icon" style="color:${kind.color}">${kind.icon}</span>` +
          `<span class="ed-name">${escapeHtml(entry.name)}</span>` +
          `<span class="ed-dot"${files.get(entry.path)?.saved === false ? "" : " hidden"}>●</span>`;
      row.addEventListener("click", () => (entry.dir ? selectDir(entry.path) : openFile(entry.path)));
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

  // Actualiza la carpeta seleccionada en el árbol y activa su expansión.
  // El valor de dir se almacena en selectedDir, que es el padre de los nuevos elementos.
  // Si no hay carpeta seleccionada, se usa la raíz del proyecto.
  function selectDir(dir) {
    selectedDir = dir;
    return toggleDir(dir);
  }

  const targetDir = () => selectedDir || root;

  async function reloadDir(dir) {
    dirs.delete(dir);
    try {
      await loadDir(dir);
    } catch (err) {
      alert(err.message);
    }
    renderTree();
  }

  // Crea un nuevo archivo o carpeta dentro de la carpeta seleccionada.
  // Pide al usuario el nombre, valida que no esté vacío y envía la solicitud al servidor.
  // Si el recurso ya existe, el servidor devuelve un 409 y aquí solo se enseña ese mensaje.
  // Si todo sale bien, actualiza el árbol y selecciona el nuevo elemento.
  async function createEntry(kind) {
    const parent = targetDir();
    if (!parent) return alert("Elige un proyecto arriba.");

    const label = kind === "dir" ? "Nombre de la carpeta nueva" : "Nombre del archivo nuevo";
    const name = prompt(`${label}\n\nDentro de ${tildePath(parent)}`);
    if (!name || !name.trim()) return;

    const target = `${parent}/${name.trim()}`;
    const res = await fetch(kind === "dir" ? "/api/files/mkdir" : "/api/files/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || `HTTP ${res.status}`);

    if (parent !== root) expanded.add(parent);
    await reloadDir(parent);
    if (kind === "dir") {
      selectedDir = data.path;
      renderTree();
    } else {
      await openFile(data.path);
    }
    flash(`Creado ${baseName(data.path)}`);
  }

  // Abre el diálogo nativo para elegir la carpeta padre del nuevo proyecto: nace fuera
  // de las carpetas ya registradas, y es la única forma de que el usuario la elija a
  // conciencia. Después pide el nombre y si debe inicializarse con Git, y al crearlo lo
  // añade a la lista de proyectos y lo carga como raíz.
  function createProject() {
    requestFolder(async (parent) => {
      if (!parent) return;
      const name = prompt(`Nombre del proyecto nuevo\n\nSe crea dentro de ${tildePath(parent)}`);
      if (!name || !name.trim()) return;
      const git = confirm("¿Inicializar un repositorio Git dentro?");

      const res = await fetch("/api/projects/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent, name: name.trim(), git }),
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || `HTTP ${res.status}`);
      if (data.git && data.git.ok === false) alert(data.git.output);

      if (!projects.some((pr) => pr.path === data.project.path)) projects.unshift(data.project);
      await setRoot(data.project.path, { force: true });
      renderProjectPicker();
      flash(`Proyecto ${data.project.name} listo`);
    });
  }

  // ---- Archivos abiertos ----
  async function openFile(file) {
    await ensureEditor();
    if (!files.has(file)) {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(file)}`);
      const data = await res.json();
      if (!res.ok) return alert(data.error || `HTTP ${res.status}`);

      const model = monaco.editor.createModel(data.content, langFor(baseName(file)));
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
      selectedDir = null;
      return renderTree();
    }
    if (dir === root && !force) return;
    root = dir;
    selectedDir = dir;
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
  $("#edNewFileBtn").addEventListener("click", () => createEntry("file"));
  $("#edNewDirBtn").addEventListener("click", () => createEntry("dir"));
  $("#edNewProjectBtn").addEventListener("click", createProject);
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
