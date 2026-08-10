# Prevención: no activar Codex si GloryAPI no tiene runtime completo

## Caso reproducible

El bridge puede tener el código y el perfil preparados, pero `start-bridge.ps1`
requiere dos recursos de runtime: el helper compilado
`server/dist/scripts/bridge-auth.js` para resolver el token local DPAPI y una
fuente segura para autenticar sidecar → GloryAPI. Puede ser `GLORY_API_KEY` o
`FREEL_API_KEY` en el entorno, o `server/dist/scripts/bridge-upstream-auth.js`
leyendo `unified_api_key` de la bóveda SQLite local en modo `readonly`.

## Detección esperada

El preflight de solo lectura
`integrations/codex-bridge/mode/codex-activation-preflight.ps1 -Json -SkipHealth`
debe marcar `bridge-auth-helper` y `gloryapi-upstream-credential` como `pass`.
Los valores nunca se imprimen ni se guardan en TOML, logs o documentación.

## Estado observado el 2026-08-10

- El helper compilado existe.
- `GLORY_API_KEY` y `FREEL_API_KEY` no están presentes en el entorno del proceso,
  pero `unified_api_key` sí está disponible en la bóveda local nueva.
- El helper `bridge-upstream-auth.js` resolvió la credencial sin imprimirla y el
  runtime/bridge pasaron health y readiness durante la prueba aislada y durante
  el cutover local.
- El runtime ya no hereda secretos del proceso que invoca el bridge: la prueba
  `integrations/codex-bridge/test/environment-isolation.test.cjs` capturó su
  entorno real y confirmó ausencia de `BRIDGE_CLIENT_TOKEN`, `GLORY_API_KEY` y
  `FREEL_API_KEY`. El bridge se crea después con entorno explícito.
- `unified_api_key` ya fue migrada a `local_auth_tokens` con DPAPI `CurrentUser`;
  `settings` ya no conserva el plaintext. `server/data` queda además protegida
  con ACL sin herencia para Owner, SYSTEM y Administrators como defensa en
  profundidad.
- FreeLLMAPI no se usó como fuente de bearer en runtime; solo se leyó su snapshot
  cifrado durante la migración controlada 22/22.

## Acción correcta

Conservar el helper local y volver a ejecutar el preflight después de cualquier
rotación. Solo con los cuatro enlaces apuntando a GloryAPI se puede realizar el
canary temporal y el E2E de ChatGPT.
No se modifica `freellmapi`, no se copia una clave al workspace y no se ejecuta
ningún script desde un enlace legacy.
