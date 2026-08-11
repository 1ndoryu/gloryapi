const PROFILES = Object.freeze({
  // A plain OpenAI-compatible client: only tools advertised in the request
  // are forwarded and namespaced tools use the generic de-mangling path.
  generic: Object.freeze({
    name: 'generic',
    injectNodeRepl: false,
    injectAutomation: false,
    collaborationAliases: false,
    mcpFallback: false,
  }),
  // Codex Desktop currently defers some local tools until discovery. The
  // DeepSeek-compatible upstream cannot perform that discovery reliably, so
  // this profile supplies the app-specific compatibility shims.
  'codex-desktop': Object.freeze({
    name: 'codex-desktop',
    injectNodeRepl: true,
    injectAutomation: true,
    collaborationAliases: true,
    mcpFallback: true,
  }),
});

function resolveToolProfile(name) {
  if (name === undefined || name === null || name === '') return PROFILES['codex-desktop'];
  if (!PROFILES[name]) {
    throw new Error(`Unknown BRIDGE_TOOL_PROFILE: ${String(name)}`);
  }
  return PROFILES[name];
}

module.exports = { PROFILES, resolveToolProfile };
