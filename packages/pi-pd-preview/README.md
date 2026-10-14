# Podman Desktop previews for Pi

This extension connects Pi to the `pd-kubernetes-testing` API.
Pi Web includes the same extension and a resizable preview pane at the far right.
The Go service controls Kubernetes, builds, and desktop sessions.

## Connect Pi Web

1. Open **Settings > Previews**.
2. Enter the service API address and API token.
3. If the gateway uses OIDC, enable **Use OIDC authentication**.
4. Enter the OIDC issuer and public client ID.
5. Select **Save**.
6. Select **Sign in with OIDC**, then **Open sign-in page**.
7. Complete the provider login.
8. If the callback cannot connect, paste its complete address into **OIDC callback address**.
9. Select **Test saved connection**.
10. Run `/reload` in an existing chat to activate the tools.
11. Select the desktop icon in the chat toolbar.
12. Select **Start**.

Direct API connections use the API token alone. They do not require the OIDC steps.

## Connect the Pi CLI

Run this command from the Pi Web source directory:

```sh
pi install ./packages/pi-pd-preview
```

Set the connection for the Pi process:

```sh
export PD_API_URL=http://127.0.0.1:8080
export PD_API_TOKEN='<API_TOKEN from the test service>'
pi
```

Alternatively, configure the connection through Pi Web first.

For a CLI-only OIDC setup, add the connection to `pd-preview.json` in the Pi agent directory:

```json
{
  "apiUrl": "https://pd-testing.k8s.land",
  "oidc": {
    "issuer": "https://auth.k8s.land/dex",
    "clientId": "pi-pd-preview"
  }
}
```

Set `PD_API_TOKEN`, then run `/preview login` in Pi.
Open the sign-in link and complete the provider login.
If the callback cannot connect, run `/preview login <complete callback address>`.

## OIDC gateway setup

The Pi backend uses its own OIDC session. Browser cookies stay in the browser.
Pi uses Authorization Code with PKCE, state, nonce, and ID token signature validation.
It refreshes expired tokens automatically when the provider supplies a refresh token.

Add this public client to the existing Dex `staticClients` list:

```yaml
- id: pi-pd-preview
  name: Pi desktop previews
  public: true
```

Keep the existing clients. Restart Dex after the configuration update.
Dex public clients without `redirectURIs` accept localhost callbacks with a dynamic port.
See [Dex public clients](https://dexidp.io/docs/configuration/custom-scopes-claims-clients/#public-clients).

From the Pi Web repository, update the existing gateway policy:

```sh
kubectl -n pd-testing patch securitypolicy private-oidc --type=merge \
  --patch-file docs/local-workflow/preview-oidc-gateway.patch.yaml
```

The [patch](../../docs/local-workflow/preview-oidc-gateway.patch.yaml) adds `X-Pi-OIDC-Token` as an ID token source.
It enables `passThroughAuthHeader` and permits the browser and Pi client audiences.
It sets explicit Dex endpoints so that gateway reconciliation does not require discovery after a Dex restart.
The gateway validates the JWT before its existing user authorization rules permit access.
Browser requests still use their Dex cookies. The service still requires its separate Bearer API token.
See [Envoy Gateway OIDC](https://gateway.envoyproxy.io/docs/api/extension_types/#oidc).

Use these Pi settings after the cluster update:

| Setting | Value |
| --- | --- |
| API address | `https://pd-testing.k8s.land` |
| API token | The existing service `API_TOKEN` |
| OIDC issuer | `https://auth.k8s.land/dex` |
| OIDC client ID | `pi-pd-preview` |

This connection uses the public gateway without a port forward.

## Connection behavior

Pi and Pi Web share `pd-preview.json` and `pd-preview-state.json` in the Pi agent directory.
The default directory is `~/.pi/agent`. `PI_CODING_AGENT_DIR` overrides it.
The files use mode `0600`. Environment variables override the saved connection.
The API token stays on the server and never returns through a settings response.

OIDC credentials stay in `pd-preview-auth.json` with mode `0600`.
Settings responses expose session presence, with no ID token or refresh token.
Sign out clears Pi credentials and cancels its pending sign-in. The browser's Dex session stays active.
Pi and Pi Web share the saved identity. A changed API address, issuer, or client ID requires a new sign-in.
The desktop link uses browser authentication.

For direct local access, disable OIDC and run this command in another terminal:

```sh
kubectl -n pd-testing port-forward service/pd-kubernetes-testing 8080:8080
```

## Commands

| Command | Result |
| --- | --- |
| `/preview` | Creates or reattaches the preview for the current worktree and branch |
| `/preview start owner/repo branch` | Uses an explicit GitHub source |
| `/preview start https://github.com/owner/repo/pull/123` | Uses the PR head repository and branch |
| `/preview status` | Reports phase, commits, expiry, and desktop link |
| `/preview sync` | Fetches the pushed branch and rebuilds in the same desktop |
| `/preview logs` | Reads the last 500 log lines |
| `/preview touch` | Extends the remote expiry |
| `/preview reset` | Deletes the desktop and its container storage, then creates a clean replacement |
| `/preview stop` | Deletes the desktop and its container storage |
| `/preview help` | Shows command usage |
| `/preview login` | Starts OIDC sign-in in the browser |
| `/preview login <callback address>` | Completes sign-in from a remote browser |
| `/preview logout` | Clears Pi's OIDC session |

For an extension preview, run this command:

```text
/preview start {"kind":"extension","source":"owner/extension","branch":"main"}
```

For a container build, run this command:

```text
/preview start {"kind":"extension","source":"owner/extension","branch":"main","extensionBuild":"container","containerfile":"Containerfile"}
```

For another host desktop source, add `desktopRepo` and `desktopBranch` to the JSON options.

## Update behavior

New previews enable auto-update with a 30-second interval.
The web panel exposes this choice under **Build options**.
Sync preserves the desktop and its container storage. Reset creates a clean desktop.
Status polls and Sync do not extend the expiry. Keep alive and `/preview touch` extend it.
The remote desktop persists after you close a chat, the panel, or Pi.

Pi Web displays live VNC inside the pane. An open Git diff stays to its left.
Details and control descriptions expand above VNC. Reconnect restores the connection without a rebuild.
Local HTTP Pi Web uses an isolated loopback relay. OIDC credentials stay on the server.
Other Pi Web addresses embed the VNC URL directly and require browser access to that URL.

Only pushed commits reach the preview. Uncommitted files and local commits never upload automatically.
The status compares local HEAD, the public GitHub branch, and the runtime's applied commit.
GitHub branch reads use a 60-second cache. Refresh and explicit actions request a fresh read.
Failed builds stay marked as failed, even when an earlier applied commit remains recorded.
Ready means that the application window appeared. It does not establish functional correctness or extension activation.

Each worktree and local branch keeps one preview per service address.
Sessions in that worktree share it. Other branches and worktrees keep separate previews.
A detached HEAD requires an explicit repository and branch.
PR URLs resolve to the fork head. Private GitHub repositories are unsupported by the service.

## Agent tools

The extension registers `pd_preview_status`, `pd_preview_logs`, `pd_preview_start`, `pd_preview_sync`,
`pd_preview_reset`, `pd_preview_touch`, and `pd_preview_stop`.
The tools activate by default when the connection exists at extension load time.
Pi Web blocks mutations under a read-only tool selection.
Interactive Reset and Stop commands request confirmation before deletion.
Agent tools describe their destructive effects and follow the session's tool permissions.

## Scope

Open Desktop uses a separate browser tab.
Screenshots, local file uploads, and private repository credentials are outside this version.
