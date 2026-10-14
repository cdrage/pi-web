# Local development workflow

Pi Web combines Git review, workspace terminals, and Podman Desktop previews.
The `pd-kubernetes-testing` service controls Kubernetes, builds, and desktop sessions.
The [preview package README](../../packages/pi-pd-preview/README.md) describes connection setup, gateway configuration, and CLI commands.

## Local launch

From the Pi Web repository, run this command:

```sh
npm run dev
```

Open <http://127.0.0.1:30141>.

If Pi Web already runs on port `30141`, reuse that process.
Do not run `next build` with the development server. The build can disrupt the development cache.

## Review and terminal

1. Open a changed file in **Diff** mode.
2. Select a line number.
3. For a range, Shift-click another line in the same hunk.
4. Add the review comment.
5. Select **Add to chat**.
6. Edit the chat draft and submit it through the normal chat controls.

Review comments persist per worktree in the browser.
An outdated comment retains its captured code so that its original target stays clear.
Export adds comments to the existing draft without submission.

The terminal occupies a resizable dock below the chat with separate tabs.
Its dark, light, and Zenburn palettes stay separate from the interface theme.
The [terminal guide](../terminal.md) describes connection behavior and shortcuts.

## Preview behavior

Each worktree and branch keeps one preview per service address. Chats in that worktree share it.
A PR URL selects its head repository and branch, even for a fork.
An explicit repository and branch also work. The current source support covers public GitHub repositories.

New previews enable auto-update with a 30-second interval. Build options expose this switch.
The runtime follows the pushed branch. It does not receive uncommitted files or local commits automatically.

The desktop appears inside a resizable pane at the far right. An open Git diff stays beside it.
Details and control descriptions expand above the desktop. Narrow windows use an overlay for the preview.
Local HTTP Pi Web relays VNC through an isolated loopback port with server-side OIDC credentials.
Other Pi Web addresses embed the VNC URL directly. Browser authentication and frame policies control that connection.

| Control | Effect |
| --- | --- |
| Start | Creates or reattaches the worktree's preview |
| Open Desktop | Opens the VNC link in another browser tab |
| Reconnect | Reconnects the embedded desktop without a rebuild |
| Sync | Fetches and rebuilds the pushed source in the same desktop |
| Reset | Deletes the desktop and its container storage, then creates a clean replacement |
| Logs | Shows the latest build and runtime output |
| Keep alive | Extends the preview expiry |
| Stop | Deletes the desktop and its container storage |

Sync preserves state. Reset supplies the clean slate from the original request.
Status polls and Sync do not extend expiry. Panel or chat closure does not delete the remote desktop.

The panel distinguishes local HEAD, the pushed commit, and the applied commit.
An available VNC connection does not establish that the latest application build is ready.
Failed updates remain marked as failed even when an older applied commit exists.

## Change and test cycle

1. Edit the project in its worktree.
2. Commit the changes.
3. Push the commit to the preview's source branch.
4. Wait for auto-update, or select **Sync**.
5. Make sure that the applied commit matches the expected pushed commit.
6. Select **Open Desktop**.
7. Test the application.
8. If a clean environment is necessary, select **Reset**.

## Automated checks

Run these commands from the repository:

```sh
npm test
npm run lint
node_modules/.bin/tsc --noEmit
```

The [browser test guide](../../e2e/README.md) lists the review, terminal, theme, and preview suites.
Preview browser tests use mock APIs. Live cluster validation requires the connected service and a pushed source branch.
