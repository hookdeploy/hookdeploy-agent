# HookDeploy Agent

**A menu bar / system tray companion for [`hookdeployed`](https://github.com/hookdeploy/hookdeployed)** —
the same secure, outbound-only webhook agent, with a real interface: connect with one click, browse
your endpoints, and tap live traffic to your machine without touching a terminal.

Available for **Windows** and **macOS**.

---

## What it does

HookDeploy Agent runs quietly in your menu bar (macOS) or system tray (Windows) and keeps a single
outbound, mutually-authenticated connection to HookDeploy open — the same connection
[`hookdeployed`](https://github.com/hookdeploy/hookdeployed) uses on its own. No inbound ports, no
firewall changes, nothing to expose.

On top of that connection, the app gives you:

- **One-click connect/disconnect**, with the current relay and organization always visible.
- **A live view of your endpoints and destinations** — see at a glance which ones already forward
  to this machine.
- **Tap** — mirror a real endpoint's traffic to a local port temporarily, without touching
  production. The app detects ports already listening on your machine and lets you pick one instead
  of guessing.
- **Automatic updates**, checked on launch and periodically in the background, with a clear prompt
  before anything installs.
- **Launch at login**, on by default, toggleable in Settings.

Everything you can do here, the CLI can also do from a terminal — this app is an interface on top of
the same agent, not a separate product with separate behavior.

## Install

Download the latest installer for your platform from
**[Releases](https://github.com/hookdeploy/hookdeploy-agent/releases/latest)**:

- **Windows** — `HookDeploy-Agent_x64.exe` (or `.msi`). Signed; standard Windows install.
- **macOS** — `HookDeploy-Agent_universal.dmg`. Signed and notarized — open the DMG and drag the app
  to Applications, no security workarounds needed.

The first time you open it, a window will appear explaining where to find the app afterward — on
macOS specifically, it lives only in the menu bar (no Dock icon, matching how most menu-bar
utilities behave) so this window won't show itself again once you know where to look.

### Sign in

Click **Login** in the app. This opens your browser to authorize the agent — the same
device-authorization flow the CLI uses — and asks you to choose whether this machine is:

- **Production** — receives real traffic, gets retried on failure, and you're notified if it goes
  offline.
- **Development** — for a laptop that comes and goes. Failed deliveries aren't retried; that's
  expected, and you can always replay them from the dashboard.

You can change this later from your organization's agent settings.

## Using it

**Menu bar / tray menu** — status, your organization, a shortcut to open the app, connect/disconnect,
and quit. Quitting always shuts down cleanly: any active taps are stopped and confirmed on the
server first, then the connection closes.

**Main window** — browse every endpoint and destination in your organization. Anything already
forwarding to this machine is marked. Pick a destination and hit **Tap** to mirror its traffic
locally: choose a port (the app lists what's already running so you don't have to guess), a path,
and how long the tap should last — up to 8 hours, and it ends automatically the moment this agent
disconnects.

**Settings** — rename this agent, toggle launch-at-login, check for updates, and see whether it's
currently a Production or Development agent — the same distinction you made at sign-in, with a
short reminder of what each means so it's never ambiguous which one you're pointing traffic at.

## Security

- **No inbound ports.** Same as the CLI — this app never listens for anything except your own local
  processes on loopback.
- **Every action funnels through a small, explicit set of commands** between the interface and the
  agent — the window content has no ability to spawn processes, read files, or reach the network on
  its own.
- **Credentials never touch the interface layer.** Certificates and renewal tokens live only where
  the CLI already keeps them; nothing sensitive is ever logged, displayed, or cached in the app's
  local storage.
- **Signed and notarized on both platforms.** Windows builds are signed; macOS builds are signed and
  notarized by Apple, so Gatekeeper opens them without warnings.
- **Fully open to inspection**, same as the CLI it wraps — this entire app, including how it talks
  to the agent process, is in this repository.

Found a security issue? Please report it to **security@hookdeploy.dev** rather than opening a public
issue.

## Building from source

Requires [Rust](https://rustup.rs), [Node.js](https://nodejs.org), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/hookdeploy/hookdeploy-agent.git
cd hookdeploy-agent
npm install
npm run tauri dev     # local development
npm run tauri build   # produces a signed-if-configured installer for your platform
```

The app bundles a compiled copy of `hookdeployed` as its sidecar process — building from source
requires a `hookdeployed` binary for your platform placed in `src-tauri/binaries/`. See
[`hookdeployed`](https://github.com/hookdeploy/hookdeployed) for build instructions.

## License

`hookdeploy-agent` is source-available under the same
[Business Source License 1.1](https://github.com/hookdeploy/hookdeployed/blob/main/LICENSE) as
`hookdeployed`. In short: read it, build it, self-host it, use it for anything — including your own
business — for free. The one thing it restricts is offering this code, or a modified version, to
third parties as a competing hosted webhook service. It converts to Apache 2.0 automatically after
four years from each version's release.

Questions about licensing: **support@hookdeploy.dev**

## Support

- Docs: [docs.hookdeploy.dev](https://docs.hookdeploy.dev)
- Dashboard: [app.hookdeploy.dev](https://app.hookdeploy.dev)
- Email: support@hookdeploy.dev
