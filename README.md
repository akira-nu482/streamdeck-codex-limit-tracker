# Codex Limit Tracker

Stream Deck plugin prototype that displays Codex usage on a key by launching `codex app-server` locally and reading rate-limit data from there.

## What it does

- Starts a local Codex app-server client from the Stream Deck plugin runtime.
- Calls `initialize`, `account/read`, and `account/rateLimits/read`.
- Renders the remaining percentage and reset time as a dynamic SVG on the key.
- Falls back to parsing the JSON body embedded in the current `account/rateLimits/read` error when the installed Codex CLI cannot decode newer plan types such as `prolite`.

## Requirements

- Codex desktop installed and already logged in.
- Stream Deck 6.6+.
- Node.js 22+ for local development.

## Development

```powershell
npm.cmd install
npm.cmd run build
```

Useful Stream Deck CLI commands:

```powershell
npm.cmd run plugin:dev
npm.cmd run plugin:link
npm.cmd run plugin:restart
npm.cmd run plugin:validate
```

## Notes

- On Windows, the plugin copies `codex.exe` out of `WindowsApps` into a writable cache directory if spawning the installed binary is blocked by `EPERM`.
- The tile defaults to the `1week` window and toggles between `1week` and `5hours` each time you press the key.
