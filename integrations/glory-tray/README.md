# GloryAPI tray prototype

`GloryApiTray.ps1` is an isolated Windows tray control prototype. It polls only
`http://127.0.0.1:3101/api/control/status`, shows the last completed model, opens
the GloryAPI dashboard, and exposes a local window for enabling/disabling and
reordering fallback entries through authenticated `PUT /api/fallback`. Every
write carries the snapshot revision so a concurrent dashboard update is rejected
and refreshed instead of overwritten. It does not modify Codex profiles,
start/stop the bridge, or access FreeLLMAPI. Set `GLORYAPI_ADMIN_AUTH_TOKEN` to
the separate local control-plane token; do not use the data-plane unified key.
The script never prints or persists the token.

The transport, loopback guard, revisioned payload and conflict refresh live in
`GloryApiTray.Core.psm1`, so they can be exercised without opening a WinForms
window. The tray contract tests import that module directly against a loopback
HTTP fixture.

The final tray app still needs a Tauri/Electron decision, startup policy, and an
E2E Windows smoke test. Those remain separate from the real ChatGPT/Codex cutover.
