import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { desktopUrl } from "./preview-desktop-url";

const HTTP_REDIRECT = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UPGRADE = 101;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_BYTES = 32;
const COOKIE_ID_BYTES = 8;
const COOKIE_PREFIX = "pi_preview_";
const CONNECT_PATH = "/connect/";
const RESPONSE_HEADERS = new Set(["content-type", "content-length", "content-encoding", "content-range", "accept-ranges", "etag", "last-modified", "cross-origin-embedder-policy", "cross-origin-opener-policy"]);

interface RelayOptions {
  target: string;
  parentOrigin: string;
  expiresAt: number;
  identity: () => Promise<Record<string, string>>;
  onClose?: () => void;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function openDesktopRelay(options: RelayOptions) {
  const target = new URL(options.target);
  const parent = new URL(options.parentOrigin);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password
    || parent.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(parent.hostname)) {
    throw new Error("The desktop relay requires a local HTTP Pi Web address.");
  }
  const secret = randomBytes(TOKEN_BYTES).toString("hex");
  const cookieName = `${COOKIE_PREFIX}${randomBytes(COOKIE_ID_BYTES).toString("hex")}`;
  const sockets = new Set<Socket>();
  const server = createServer();
  let origin = "";
  let timer: ReturnType<typeof setTimeout>;
  let closed = false;

  function close() {
    if (closed) { return; }
    closed = true;
    clearTimeout(timer);
    server.close();
    for (const socket of sockets) { socket.destroy(); }
    options.onClose?.();
  }

  function touch(expiresAt: number) {
    clearTimeout(timer);
    timer = setTimeout(close, Math.max(0, expiresAt - Date.now()));
    timer.unref();
  }

  function remoteUrl(path: string) {
    // Copy the path without URL resolution. A // prefix must never change hosts.
    const source = new URL(path, origin);
    const destination = new URL(target);
    destination.pathname = source.pathname;
    destination.search = source.search;
    return destination;
  }

  function allowed(headers: IncomingHttpHeaders): boolean {
    if (headers.host !== new URL(origin).host || headers.origin && headers.origin !== origin) {
      return false;
    }
    const cookie = headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
    return Boolean(cookie && equalSecret(cookie.slice(cookieName.length + 1), secret));
  }

  async function upstreamHeaders(headers: IncomingHttpHeaders, upgrade = false) {
    // Forward only desktop headers. Pi Web cookies and passwords never reach VNC.
    const result: Record<string, string> = { ...await options.identity(), origin: target.origin };
    for (const name of ["accept", "accept-encoding", "range", "user-agent", ...(upgrade ? ["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"] : [])]) {
      const value = headers[name];
      if (typeof value === "string") { result[name] = value; }
    }
    return result;
  }

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      if (request.headers.host !== new URL(origin).host || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(HTTP_FORBIDDEN).end();
        return;
      }
      if (url.pathname.startsWith(CONNECT_PATH) && equalSecret(url.pathname.slice(CONNECT_PATH.length), secret)) {
        // A cookie keeps absolute asset and WebSocket paths on this isolated origin.
        response.writeHead(HTTP_REDIRECT, {
          "Set-Cookie": `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict`,
          Location: `/${url.search}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        }).end();
        return;
      }
      if (!allowed(request.headers)) {
        response.writeHead(HTTP_FORBIDDEN).end();
        return;
      }
      const headers = await upstreamHeaders(request.headers);
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const remote = send(remoteUrl(request.url ?? "/"), { method: request.method, headers }, (incoming) => {
        const status = incoming.statusCode ?? HTTP_BAD_GATEWAY;
        if (status >= HTTP_REDIRECT && status < HTTP_BAD_REQUEST) {
          incoming.destroy();
          response.writeHead(HTTP_BAD_GATEWAY).end("Desktop authentication failed. Sign in to Previews and reconnect.");
          return;
        }
        const outgoing: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && RESPONSE_HEADERS.has(name)) { outgoing[name] = value; }
        }
        const policy = String(incoming.headers["content-security-policy"] ?? "").split(";")
          .filter((rule) => rule.trim() && !rule.trim().startsWith("frame-ancestors"));
        outgoing["content-security-policy"] = [...policy, `frame-ancestors ${parent.origin}`].join("; ");
        outgoing["referrer-policy"] = "no-referrer";
        outgoing["cache-control"] = "private, no-store";
        response.writeHead(status, outgoing);
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
        response.on("close", () => incoming.destroy());
      });
      remote.setTimeout(REQUEST_TIMEOUT_MS, () => remote.destroy());
      remote.on("error", () => {
        if (!response.headersSent) { response.writeHead(HTTP_BAD_GATEWAY); }
        response.end("The desktop connection failed. Reconnect or open the desktop in a tab.");
      });
      response.on("close", () => remote.destroy());
      remote.end();
    })().catch(() => {
      if (!response.headersSent) { response.writeHead(HTTP_BAD_GATEWAY); }
      response.end("Sign in to Previews and reconnect the desktop.");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      if (!allowed(request.headers)) { socket.destroy(); return; }
      const headers = await upstreamHeaders(request.headers, true);
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const remote = send(remoteUrl(request.url ?? "/"), { headers });
      remote.setTimeout(REQUEST_TIMEOUT_MS, () => remote.destroy());
      remote.on("upgrade", (incoming, upstream, remoteHead) => {
        upstream.setTimeout(0);
        const values = ["connection", "upgrade", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]
          .flatMap((name) => incoming.headers[name] ? [`${name}: ${incoming.headers[name]}`] : []);
        socket.write(`HTTP/1.1 ${HTTP_UPGRADE} Switching Protocols\r\n${values.join("\r\n")}\r\n\r\n`);
        if (head.length) { upstream.write(head); }
        if (remoteHead.length) { socket.write(remoteHead); }
        socket.pipe(upstream).pipe(socket);
        socket.on("close", () => upstream.destroy());
        socket.on("error", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
        upstream.on("error", () => socket.destroy());
      });
      remote.on("response", (response) => { response.destroy(); socket.destroy(); });
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      remote.end();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("Cannot open the desktop relay."); }
  origin = `http://${parent.hostname}:${address.port}`;
  touch(options.expiresAt);
  return { url: desktopUrl(`${origin}${CONNECT_PATH}${secret}`), close, touch };
}
