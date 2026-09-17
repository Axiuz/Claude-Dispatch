// App nativa de macOS: arranca LM Studio y el orquestador con launcher.sh
// y muestra el panel en una ventana propia (WKWebView), sin navegador.
import Cocoa
import WebKit

// El servidor solo sirve el panel a clientes con este user agent
let appUserAgent = "SingularityApp"

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var window: NSWindow!
  var webView: WKWebView!
  let launcher = Bundle.main.path(forResource: "launcher", ofType: "sh")!

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    buildWindow()
    showStatus("Arrancando LM Studio y el orquestador…")

    DispatchQueue.global(qos: .userInitiated).async {
      let (ok, output) = self.runLauncher("start")
      DispatchQueue.main.async {
        if ok, let url = URL(string: output.trimmingCharacters(in: .whitespacesAndNewlines)) {
          self.webView.load(URLRequest(url: url))
        } else {
          self.fatal(output)
        }
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    _ = runLauncher("stop")
  }

  // Devuelve stdout si terminó bien, o stderr si falló
  func runLauncher(_ action: String) -> (Bool, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [launcher, action]
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    do {
      try process.run()
    } catch {
      return (false, error.localizedDescription)
    }
    let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    process.waitUntilExit()
    return process.terminationStatus == 0 ? (true, stdout) : (false, stderr.isEmpty ? stdout : stderr)
  }

  func buildWindow() {
    let config = WKWebViewConfiguration()
    // WKWebView no siempre deja usar navigator.clipboard; lo resolvemos en nativo
    config.userContentController.add(self, name: "clipboard")
    // "Seleccione carpeta" del panel abre el diálogo nativo de Finder
    config.userContentController.add(self, name: "pickFolder")
    config.userContentController.addUserScript(WKUserScript(
      source: """
        navigator.clipboard.writeText = (text) => {
          window.webkit.messageHandlers.clipboard.postMessage(String(text));
          return Promise.resolve();
        };
        """,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true))

    webView = WKWebView(frame: .zero, configuration: config)
    webView.customUserAgent = appUserAgent
    webView.uiDelegate = self

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Singularity"
    // Tres columnas (proyectos, centro, agentes) no caben en menos
    window.minSize = NSSize(width: 1000, height: 620)
    window.contentView = webView
    window.center()
    window.setFrameAutosaveName("SingularityMain")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func showStatus(_ text: String) {
    webView.loadHTMLString("""
      <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0a;
      color:#a2a29a;font:14px -apple-system,system-ui">\(text)</body>
      """, baseURL: nil)
  }

  func fatal(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "No se pudo arrancar Singularity"
    alert.informativeText = message
    alert.alertStyle = .critical
    alert.runModal()
    NSApp.terminate(nil)
  }

  func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Ocultar Singularity", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Salir de Singularity", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    // Sin menú Edición, Cmd+C / Cmd+V no llegan a los campos de texto del panel
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edición")
    editMenu.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "Ver")
    viewMenu.addItem(withTitle: "Recargar", action: #selector(reload), keyEquivalent: "r")
    viewItem.submenu = viewMenu
    main.addItem(viewItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Ventana")
    windowMenu.addItem(withTitle: "Minimizar", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)

    NSApp.mainMenu = main
  }

  @objc func reload() { webView.reload() }

  // ---- Puentes con el panel: portapapeles y selector de carpeta ----
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    switch message.name {
    case "clipboard":
      guard let text = message.body as? String else { return }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    case "pickFolder":
      pickFolder()
    default:
      break
    }
  }

  func pickFolder() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Abrir proyecto"
    panel.message = "Elige la carpeta del proyecto donde se abrirá Claude Code"
    panel.beginSheetModal(for: window) { response in
      guard response == .OK, let path = panel.url?.path,
            let json = try? JSONEncoder().encode(path),
            let arg = String(data: json, encoding: .utf8) else { return }
      // JSON escapa comillas y barras: la ruta llega intacta como string de JS
      self.webView.evaluateJavaScript("window.onFolderPicked(\(arg))")
    }
  }

  // ---- alert / confirm / prompt del panel ----
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "Aceptar")
    alert.addButton(withTitle: "Cancelar")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping (String?) -> Void) {
    let alert = NSAlert()
    alert.messageText = prompt
    alert.addButton(withTitle: "Aceptar")
    alert.addButton(withTitle: "Cancelar")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.stringValue = defaultText ?? ""
    alert.accessoryView = field
    alert.window.initialFirstResponder = field
    completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
