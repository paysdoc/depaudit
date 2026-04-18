import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockConfig {
  /** Canned JSON body to return on success (default: empty array) */
  body?: unknown;
  /** HTTP status for success responses (default: 200) */
  status?: number;
  /** Delay in ms before responding (default: 0) */
  delay?: number;
  /** How many requests to fail transiently before succeeding (default: 0 = always succeed) */
  failuresBeforeSuccess?: number;
  /** What kind of transient failure to simulate (default: "500") */
  transientKind?: "500" | "429" | "timeout" | "401";
}

export interface MockHandle {
  url: string;
  stop: () => Promise<void>;
  hitCount: () => number;
}

export async function startMockSocketServer(config: MockConfig = {}): Promise<MockHandle> {
  let hits = 0;
  const {
    body = [],
    status = 200,
    delay = 0,
    failuresBeforeSuccess = 0,
    transientKind = "500",
  } = config;

  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    hits++;

    const respond = () => {
      const isTransient = hits <= failuresBeforeSuccess;

      if (isTransient) {
        if (transientKind === "timeout") {
          // Hang indefinitely — never respond (caller's AbortController will trigger)
          return;
        }
        if (transientKind === "429") {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
          res.end(JSON.stringify({ message: "rate limited" }));
          return;
        }
        if (transientKind === "401") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        // Default transient: 500
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "service unavailable" }));
        return;
      }

      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (delay > 0) {
      setTimeout(respond, delay);
    } else {
      respond();
    }
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
        // Force-close any hanging connections (e.g. timeout scenarios)
        server.closeAllConnections?.();
      }),
    hitCount: () => hits,
  };
}
