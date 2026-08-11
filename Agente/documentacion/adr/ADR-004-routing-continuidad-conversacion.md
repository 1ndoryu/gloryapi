# ADR-004 — Continuidad de conversación en el routing multi-proveedor

Estado: aceptado para GloryAPI local
Fecha: 2026-08-10

## Problema

Durante una sesión de Codex Desktop (ChatGPT) mediada por el bridge GloryAPI en `:4100` →
runtime `:3101`, la ejecución se interrumpió repetidamente con:

```text
429 All candidate models are temporarily unavailable (request_timeout)
```

del 2026-08-10T23:56:35Z al 23:57:21Z (46 s, 6 intentos): andoryyu devolvió 503
(`provider_unavailable`), opencode-zen 429 (`rate_limited`, 11 fallos consecutivos) y
opencode-go `request_timeout` en los intentos 1/3/5.

El mismo modelo/proveedor (deepseek-v4-flash) funcionaba en VS Code vía otro bridge
(freellmapi `:3001`) sin fallar, y el usuario observó que freellmapi también expone 3
endpoints y no falla. Objeciones recibidas:

- “freellmapi también 3 endpoints distintos y no falla” → la diferencia no son los endpoints.
- “cuando se usaba freellmapi en chatgpt tenía el mismo fallo” → el perfil de la petición
  importa más que el proveedor.
- “¿se arregla haciendo que el modelo no salte tanto? cuando opencode-go funciona, que se
  quede ≥5 min antes de volver al primer modelo gratis” → pegajosidad (sticky) de proveedor.
- “opencode-zen tiene límite de 4M tokens diarios; sus reintentos deberían ser cada 4 h si
  falla seguido” → cooldown escalado por cuota.
- “andoryyu: no sé el límite exacto; el punto es optimizar todo lo posible para que no se
  interrumpa la conversación” → política moderada.

## Investigación y causa raíz

1. **Timeout efectivo 15 s (bug)**: los adapters declaran `timeoutMs: 120_000`, pero el
   snapshot de settings computaba `timeoutMs = override ?? DEFAULT_PROVIDER_TIMEOUT_MS (15 s)`.
   Sin overrides, el timeout real era 15 s. Un prompt de Codex con contexto enorme (78
   mensajes, con `system,user` duplicados de turnos previos) tarda >15 s en recibir el primer
   chunk del gateway; `fetchWithTimeout` abortaba el fetch antes de recibir headers y el abort
   se clasificaba como `request_timeout` (504 retryable) → reintento → vuelta a fallar un
   provider sano (opencode-go con cooldown 0) → agotaba el presupuesto → 429.
2. **Sticky ignorado para modelo explícito**: Codex Desktop pide siempre
   `model: "deepseek-v4-flash"`, que resuelve a una cadena de fallback
   (andoryyu → opencode-zen → opencode-go). `resolveProxyModelSelection` solo consultaba el
   sticky de sesión cuando el cliente NO pedía modelo; con modelo explícito devolvía
   `preferredModel: undefined` y **cada request volvía a empezar por andoryyu** → el modelo
   “saltaba” de proveedor en cada turno y martillaba los pools gratuitos. El sticky ya existía
   (`stickySessionMap` en memoria, sesión por hash del primer mensaje de usuario) pero no
   aplicaba a cadenas explícitas.
3. **opencode-zen**: límite de ~4M tokens/día. Tras agotar cuota, devuelve 429. Con cooldown
   de 5 min se le seguía martillando un pool seco. El usuario pidió cooldown de 4 h cuando
   falla seguido.
4. **andoryyu**: worker con pool de cuentas (`freebuff2api/worker.js`) que rota cuentas y
   aplica su propio cooldown por token; cuota por sesión diaria sin oracle fiable para
   deepseek-v4-flash. Sus fallos son sobre todo 503 transitorios → conviene cadencia moderada
   (5 min) y no escalado, porque el worker ya rota internamente.
5. **Presupuesto de routing 120 s**: con timeout efectivo de 120 s por intento, el deadline de
   120 s no dejaba margen para un reintento dentro del mismo request.
6. **Por qué VS Code/freellmapi no falla igual**: freellmapi también tiene 3 endpoints
   (opencode-zen, opencode-go y otros con `timeoutMs: 120000`) pero su perfil de requests
   (prompts más cortos, sin supervisor en paralelo) no agota los 15 s; y su router no aplica
   el mismo timeout efectivo corto. La diferencia NO son los endpoints: es el **timeout
   efectivo corto** + el **contexto/paralelismo** del cliente + el **reinicio de la ruta** en
   cada request.

## Decisión

Ajustes de código (commit `a70f2de` previo + este bloque):

1. **Timeout efectivo del upstream a 120 s**:
   - `ProviderDefinition.timeoutMs?: number` (shared/types.ts).
   - `ACTIVE_PROVIDER_DEFINITIONS` declara `timeoutMs: 120_000` para andoryyu, opencode-zen y
     opencode-go.
   - `getProviderSettingsSnapshot` usa `override ?? provider.timeoutMs ?? 15 s`.
   - Con 120 s, un prompt enorme recibe headers y el stream avanza; el 15 s solo queda como
     último fallback para proveedores sin timeout declarado.
2. **Sticky de proveedor para cadenas explícitas** (`proxy-selection.ts`): si la sesión ya
   tuvo éxito con un modelo de la cadena, ese modelo se intenta primero
   (`preferredModel`) aunque el cliente pida `model` explícito. La cadena sigue cubriendo
   el fallback. Con `routing.stickyRotationMs = 5 min`, opencode-go (pago) se mantiene ≥5 min
   antes de volver a intentar el primer gratuito; si el gratuito vuelve a servir, el sticky lo
   adopta, y si no, go lo cubre. Esto además reduce la presión sobre los pools gratuitos con
   cuota diaria.
3. **Cooldown escalado por clase de fallo** (`proxy-routing.ts` + `proxy.ts`): la política de
   proveedor admite `rateLimitCooldownMs`, aplicado cuando la clasificación es
   `rate_limited` (429):
   - opencode-zen: `rateLimitCooldownMs = 4 h` (cuota de 4M tokens/día agotada).
   - andoryyu: sin escalado (`cooldownMs = 5 min`), 503 transitorios, worker rota cuentas.
   - opencode-go: `cooldownMs = 0` (último recurso de pago, reintento inmediato en el mismo
     request).
4. **Presupuesto de routing a 4 min** (`routing.maxDurationMs = 240_000`): cabe un intento de
   120 s + reintento dentro del mismo request.

Política final:

| Provider | Timeout upstream | Cooldown transitorio | Cooldown 429 | Penalty dinámico | Health provider | Rol |
| --- | --- | --- | --- | --- | --- | --- |
| andoryyu | 120 s | 5 min | 5 min (sin escalar) | no | sí | primer gratuito, pool de cuentas |
| opencode-zen | 120 s | 5 min | **4 h** | no | sí | gratuito con cuota diaria 4M |
| opencode-go | 120 s | 0 | 0 | no | no | último recurso de pago, sticky preferido |

Configuración efectiva: `routing.maxAttempts=6`, `routing.maxDurationMs=240 s`,
`routing.stickyTtlMs=30 min` (conversación inactiva), `routing.stickyRotationMs=5 min`
(mínimo de permanencia antes de rotar al primer gratuito).

## Consecuencias

- Un prompt grande ya no aborta a los 15 s: el primer chunk tarda lo que tarde hasta 120 s.
- En una conversación con éxito previo, el proveedor que respondió bien se mantiene ≥5 min;
  los gratuitos se vuelven a probar después de ese margen sin interrumpir (falla → go cubre).
- opencode-zen agotado no se martillea durante 4 h; el fallo cae a opencode-go.
- El 15 s de `DEFAULT_PROVIDER_TIMEOUT_MS` queda solo como fallback de providers sin
  timeout declarado.
- El test `settings.test.ts` se ajustó al nuevo timeout efectivo (120 s).
- Cambios solo de código en `shared/`, `server/src/providers`, `server/src/settings`,
  `server/src/routes` + tests (267/267 verdes).

## No decidido aquí

- **Idle timeout de streams pos-headers**: el stream, una vez recibidos los headers, no tiene
  timeout propio; un upstream que se quede mudo colgaría hasta el abort del bridge (180 s).
  Se documenta como mejora futura (idle timer por chunk) si la evidencia lo pide.
- **Límite de concurrencia por proveedor**: el supervisor lanza requests en paralelo; no hay
  cola/limitador por proveedor. Con el sticky y el timeout corregido el modo de fallo principal
  queda cubierto; un limitador global sería el siguiente nivel.
- **Mensajes `system,user` duplicados** en el contexto del supervisor: se detectaron en el
  request fallido; no se tocaron porque alterar el contexto es de mayor riesgo. Queda como
  observación.
- **Límite exacto de andoryyu**: desconocido (cuenta por sesión diaria, sin oracle para
  flash); la política moderada de 5 min y el sticky evitan martillarlo.

## Validación

- `npm run build -w server`: OK.
- `npm test -w server`: 267/267 (46 archivos), incluidos `proxy-selection.test.ts` (7 nuevos:
  sticky en cadenas explícitas, sticky fuera de cadena ignorado, sin assistant no aplica,
  política de cooldowns).
- Gate: `npm run task:check -- <task>` (Sentinel 0.7.1, `project.primaryBranch=gloryapi`).
- Pendiente de validación funcional manual: una sesión larga de Codex Desktop contra el
  runtime reiniciado (timeout 120 s + sticky 5 min + zen 4 h).