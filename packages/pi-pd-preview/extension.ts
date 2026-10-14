import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPreviewService } from "./service";
import { parseOptions } from "./github";
import { configView } from "./storage";
import { finishOidcLogin, signOutOidc, startOidcLogin } from "./oidc-login";
import { PREVIEW_ACTIONS, type PreviewAction, type PreviewOptions, type PreviewSnapshot } from "./model";

const STATUS_KEY = "command:/preview status";
const POLL_MS = 30_000;
const HELP = "Use /preview [start|status|sync|logs|reset|touch|stop|login|logout]. Login opens an OIDC sign-in link and accepts a callback URL. Start accepts a PR URL, repo branch, or JSON options. Reset and stop delete the remote desktop and its container storage.";
const optionSchema = Type.Object({
  source: Type.Optional(Type.String({ description: "Public GitHub repository, tree URL, or pull request URL" })),
  branch: Type.Optional(Type.String()),
  kind: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("extension")])),
  mode: Type.Optional(Type.Union([Type.Literal("dev"), Type.Literal("compiled")])),
  autoUpdate: Type.Optional(Type.Boolean()),
  includeK8s: Type.Optional(Type.Boolean()),
  rootful: Type.Optional(Type.Boolean()),
  extensionBuild: Type.Optional(Type.Union([Type.Literal("pnpm"), Type.Literal("container")])),
  extensionDir: Type.Optional(Type.String()),
  containerfile: Type.Optional(Type.String()),
  desktopRepo: Type.Optional(Type.String()),
  desktopBranch: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function previewText(snapshot: PreviewSnapshot): string {
  if (!snapshot.configured) {
    return "Configure Previews in Pi Web Settings, or set PD_API_URL and PD_API_TOKEN.";
  }
  const { session, binding, context } = snapshot;
  if (!binding) {
    return "No preview for this worktree and branch. Use /preview start.";
  }
  const lines = [
    `Preview: ${snapshot.expired ? "expired" : session?.phase ?? "start incomplete"}`,
    `Source: ${binding.spec.repo} (${binding.spec.branch})`,
    `Local: ${context?.head || "unknown"}${context?.dirty ? " (uncommitted changes)" : ""}`,
    `Pushed: ${snapshot.pushedCommit ?? "unknown"}`,
    `Applied: ${session?.runtime?.appliedCommit || "none"}`,
    `Commit status: ${snapshot.freshness}`,
  ];
  if (session) {
    lines.push(`Expires: ${session.expiresAt}`);
    if (session.vncReady && session.vncUrl) {
      lines.push(`[Open Desktop](<${session.vncUrl}>)`);
    }
    if (session.runtime?.lastError) {
      lines.push(`Error: ${session.runtime.lastError}`);
    }
  }
  if (snapshot.freshness === "push-required" || context?.dirty) {
    lines.push("Push committed changes to the source branch before Sync. Local files never upload automatically.");
  }
  return lines.join("\n\n");
}

export function createPreviewExtension(options: {
  agentDir?: string;
  service?: ReturnType<typeof createPreviewService>;
  canMutate?: (ctx: ExtensionContext) => boolean;
} = {}) {
  return async (pi: ExtensionAPI) => {
    const agentDir = options.agentDir ?? getAgentDir();
    const service = options.service ?? createPreviewService({ agentDir });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;

    function clearTimer() {
      clearTimeout(timer);
      timer = undefined;
    }

    function publish(ctx: ExtensionContext, snapshot: PreviewSnapshot) {
      const session = snapshot.session;
      ctx.ui.setStatus(STATUS_KEY, snapshot.binding
        ? `Preview: ${snapshot.expired ? "expired" : session?.phase ?? "start incomplete"} · ${session?.runtime?.appliedCommit.slice(0, 8) || "no build"}`
        : undefined);
    }

    async function refresh(ctx: ExtensionContext, epoch: number): Promise<void> {
      try {
        const snapshot = await service.status(ctx.cwd);
        if (epoch !== generation) {
          return;
        }
        publish(ctx, snapshot);
        if (ctx.hasUI && snapshot.binding && !snapshot.expired) {
          timer = setTimeout(() => void refresh(ctx, epoch), POLL_MS);
          timer.unref?.();
        }
      } catch {
        if (epoch === generation) {
          ctx.ui.setStatus(STATUS_KEY, "Preview: status unavailable");
        }
      }
    }

    function restart(ctx: ExtensionContext) {
      clearTimer();
      generation += 1;
      void refresh(ctx, generation);
    }

    function assertWritable(ctx: ExtensionContext) {
      if (options.canMutate && !options.canMutate(ctx)) {
        throw new Error("This session uses read-only tools. Select tools that permit changes before a preview action.");
      }
    }

    pi.on("session_start", (_event, ctx) => restart(ctx));
    pi.on("session_tree", (_event, ctx) => restart(ctx));
    pi.on("agent_end", (_event, ctx) => restart(ctx));
    pi.on("session_shutdown", () => {
      generation += 1;
      clearTimer();
    });

    pi.registerCommand("preview", {
      description: "Start or inspect a Podman Desktop preview",
      getArgumentCompletions: (prefix) => ["start", "status", "sync", "logs", "reset", "touch", "stop", "login", "logout", "help"]
        .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const [command = "start", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (command === "help") {
          ctx.ui.notify(HELP, "info");
          return;
        }
        try {
          if (command === "logout") {
            await signOutOidc(agentDir);
            ctx.ui.notify("Signed out of preview OIDC. Your browser session stays active.", "info");
            return;
          }
          if (command === "login") {
            const flow = await startOidcLogin(agentDir);
            if (rest.length) {
              const result = await finishOidcLogin(agentDir, flow.id, rest.join(" "));
              ctx.ui.notify(result.phase === "done" ? "Signed in to preview OIDC." : result.error ?? "OIDC sign-in failed.", result.phase === "done" ? "info" : "error");
              return;
            }
            pi.sendMessage({ customType: "pd-preview", content: `[Sign in to previews](<${flow.authorizationUrl}>)\n\nAfter browser sign-in, return to Pi. If the callback cannot connect, run /preview login followed by the complete callback address.`, display: true });
            return;
          }
          if (command === "logs") {
            const lines = await service.logs(ctx.cwd);
            pi.sendMessage({ customType: "pd-preview", content: `Preview logs:\n\n${lines.join("\n")}`, display: true, details: { lines } });
            return;
          }
          let snapshot: PreviewSnapshot;
          if (command === "status") {
            snapshot = await service.status(ctx.cwd, true);
          } else {
            if (!PREVIEW_ACTIONS.includes(command as PreviewAction)) {
              throw new Error(HELP);
            }
            assertWritable(ctx);
            if ((command === "reset" || command === "stop") && ctx.hasUI
              && !await ctx.ui.confirm("Delete preview storage?", "This action deletes the remote desktop and its container storage.")) {
              return;
            }
            const text = rest.join(" ");
            const input = text.startsWith("{") ? parseOptions(JSON.parse(text))
              : text ? { source: rest[0], ...(rest[1] ? { branch: rest[1] } : {}) } : {};
            if (command !== "start" && text) {
              throw new Error("Only Start accepts source options.");
            }
            snapshot = await service.action(ctx.cwd, command as PreviewAction, input);
          }
          publish(ctx, snapshot);
          pi.sendMessage({ customType: "pd-preview", content: previewText(snapshot), display: true, details: snapshot });
          restart(ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Preview request failed.", "error");
        }
      },
    });

    // Keep an unconfigured integration out of the model's default tool list.
    const configured = await configView(agentDir).then((config) => config.configured).catch(() => false);
    const definitions = [
      ["status", "Read the preview phase, source, pushed SHA, applied SHA, and expiry."],
      ["logs", "Read the last 500 preview log lines."],
      ["start", "Create or reattach the preview for this worktree and branch. Public GitHub sources only. Auto-update defaults to true."],
      ["sync", "Fetch, build, and restart the pushed source in the same desktop. Preserve its container storage. Local files never upload."],
      ["reset", "Delete the remote desktop and container storage. Create a clean preview with the same source and options."],
      ["touch", "Extend the preview expiry. Status polls and Sync do not extend it."],
      ["stop", "Delete the remote desktop and its container storage."],
    ] as const;
    for (const [action, description] of definitions) {
      const readOnly = action === "status" || action === "logs";
      pi.registerTool({
        name: `pd_preview_${action}`,
        label: `Preview ${action}`,
        description,
        parameters: action === "start" ? optionSchema : Type.Object({}, { additionalProperties: false }),
        defaultActive: configured,
        annotations: { readOnlyHint: readOnly, destructiveHint: action === "reset" || action === "stop", openWorldHint: true },
        async execute(_id, params, _signal, _onUpdate, ctx) {
          if (!readOnly) {
            assertWritable(ctx);
          }
          const result = action === "logs" ? { lines: await service.logs(ctx.cwd) }
            : action === "status" ? await service.status(ctx.cwd, true)
              : await service.action(ctx.cwd, action, params as PreviewOptions);
          if ("configured" in result) {
            publish(ctx, result);
          }
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
  };
}
