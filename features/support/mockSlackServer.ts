import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockSlackConfig {
  body?: string;
  status?: number;
  delay?: number;
  transientKind?: "500" | "timeout";
  failuresBeforeSuccess?: number;
}

export interface MockSlackRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface MockSlackHandle {
  url: string;
  stop(): Promise<void>;
  hitCount(): number;
  requests(): MockSlackRequest[];
}

export async function startMockSlackServer(config: MockSlackConfig = {}): Promise<MockSlackHandle> {
  let hits = 0;
  const log: MockSlackRequest[] = [];
  const {
    body = "ok",
    status = 200,
    delay = 0,
    transientKind = "500",
    failuresBeforeSuccess = 0,
  } = config;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits++;
    let bodyChunks = "";
    req.on("data", (chunk: Buffer) => {
      bodyChunks += chunk.toString();
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
      }
      log.push({ method: req.method ?? "", headers, body: bodyChunks });

      const respond = () => {
        const isTransient = hits <= failuresBeforeSuccess;
        if (isTransient && transientKind === "timeout") return; // hang indefinitely
        if (isTransient && transientKind === "500") {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("service unavailable");
          return;
        }
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(body);
      };

      if (delay > 0) setTimeout(respond, delay);
      else respond();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    hitCount: () => hits,
    requests: () => [...log],
  };
}
