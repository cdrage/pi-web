import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as hooks from "../hooks/__fixtures__/react-hook-shim.mjs";
import { readFontWeight } from "../lib/font-preferences.ts";
import { TERMINAL_XTERM_THEMES } from "../lib/terminal-theme.ts";
import { createTerminalWriter, terminalRequest } from "../lib/terminal-client.ts";

const panelScript = new Script(ts.transpileModule(
  await readFile(new URL("./TerminalPanel.tsx", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX } },
).outputText);

function mountPanel() {
  const calls = { terminals: [], streams: [], requests: [] };
  const container = { offsetWidth: 800, offsetHeight: 300 };
  let theme = "light";
  let refIndex = 0;
  const modules = {
    react: { ...hooks, useRef: (value) => {
      const ref = hooks.useRef(value);
      if (refIndex++ === 0) { ref.current = container; }
      return ref;
    } },
    "react/jsx-runtime": jsx,
    "@/hooks/useI18n": { useI18n: () => ({ t: (key) => key }) },
    "@/hooks/useChatAppearance": { useChatAppearance: () => ({ fontSize: 14 }), terminalFontSize: (size) => size - 1 },
    "@/hooks/useTerminalTheme": { useTerminalTheme: () => theme },
    "@/hooks/useFontPreferences": { subscribeFontPreferences: () => () => {} },
    "@/lib/font-preferences": { readFontWeight },
    "@/lib/page-debug": { pageId: () => "terminal-test-page", trackEventSource: (_kind, source) => source },
    "@/lib/terminal-theme": { TERMINAL_XTERM_THEMES },
    "@/lib/terminal-extra-keys": { NO_TERMINAL_MODIFIERS: { ctrl: false, alt: false } },
    "./TerminalExtraKeys": { useTerminalExtraKeysVisible: () => false },
    "@/lib/terminal-client": {
      terminalRequest: async (url, options) => { calls.requests.push({ url, options }); },
      createTerminalWriter: () => ({ resize() {}, stop: async () => {} }),
    },
    "@xterm/addon-fit": { FitAddon: class { fit() {} } },
    "@xterm/xterm": { Terminal: class {
      constructor(options) {
        this.options = options;
        this.cols = 80;
        this.rows = 24;
        this.output = "";
        this.disposed = false;
        calls.terminals.push(this);
      }
      loadAddon() {}
      open() {}
      attachCustomKeyEventHandler() {}
      onData() { return { dispose() {} }; }
      onResize() { return { dispose() {} }; }
      focus() {}
      write(value) { this.output += value; }
      dispose() { this.disposed = true; }
    } },
  };
  const compiledModule = { exports: {} };
  const context = createContext({
    module: compiledModule, exports: compiledModule.exports,
    require: (name) => {
      assert.ok(modules[name], `Unexpected terminal dependency: ${name}`);
      return modules[name];
    },
    window: { addEventListener() {}, removeEventListener() {} },
    navigator: { onLine: true },
    URLSearchParams,
    document: { fonts: { load: async () => [] } },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class { observe() {} disconnect() {} },
    EventSource: class {
      constructor() { this.closed = false; calls.streams.push(this); }
      close() { this.closed = true; }
    },
  });
  panelScript.runInContext(context);
  const view = hooks.renderHook(() => {
    refIndex = 0;
    return compiledModule.exports.TerminalPanel({
      tab: { id: "theme-test", cwd: "/project" }, active: false,
      onClosed() {}, onCloseError() {},
    });
  });
  return {
    calls, view,
    setTheme(nextTheme) { theme = nextTheme; view.rerender(); },
  };
}

test("a terminal opens with its selected light palette", async () => {
  const panel = mountPanel();
  try {
    await setImmediate();
    assert.equal(panel.calls.terminals[0].options.theme.background, "#fbfbfc");
    assert.equal(panel.calls.terminals[0].options.theme.foreground, "#24292f");
  } finally {
    panel.view.unmount();
  }
});

test("a ready terminal uses its content space without a path header", async () => {
  const panel = mountPanel();
  try {
    await setImmediate();
    panel.calls.streams[0].onopen();
    panel.view.flush();
    const markup = renderToStaticMarkup(panel.view.result);

    assert.doesNotMatch(markup, /<header[\s>]/, "A healthy terminal must not reserve a header row");
    assert.equal(markup.includes("/project"), false, "The tab tooltip supplies the cwd");
    assert.match(markup, /data-terminal-status="ready"/);
    assert.match(markup, /class="terminal-xterm-host"/);
    assert.equal(panel.calls.terminals.length, 1);
    assert.equal(panel.calls.terminals[0].disposed, false);
  } finally {
    panel.view.unmount();
  }
});

test("a palette change keeps the terminal, output buffer, PTY and SSE stream", async () => {
  const panel = mountPanel();
  try {
    await setImmediate();
    const terminal = panel.calls.terminals[0];
    const stream = panel.calls.streams[0];
    stream.onmessage({ data: JSON.stringify({ type: "output", data: "keep this output", offset: 16 }) });
    panel.setTheme("zenburn");
    await setImmediate();
    assert.equal(terminal.options.theme.background, "#3f3f3f");
    assert.equal(terminal.options.theme.foreground, "#dcdccc");
    assert.equal(terminal.output, "keep this output");
    assert.equal(terminal.disposed, false);
    assert.equal(stream.closed, false);
    assert.equal(panel.calls.terminals.length, 1);
    assert.equal(panel.calls.streams.length, 1);
    assert.equal(panel.calls.requests.length, 1);
  } finally {
    panel.view.unmount();
  }
});

test("terminal errors preserve server diagnostics and explain non-JSON responses", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const body of [null, "<html>Server error</html>", "null"]) {
    fetch.mock.mockImplementation(async () => new Response(body, { status: 500 }));
    await assert.rejects(terminalRequest("/api/terminal"), /HTTP 500.*pi-web server log/);
  }
  fetch.mock.mockImplementation(async () => Response.json({ error: "Native module missing; run npm rebuild node-pty" }, { status: 500 }));
  await assert.rejects(terminalRequest("/api/terminal"), /Native module missing; run npm rebuild node-pty/);
});

test("a delayed input request cannot be overtaken by typing or resize", async (t) => {
  const received = [];
  let finishFirst;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    if (received.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("a");
  writer.resize(100, 30);
  writer.write("b\r");
  await setImmediate();
  assert.equal(received.length, 1);
  finishFirst();
  await setImmediate();
  assert.deepEqual(received, [
    { type: "input", data: "a" },
    { type: "resize", cols: 100, rows: 30 },
    { type: "input", data: "b\r" },
  ]);
  await writer.stop();
});

test("large Unicode pastes preserve characters while bounding input requests", async (t) => {
  const chunks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    chunks.push(JSON.parse(options.body).data);
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  const text = "a".repeat(32767) + "\u{1f600}".repeat(40000);
  writer.write(text);
  await setImmediate();
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 65536 && chunk.isWellFormed()));
  await writer.stop();
});

test("typing during a slow request is batched into the next ordered write", async (t) => {
  const received = [];
  let release;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body).data);
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
    return Response.json({ success: true });
  });
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("first");
  await setImmediate();
  for (const character of "a long command\r") writer.write(character);
  assert.deepEqual(received, ["first"]);
  release();
  await setImmediate();
  assert.deepEqual(received, ["first", "a long command\r"]);
  await writer.stop();
});

test("failed or stopped delivery discards queued input without retrying commands", async (t) => {
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "gone" }, { status: 404 }));
  const writer = createTerminalWriter("id", (error) => errors.push(error.message));
  writer.write("first");
  writer.write("second");
  await setImmediate();
  assert.deepEqual(errors, ["gone"]);
  assert.equal(fetch.mock.callCount(), 1);
  await writer.stop();
  writer.write("third");
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 1);
});
