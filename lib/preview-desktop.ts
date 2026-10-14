import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createPreviewService } from "../packages/pi-pd-preview/service";
import { readConfig } from "../packages/pi-pd-preview/storage";
import { oidcIdentity } from "../packages/pi-pd-preview/oidc";
import { OIDC_HEADER } from "../packages/pi-pd-preview/oidc-config";
import { PreviewError } from "../packages/pi-pd-preview/model";
import { openDesktopRelay } from "./preview-desktop-relay";
import { desktopUrl } from "./preview-desktop-url";
import { serializeByKey } from "./key-serializer";

declare global {
  var __piDesktopRelays: Map<string, Awaited<ReturnType<typeof openDesktopRelay>>> | undefined;
}

const relays = globalThis.__piDesktopRelays ??= new Map();
const RELAY_LOCK = Symbol.for("pi-web.desktop-relay");

export async function previewDesktop(cwd: string, parentOrigin: string) {
  const agentDir = getAgentDir();
  const snapshot = await createPreviewService({ agentDir }).status(cwd);
  const session = snapshot.session;
  if (!session?.vncReady || !session.vncUrl || snapshot.expired) {
    throw new PreviewError("The desktop is not ready yet.");
  }
  const parent = new URL(parentOrigin);
  if (parent.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parent.hostname)) {
    return { url: desktopUrl(session.vncUrl) };
  }
  const config = await readConfig(agentDir);
  const key = JSON.stringify([config.apiUrl, config.oidc, session.id, parentOrigin]);
  return serializeByKey(RELAY_LOCK, key, async () => {
    let relay = relays.get(key);
    if (!relay) {
      relay = await openDesktopRelay({
        target: session.vncUrl!, parentOrigin, expiresAt: Date.parse(session.expiresAt),
        identity: async (): Promise<Record<string, string>> => config.oidc
          ? { [OIDC_HEADER]: await oidcIdentity(agentDir, config) } : {},
        onClose: () => relays.delete(key),
      });
      relays.set(key, relay);
    }
    relay.touch(Date.parse(session.expiresAt));
    // Cached relays survive code reloads, so apply the current viewer settings.
    return { url: desktopUrl(relay.url) };
  });
}
