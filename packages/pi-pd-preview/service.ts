import { createHash, randomUUID } from "node:crypto";
import { createClient, HTTP_NOT_FOUND, type Fetcher } from "./client";
import { getContext } from "./git";
import { createGithub, makeSpec, parseOptions } from "./github";
import { editRegistry, readConfig, readRegistry, type PreviewConfig } from "./storage";
import { oidcIdentity } from "./oidc";
import {
  getFreshness, PREVIEW_HTTP, PreviewError,
  type PreviewBinding, type PreviewContext, type PreviewOptions, type PreviewSession, type PreviewSnapshot, type PreviewAction, type PreviewTarget,
} from "./model";

interface ServiceOptions {
  agentDir: string;
  fetcher?: Fetcher;
  context?: typeof getContext;
  github?: ReturnType<typeof createGithub>;
  env?: NodeJS.ProcessEnv;
}

function bindingKey(url: string, context: PreviewContext): string {
  return createHash("sha256").update(JSON.stringify([url, context.root, context.branch ?? `HEAD:${context.head}`])).digest("hex");
}

function isMissing(error: unknown): boolean {
  return error instanceof PreviewError && error.status === HTTP_NOT_FOUND;
}

export function createPreviewService(options: ServiceOptions) {
  const github = options.github ?? createGithub(options.fetcher);
  const contextFor = options.context ?? getContext;

  function clientFor(config: PreviewConfig) {
    return createClient(config, options.fetcher, () => oidcIdentity(options.agentDir, config, options.fetcher));
  }

  async function check() {
    return clientFor(await readConfig(options.agentDir, options.env)).check();
  }

  async function setup(cwd: string) {
    const [config, context] = await Promise.all([readConfig(options.agentDir, options.env), contextFor(cwd)]);
    return {
      config, context,
      key: context ? bindingKey(config.apiUrl, context) : "",
      client: clientFor(config),
    };
  }

  async function status(cwd: string, fresh = false): Promise<PreviewSnapshot> {
    const { config, context, key, client } = await setup(cwd);
    const configured = Boolean(config.apiUrl && config.token);
    const binding = configured && key ? (await readRegistry(options.agentDir)).entries[key] ?? null : null;
    let session: PreviewSession | null = null;
    let expired = false;
    const pushedPromise = binding ? github.pushed(binding.spec, fresh) : Promise.resolve(null);
    if (binding?.id) {
      try {
        session = await client.get(binding.id);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        expired = true;
      }
    }
    const pushedCommit = await pushedPromise;
    return {
      configured, context, binding, session, pushedCommit, expired,
      freshness: getFreshness(context, binding?.spec, session, pushedCommit),
    };
  }

  async function action(cwd: string, action: PreviewAction, raw: PreviewOptions = {}, target?: PreviewTarget): Promise<PreviewSnapshot> {
    const { config, context, key, client } = await setup(cwd);
    if (!context) {
      throw new PreviewError("Select a Git worktree before you start a preview.");
    }
    if (target && (target.root !== context.root || target.branch !== context.branch)) {
      throw new PreviewError("The worktree or branch changed. Refresh the preview before this action.", PREVIEW_HTTP.conflict);
    }
    if (!config.apiUrl || !config.token) {
      throw new PreviewError("Configure the preview API address and token in Settings > Previews, or set PD_API_URL and PD_API_TOKEN.");
    }
    const input = parseOptions(raw);
    // Hold a process-independent lock across mutations. CLI and Web share one binding.
    await editRegistry(options.agentDir, async (state, save) => {
      let binding: PreviewBinding | undefined = state.entries[key];
      if (action === "start") {
        const spec = binding && Object.keys(input).length === 0 ? binding.spec : await makeSpec(context, input, github);
        if (binding && JSON.stringify(binding.spec) !== JSON.stringify(spec)) {
          throw new PreviewError("This worktree and branch already use another preview configuration. Stop it before you change the source.", PREVIEW_HTTP.conflict);
        }
        if (binding?.id) {
          try {
            await client.get(binding.id);
            return;
          } catch (error) {
            if (!isMissing(error)) {
              throw error;
            }
            delete state.entries[key];
            binding = undefined;
          }
        }
        if (!binding) {
          binding = { spec, createKey: randomUUID() };
          state.entries[key] = binding;
          // Persist the key before POST so an ambiguous network failure can safely retry.
          await save();
        }
      } else if (!binding) {
        throw new PreviewError("This worktree and branch have no preview.", PREVIEW_HTTP.notFound);
      }

      if (action === "reset" && binding.id) {
        binding = { spec: binding.spec, createKey: randomUUID(), resetId: binding.id };
        state.entries[key] = binding;
        await save();
      }
      if (binding.resetId) {
        await client.remove(binding.resetId).catch((error) => {
          if (!isMissing(error)) {
            throw error;
          }
        });
        delete binding.resetId;
        await save();
      }
      if (action === "start" || action === "reset") {
        const session = await client.create(binding.spec, binding.createKey);
        binding.id = session.id;
        await save();
        return;
      }
      if (!binding.id) {
        throw new PreviewError("The preview start is incomplete. Retry Start before another action.", PREVIEW_HTTP.conflict);
      }
      if (action === "stop") {
        await client.remove(binding.id).catch((error) => {
          if (!isMissing(error)) {
            throw error;
          }
        });
        delete state.entries[key];
        await save();
        return;
      }
      if (action === "sync") {
        await client.sync(binding.id);
        return;
      }
      await client.touch(binding.id);
    });
    return status(cwd, true);
  }

  async function logs(cwd: string): Promise<string[]> {
    const { key, client } = await setup(cwd);
    const binding: PreviewBinding | undefined = (await readRegistry(options.agentDir)).entries[key];
    if (!binding?.id) {
      throw new PreviewError("This worktree and branch have no active preview.", PREVIEW_HTTP.notFound);
    }
    return client.logs(binding.id);
  }

  return { status, action, logs, check };
}
