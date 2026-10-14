import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { desktopUrl } = await createJiti(import.meta.url).import("./preview-desktop-url.ts");

test("desktop resize preserves the viewer path and connection parameters", () => {
  const url = new URL(desktopUrl("https://desktop.test/vnc.html?path=desktop%2Fwebsockify&resize=scale#session"));

  assert.equal(url.pathname, "/vnc.html");
  assert.equal(url.searchParams.get("path"), "desktop/websockify");
  assert.equal(url.searchParams.get("resize"), "remote");
  assert.equal(url.searchParams.get("autoconnect"), "1");
  assert.equal(url.hash, "#session");
});
