// Simulador de LM Studio para desarrollar sin cargar el modelo.
// Responde /v1/models y /v1/chat/completions con streaming SSE.
// En el prompt: FORZAR_ERROR responde 500, FORZAR_RAZONAMIENTO manda
// reasoning_content antes de la respuesta, FORZAR_CUELGUE abre el stream y no
// manda nada (para probar el timeout de inactividad) y FORZAR_LENTO escribe un
// token por segundo.
const http = require("http");

// MOCK_PORT permite usarlo con LM Studio real abierto en el 1234
const PORT = parseInt(process.env.MOCK_PORT, 10) || 1234;
const MODEL = "omnicoder-9b";

function streamReply(res, text, thinking = "", everyMs = 40) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  // Primero el razonamiento (si lo hay) y luego la respuesta, como un modelo que piensa
  const pieces = [
    ...thinking.split(/(\s+)/).filter(Boolean).map((w) => ({ reasoning_content: w })),
    ...text.split(/(\s+)/).map((w) => ({ content: w })),
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (i >= pieces.length) {
      clearInterval(timer);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const chunk = { choices: [{ delta: pieces[i++] }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }, everyMs);
  res.on("close", () => clearInterval(timer));
}

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // MOCK_SIN_MODELO simula el servidor encendido sin modelo cargado
      return res.end(JSON.stringify({ data: process.env.MOCK_SIN_MODELO ? [] : [{ id: MODEL }] }));
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { messages = [] } = JSON.parse(body || "{}");
        const prompt = messages.at(-1)?.content || "";
        if (prompt.includes("FORZAR_CUELGUE")) {
          // Un LM Studio saturado: acepta la petición y nunca escribe nada
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          return;
        }
        if (prompt.includes("FORZAR_ERROR")) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Error simulado por FORZAR_ERROR" }));
        }
        const reply =
          "function isValidEmail(email) {\n  const re = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\n  return re.test(String(email));\n}\n\n" +
          `Respuesta simulada para: ${prompt.slice(0, 80)}`;
        const thinking = prompt.includes("FORZAR_RAZONAMIENTO")
          ? "El usuario pide validar un email. Una regex sencilla basta: algo antes de la arroba, dominio y extensión. No hace falta cubrir todo el RFC 5322."
          : "";
        streamReply(res, reply, thinking, prompt.includes("FORZAR_LENTO") ? 1000 : 40);
      });
      return;
    }

    res.writeHead(404).end();
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Mock de LM Studio → http://127.0.0.1:${PORT}`));
