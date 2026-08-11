const SAFE_PARENT_ENV = Object.freeze([
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USERNAME',
  'LANG',
  'LC_ALL',
]);

function createSafeChildEnv(parentEnv = process.env, overrides = {}) {
  const safe = {};
  for (const name of SAFE_PARENT_ENV) {
    if (typeof parentEnv[name] === 'string' && parentEnv[name] !== '') safe[name] = parentEnv[name];
  }
  return { ...safe, ...overrides };
}

module.exports = { SAFE_PARENT_ENV, createSafeChildEnv };
