# Modelo de amenazas local: GloryAPI y bridge

## Activos y fronteras

- Tokens locales cliente→bridge, bridge→GloryAPI y DPAPI de la bóveda.
- Credenciales de proveedores, fingerprints, configuración, estado de reasoning/tools y logs.
- Prompts, argumentos de tools, resultados web, imágenes y configuración activa de Codex.
- Fronteras: aplicación local → sidecar loopback → Control/Data API → proveedor; web y
  visión son entradas no confiables y no deben convertirse en instrucciones del sistema.

## Actores y amenazas

1. Otro proceso con el mismo usuario intenta llamar al loopback, robar un token o repetir una tool.
2. Un proceso de usuario distinto intenta leer la bóveda, caches, logs o bundle.
3. Un proveedor o resultado web devuelve credenciales, prompt injection, redirects o payload enorme.
4. DNS cambia una visión/web URL a loopback, metadata o rango privado después del primer chequeo.
5. Un fallo de proceso, retry o crash entre journal y publicación repite una escritura o pierde config.
6. Un modelo devuelve reasoning-only, tool-only, SSE truncado o downgrade silencioso y el cliente
   lo interpreta como éxito.

## Controles implementados

- Loopback por defecto, auth constante, separación de tokens, `/health` mínimo y Control API autenticada.
- DPAPI `CurrentUser`, ACL de perfil y bundles AES-256-GCM/Argon2id; no se registran valores secretos.
- Límites de body, SSE, imágenes, respuesta, tools, concurrencia, cache, logs y estado JSON.
- Redacción estructurada de headers/body/tool args/SSE; logs metadata-only salvo opt-in explícito.
- Endpoint HTTPS sin credenciales, redirects rechazados, validación de todas las respuestas DNS
  y transporte de visión fijado al conjunto de direcciones ya validado para evitar una segunda
  resolución unconstrained entre validación y conexión.
- Parser SSE fail-closed, terminal boundary único, abort por cliente/idle/total y `response.failed` ante truncado.
- Respuestas tool-only no se cierran con `end_turn=true`; reasoning sintético se filtra y las cachés tienen TTL.
- Journal/hash/lock del cambio de modo, stop con ownership, runtime separado y canary con cleanup.
- Capabilities `unsupported|unverified` cuando no existe evidencia; probes live no promocionan routing.

## Riesgos residuales aceptados

- DPAPI/ACL no impiden a otro proceso con los mismos privilegios leer memoria o interceptar el token mientras
  el proceso lo usa. La mitigación es mínimo privilegio, token por instalación, rotación, contenido mínimo y
  bridge apagado fuera del canary.
- La visión ya evita la segunda resolución mediante `http(s).request` con `lookup` fijado y SNI
  conservado. El riesgo residual queda en cualquier integración web futura que use `fetch` sin
  ese transporte; por eso no se permite URL arbitraria de usuario y los redirects siguen bloqueados.
- E2E real de Desktop, proveedor real por modelo, soak 24 h y rollback aplicado no se declaran PASS mientras
  ChatGPT normal sea la configuración activa.

## Pruebas de regresión

`endpoint-security.test.cjs`, `redaction.test.cjs`, `atomic-state.test.cjs`, `responses-schema.test.cjs`,
`responses-sse.test.cjs`, `stream-http-contract.test.cjs`, `vision-body-timeout.test.cjs`,
`environment-isolation.test.cjs`, `stop-ownership.test.cjs`, `readiness-contract.test.cjs` y el canary
determinista deben seguir ejecutándose con el bridge apagado al terminar la suite.
