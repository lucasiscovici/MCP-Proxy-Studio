import http from "node:http";
import httpProxy from "http-proxy";
import { PassThrough } from "node:stream";
import type { ListenerConfig } from "../config.js";
import { parseTraceparent, ensureTraceContext, nextSpan, makeTraceparent } from "../telemetry/traceparent.js";
import type { TelemetryClient } from "../telemetry/client.js";

export type ProxyKind = "mcp_sse" | "mcp_http" | "openapi";

type CaptureBuffer = {
  requestBody?: string;
  responseBody?: string;
};

export type MakeProxyServerParams = {
  kind: ProxyKind;
  listener: ListenerConfig;
  telemetry: TelemetryClient;
  proxyId: string;
};

export function makeProxyServer(params: MakeProxyServerParams) {
  const { kind, listener, telemetry, proxyId } = params;
  const listenHost = listener.target_host ?? "0.0.0.0";
  const listenPort = listener.target_port;
  const targetBase = `http://${listener.host}:${listener.port}`;

  const proxy = httpProxy.createProxyServer({
    target: targetBase,
    changeOrigin: false, // keep client Host to avoid origin mismatches
    xfwd: true,
    ws: true
  });

  proxy.on("error", (_err, _req, res) => {
    try {
      if (res && "writeHead" in res) {
        (res as http.ServerResponse).writeHead(502, { "content-type": "application/json" });
        (res as http.ServerResponse).end(JSON.stringify({ error: "Bad Gateway" }));
      }
    } catch {}
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    // guard against headers already sent (can happen on retries/abort)
    if ((proxyReq as any).headersSent) return;
    // Preserve client Host (especially for SSE origin checks)
    if (req.headers.host) {
      proxyReq.setHeader("host", req.headers.host);
    }
    const incoming = parseTraceparent(req.headers["traceparent"] as string | undefined);
    const ctx = ensureTraceContext(incoming);
    const { spanId } = nextSpan(ctx.traceId);
    proxyReq.setHeader("traceparent", makeTraceparent(ctx.traceId, spanId, true));
  });

  proxy.on("proxyRes", (proxyRes, req, res) => {
    if (kind === "openapi") {
      console.log("[proxy]", proxyId, "RES", req.method, req.url, "status", proxyRes.statusCode);
    }
    if (kind === "mcp_sse" && res) {
      const meta = res as any;
      const respChunks: Buffer[] = meta.__respChunks || [];
      const capture: CaptureBuffer = meta.__capture || {};
      const clientHost = req.headers.host;
      const status = proxyRes.statusCode || 200;
      meta.__status = status;

      const ct = (proxyRes.headers["content-type"] || "").toString().toLowerCase();
      console.log("[proxy]", proxyId, "SSE upstream status", proxyRes.statusCode, "content-type", ct);

      const finish = (ok: boolean) => {
        if (!capture.responseBody && respChunks.length) {
          capture.responseBody = Buffer.concat(respChunks).toString("utf-8");
        }
        if (meta.__finalize) meta.__finalize(ok, status);
        console.log("[proxy]", proxyId, "SSE finalize body length", capture.responseBody?.length || 0);
      };

      const transform = new PassThrough({
        transform(chunk, _enc, cb) {
          let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (clientHost) {
            try {
              const txt = buf.toString("utf-8");
              const replaced = txt.replace(/http:\/\/(?:0\.0\.0\.0|localhost):\d+/g, `http://${clientHost}`);
              if (replaced !== txt) buf = Buffer.from(replaced, "utf-8");
            } catch {}
          }
          respChunks.push(Buffer.from(buf));
          capture.responseBody = Buffer.concat(respChunks).toString("utf-8");
          cb(null, buf);
        }
      });

      transform.on("finish", () => finish(true));
      proxyRes.on("error", () => {
        finish(false);
        console.log("[proxy]", proxyId, "SSE error, recorded", respChunks.length, "chunks");
      });
      proxyRes.on("close", () => finish(true));

      (res as http.ServerResponse).writeHead(status, proxyRes.headers);
      proxyRes.pipe(transform).pipe(res);
    }
  });

  const server = http.createServer((req, res) => {
    const start = Date.now();
    const capture: CaptureBuffer = {};
    const tee = new PassThrough();

    // capture + tee request body without consuming it
    const reqChunks: Buffer[] = [];
    req.on("data", (chunk) => {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        reqChunks.push(buf);
        tee.write(buf);
      } catch {
      }
    });
    req.on("end", () => {
      tee.end();
      capture.requestBody = Buffer.concat(reqChunks).toString("utf-8");
    });

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const upstreamPath = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;

    const upstreamUrl = new URL(targetBase);
    upstreamUrl.pathname = upstreamPath;
    upstreamUrl.search = url.search;
    const inboundUrl = `http://${listenHost}:${listenPort}${req.url ?? ""}`;
    console.log("[proxy]", proxyId, "IN ", req.method, inboundUrl, "(Host:", req.headers.host, ")");
    console.log("[proxy]", proxyId, "OUT", upstreamUrl.toString());

    const incoming = parseTraceparent(req.headers["traceparent"] as string | undefined);
    const ctx = ensureTraceContext(incoming);
    const { traceId, spanId } = nextSpan(ctx.traceId);

    const protocol = kind === "openapi" ? "openapi" : "mcp";
    const transport = kind === "mcp_sse" ? "sse" : kind === "mcp_http" ? "http" : "openapi";

    const spanName =
      protocol === "mcp" ? `mcp.${transport}/${listener.name || "default"}` : `openapi/${listener.name || "default"}`;

    let recorded = false;
    let responseBody = "";
    const respChunks: Buffer[] = [];
    (res as any).__respChunks = respChunks;
    (res as any).__capture = capture;
    (res as any).__clientRes = res;
    (res as any).__finalize = (ok: boolean, statusCode?: number, errorMsg?: string) => record(ok, statusCode, errorMsg);
    const originalWrite = res.write;
    const originalEnd = res.end;

    // tap response (best effort; SSE will only capture initial data)
    (res as any).write = function (chunk: any, ...args: any[]) {
      if (chunk) {
        try {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          respChunks.push(buf);
        } catch {}
      }
      return originalWrite.apply(res, [chunk, ...args]);
    };

    (res as any).end = function (chunk: any, ...args: any[]) {
      if (chunk) {
        try {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          respChunks.push(buf);
        } catch {}
      }
      responseBody = Buffer.concat(respChunks).toString("utf-8");
      capture.responseBody = responseBody;
      return originalEnd.apply(res, [chunk, ...args]);
    };
    const record = (ok: boolean, statusCode?: number, errorMsg?: string) => {
      if (recorded) return;
      recorded = true;

      const end = Date.now();
      telemetry.record({
        traceId,
        spanId,
        parentSpanId: ctx.parentSpanId,
        name: spanName,
        kind: "SERVER",
        startTimeMs: start,
        endTimeMs: end,
        status: ok ? "OK" : "ERROR",
        attributes: {
          "mcp.proxy_id": proxyId,
          "mcp.server_name": listener.name,
          "mcp.route_name": "",
          "mcp.transport": transport,
          "mcp.protocol": protocol,
          "http.request.method": req.method ?? "",
          "url.path": url.pathname,
          "url.query": url.search ? url.search.slice(1) : "",
          "upstream.url": upstreamUrl.toString(),
          "http.response.status_code": statusCode ?? 0,
          "http.request.body": capture.requestBody ?? "",
          "http.response.body": capture.responseBody ?? responseBody ?? ""
        },
        error: ok ? undefined : { message: errorMsg ?? "proxy_error" }
      });
    };

    res.on("finish", () => record((res.statusCode ?? 0) < 500, res.statusCode));
    res.on("close", () => {
      if (!capture.responseBody && (res as any).__respChunks?.length) {
        capture.responseBody = Buffer.concat((res as any).__respChunks).toString("utf-8");
      }
      if (!recorded) record(false, res.statusCode, "client_connection_closed");
    });

    // http-proxy streams by default (SSE/long-poll friendly)
    // ensure req.url carries the rewritten path/query for forwarding
    req.url = upstreamPath + (url.search || "");
    proxy.web(req, res, { target: targetBase, ws: true, buffer: tee, selfHandleResponse: kind === "mcp_sse" });
  });

  server.listen(listenPort, listenHost, () => {
    console.log(
      `[proxy:${proxyId}] listening on ${listenHost}:${listenPort} -> upstream ${targetBase} (kind=${kind})`
    );
  });

  // WebSocket upgrades (passthrough)
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const upstreamPath = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;
      const upstreamUrl = new URL(targetBase);
      upstreamUrl.pathname = upstreamPath;
      upstreamUrl.search = url.search;
      req.url = upstreamPath + (url.search || "");
      console.log("[proxy]", proxyId, "WS IN ", req.url);
      console.log("[proxy]", proxyId, "WS OUT", upstreamUrl.toString());
      proxy.ws(req, socket, head, { target: targetBase });
    } catch {
      socket.destroy();
    }
  });

  return {
    kind,
    host: listener.host,
    port: listener.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}
