import { getAgentDir, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createPreviewService } from "../packages/pi-pd-preview/service";
import { createPreviewExtension } from "../packages/pi-pd-preview/extension";
import { PREVIEW_ACTIONS } from "../packages/pi-pd-preview/model";
import { isReadOnlySelection } from "./mcp-read-only-policy";
import { readSessionToolSelection } from "./session-tool-selection";
import type { SessionEntry } from "./types";

export function previewService() {
  return createPreviewService({ agentDir: getAgentDir() });
}

function canMutate(ctx: ExtensionContext): boolean {
  return !isReadOnlySelection(readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]));
}

export function previewExtension(agentDir: string): InlineExtension {
  return {
    name: "pd-preview",
    replaceable: true,
    factory: createPreviewExtension({
      agentDir,
      canMutate,
    }),
  };
}

export function previewPolicy(): InlineExtension {
  const mutations = new Set(PREVIEW_ACTIONS.map((action) => `pd_preview_${action}`));
  return {
    name: "pi-web-preview-policy",
    hidden: true,
    factory: (pi) => {
      // Keep the tool policy when an installed CLI package replaces the default extension.
      pi.on("tool_call", (event, ctx) => {
        if (!mutations.has(event.toolName) || canMutate(ctx)) {
          return undefined;
        }
        return { block: true, reason: "This session uses read-only tools. Select tools that permit changes before a preview action." };
      });
    },
  };
}
