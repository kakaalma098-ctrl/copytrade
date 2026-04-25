/**
 * laser-helius dashboard — zero-dep static file server with a thin /api
 * reverse proxy to the bot's control server (default 127.0.0.1:9092).
 *
 * Keeps the bot hot path untouched: the dashboard runs as a separate PM2
 * process, so HTTP handling doesn't steal event-loop time from trading.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const BIND = process.env.DASHBOARD_BIND || "0.0.0.0";
const CONTROL_HOST = process.env.CONTROL_API_HOST || "127.0.0.1";
const CONTROL_PORT = Number(process.env.CONTROL_API_PORT || 9092);
const CONTROL_TOKEN = process.env.CONTROL_API_TOKEN || "";

const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const sendFile = (res, filePath) => {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
};

const proxyToControl = (req, res) => {
  const target = req.url.replace(/^\/api/, "/api");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
      "Content-Length": body.length,
    };
    if (CONTROL_TOKEN) {
      headers["x-auth-token"] = CONTROL_TOKEN;
    }
    const upstream = http.request(
      {
        host: CONTROL_HOST,
        port: CONTROL_PORT,
        method: req.method,
        path: target,
        headers,
        timeout: 8000,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: "control API unreachable",
          detail: e.message,
          host: `${CONTROL_HOST}:${CONTROL_PORT}`,
        }),
      );
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
};

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    proxyToControl(req, res);
    return;
  }
  let filePath = path.normalize(
    path.join(PUBLIC_DIR, req.url === "/" ? "index.html" : req.url),
  );
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback to index.html for unknown routes.
      sendFile(res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }
    sendFile(res, filePath);
  });
});

server.listen(PORT, BIND, () => {
  console.log(
    `[dashboard] listening on http://${BIND}:${PORT} → proxying /api → ${CONTROL_HOST}:${CONTROL_PORT}`,
  );
});
