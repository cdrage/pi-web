import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";

const { openDesktopRelay } = await createJiti(import.meta.url).import("./preview-desktop-relay.ts");
const HTTP_OK = 200;
const HTTP_REDIRECT = 302;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UPGRADE = 101;
const PARENT = "http://127.0.0.1:30141";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async function fixture(t) {
  const received = [];
  const upstream = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    if (req.url === "/login") {
      res.writeHead(HTTP_REDIRECT, { location: "https://auth.example.test/?secret=private" }).end();
      return;
    }
    res.writeHead(HTTP_OK, {
      "content-type": "text/html", "set-cookie": "upstream-secret=private",
      "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    }).end("desktop");
  });
  upstream.on("upgrade", (req, socket) => {
    received.push({ url: req.url, headers: req.headers });
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 ${HTTP_UPGRADE} Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (data) => socket.write(data));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const relay = await openDesktopRelay({
    target: `http://127.0.0.1:${upstream.address().port}`, parentOrigin: PARENT,
    expiresAt: Date.now() + 60_000, identity: async () => ({ "X-Pi-OIDC-Token": "server-only-identity" }),
  });
  t.after(() => relay.close());
  const connected = await fetch(relay.url, { redirect: "manual" });
  assert.equal(connected.status, HTTP_REDIRECT);
  const cookie = connected.headers.get("set-cookie").split(";")[0];
  const origin = new URL(relay.url).origin;
  return { relay, cookie, origin, received };
}

test("desktop relay selects remote resize for the embedded viewport", async (t) => {
  const { relay, cookie, origin, received } = await fixture(t);
  const connected = await fetch(relay.url, { redirect: "manual" });
  const location = new URL(connected.headers.get("location"), origin);

  assert.equal(location.searchParams.get("resize"), "remote");
  const response = await fetch(location, { headers: { cookie } });
  assert.equal(response.status, HTTP_OK);
  assert.equal(new URL(received[0].url, origin).searchParams.get("resize"), "remote");
});

test("desktop relay authenticates upstream and isolates browser credentials", async (t) => {
  const { origin, cookie, received } = await fixture(t);
  assert.equal((await fetch(origin)).status, HTTP_FORBIDDEN);
  assert.equal((await fetch(origin, { headers: { cookie: "wrong=secret" } })).status, HTTP_FORBIDDEN);
  assert.equal((await fetch(origin, { headers: { cookie, origin: "https://untrusted.test" } })).status, HTTP_FORBIDDEN);
  const response = await fetch(`${origin}/assets/ui.js?version=1`, { headers: {
    cookie: `${cookie}; pi-web-password=private`, authorization: "Bearer private", "X-Pi-OIDC-Token": "forged",
  } });
  assert.equal(response.status, HTTP_OK);
  assert.equal(await response.text(), "desktop");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("content-security-policy"), `default-src 'self'; frame-ancestors ${PARENT}`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(received[0].url, "/assets/ui.js?version=1");
  assert.equal(received[0].headers["x-pi-oidc-token"], "server-only-identity");
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(received[0].headers.authorization, undefined);
  const login = await fetch(`${origin}/login`, { headers: { cookie } });
  assert.equal(login.status, HTTP_BAD_GATEWAY);
  assert.ok(!(await login.text()).includes("private"));
  assert.equal(login.headers.get("location"), null);
});

test("desktop relay authenticates WebSocket upgrades and passes bytes", async (t) => {
  const { origin, cookie, received } = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = request(`${origin}/websockify`, { headers: {
      cookie, origin, connection: "Upgrade", upgrade: "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
    } });
    req.on("error", reject);
    req.on("response", () => reject(new Error("The desktop did not upgrade.")));
    req.on("upgrade", (response, socket) => {
      t.after(() => socket.destroy());
      assert.equal(response.statusCode, HTTP_UPGRADE);
      socket.once("data", (data) => {
        assert.equal(data.toString(), "desktop-bytes");
        socket.destroy();
        resolve();
      });
      socket.write("desktop-bytes");
    });
    req.end();
  });
  assert.equal(received[0].url, "/websockify");
  assert.equal(received[0].headers["x-pi-oidc-token"], "server-only-identity");
  assert.equal(received[0].headers.cookie, undefined);
});

test("desktop relay pins requests to its upstream host", async (t) => {
  const { origin, cookie, received } = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = request(origin, { path: "//untrusted.test//assets/ui.js", headers: { cookie } }, (response) => {
      assert.equal(response.statusCode, HTTP_OK);
      response.resume();
      response.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(received[0].url, "//assets/ui.js");
});

test("desktop relay refuses unauthenticated WebSocket connections", async (t) => {
  const { origin, received } = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = request(`${origin}/websockify`, { headers: {
      origin, connection: "Upgrade", upgrade: "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
    } });
    req.on("error", resolve);
    req.on("upgrade", () => reject(new Error("An unauthenticated connection reached VNC.")));
    req.end();
  });
  assert.deepEqual(received, []);
});

test("desktop relay closes at expiry and releases its cache entry", async () => {
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const relay = await openDesktopRelay({
    target: "http://127.0.0.1:1", parentOrigin: PARENT, expiresAt: Date.now() + 60_000,
    identity: async () => ({}), onClose: () => finish(),
  });
  relay.touch(Date.now());
  // The expiry timer is unref'ed. This bounded request keeps the test alive.
  const request = fetch(relay.url).catch(() => null);
  await closed;
  await request;
  await assert.rejects(fetch(relay.url));
});
