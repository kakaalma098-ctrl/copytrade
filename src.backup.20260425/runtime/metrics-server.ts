import http from "node:http";
import { metrics } from "./metrics-registry.js";

let server: http.Server | null = null;

/**
 * Phase 6: start a minimal HTTP server exposing `GET /metrics` in Prometheus
 * text-format. Binds to 0.0.0.0 so external scrapers can reach it; firewall
 * the port at VPS level if that is undesired.
 *
 * `port <= 0` disables the server (no-op).
 */
export function startMetricsServer(port: number): void {
  if (server != null) return;
  if (!Number.isFinite(port) || port <= 0) return;

  server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
      res.end(metrics.render());
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("error", (e) => {
    console.warn(
      `[metrics] server error: ${e instanceof Error ? e.message : String(e)}`,
    );
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(
      `[metrics] Prometheus endpoint listening on 0.0.0.0:${port}/metrics`,
    );
  });
}

export function stopMetricsServer(): void {
  if (server == null) return;
  const s = server;
  server = null;
  s.close();
}
