# Plan y ejecución: ahorro de tokens del Codex Bridge

Estado: completado localmente
Fecha: 2026-08-12
Alcance: `integrations/codex-bridge` y la telemetría local de GloryAPI

## Resultado deseado

Reducir al mínimo las solicitudes y los tokens consumidos por cada turno del
bridge, conservando la continuidad de herramientas, la recuperación de
respuestas vacías y la protección contra cierres prematuros.

El caso observado el 13 de agosto mostró cuatro filas para un solo mensaje:

- una solicitud principal a DeepSeek V4 Flash;
- una auditoría completa de Flash;
- una solicitud auxiliar a DeepSeek V4 Pro;
- una auditoría completa de Pro.

La solicitud auxiliar de Pro coincidió temporalmente con la generación del
título del hilo. El bridge no puede asumir que todo `gpt-5.6-luna` es una
selección explícita del usuario: el catálogo lo usa también como alias de
Desktop y por eso existe una colisión de responsabilidades.

## Hechos confirmados

1. `chat/completions` es sin estado: la solicitud principal debe reenviar el
   contexto necesario de la conversación.
2. `context-adapter.js` construye el nudge copiando todos los mensajes y
   agregando la respuesta y una directiva de confirmación.
3. `response-handlers.js` aplicaba el nudge a toda respuesta textual cuando
   había herramientas declaradas, aunque la respuesta ya fuera un cierre
   correcto.
4. La conversión actual siempre informa `cached_tokens: 0`, aunque el upstream
   pudiera entregar detalles de caché.
5. `gpt-5.6-luna` está declarado como `pickerId` de DeepSeek V4 Pro y aparece
   también en solicitudes auxiliares del Desktop.
6. El archivo `integrations/codex-bridge/test/_e2e_apply_patch.cjs` es un cambio
   ajeno y no forma parte de esta tarea.

## Decisiones

### 1. No se elimina la continuidad del contexto

La solicitud principal mantiene el historial que necesita el modelo. No se
reenviará historial completo a una auditoría de cierre.

### 2. No se usa una frase de intención como requisito

Las frases como “voy a revisar” son una señal secundaria. El protocolo
principal se basa en estructura: existencia de herramientas, llamadas de
herramienta, outputs pendientes y resultado de auditoría.

### 3. El nudge deja de ser universal

El modo recomendado será adaptativo:

- respuesta con llamada de herramienta: continúa sin auditoría adicional;
- respuesta textual después de herramientas del turno: pasa por la auditoría
  compacta porque puede ser un resumen correcto o una acción pendiente;
- respuesta textual sin herramientas ejecutadas pero con herramientas
  disponibles: se audita si el pedido tiene forma de acción; las confirmaciones
  simples como “listo?” no pagan una ronda auxiliar;
- respuesta vacía o solo de razonamiento: recuperación acotada;
- solicitud auxiliar: no se envía al proveedor si puede resolverse localmente.

### 4. La auditoría, cuando sea necesaria, es pequeña

La auditoría no recibe el system prompt, schemas ni historial completo. Recibe
solo:

- último pedido del usuario, limitado;
- respuesta candidata, limitada;
- estado estructural del turno;
- una instrucción fija para responder `complete` o `continue`.

La auditoría no tiene herramientas. Solo `continue` autoriza una continuación
con el contexto completo.

### 5. El título se resuelve localmente con detección fail-closed

El bridge añadirá una clasificación segura y observable de solicitudes
auxiliares. No se marcará como título una solicitud explícita del modelo solo
por su alias. Si la firma no es inequívoca, la solicitud seguirá al upstream,
pero no recibirá nudge y quedará registrada para ajustar el clasificador.

### 6. La telemetría separa consumo enviado de caché

Se conservarán los tokens de entrada enviados, pero se propagarán los campos de
caché que entregue el proveedor. Analytics distinguirá solicitud principal,
auditoría, continuación, recuperación y auxiliar.

## Arquitectura propuesta

```text
Responses request
        |
        v
request-classifier ---- auxiliary title? ---- local title response
        |
        v
translation + bounded context
        |
        v
one primary upstream request
        |
        +-- tool_calls ----------------------> client continues
        |
        +-- empty/reasoning-only ------------> bounded empty recovery
        |
        +-- ambiguous text ------------------> compact audit
                                                   |
                         complete <---------------+--------------> continue
                            |                                      |
                       finish original                    full-context continuation
```

## Fases ejecutables

### Fase A — contrato y observabilidad

- Añadir `requestKind`, `parentRequestId` y una firma estructural sin texto
  sensible.
- Propagar `cached_tokens` y `cache_write_tokens` cuando existan.
- Añadir pruebas de clasificación y de agrupación de llamadas.

### Fase B — auxiliares y títulos

- Implementar el clasificador de título mediante señales estructurales
  verificadas.
- Resolver títulos locales con longitud y sanitización limitadas.
- Evitar que `gpt-5.6-luna` auxiliar se convierta en DeepSeek V4 Pro.
- Conservar un fallback no destructivo si la firma no es inequívoca.

### Fase C — recuperación adaptativa

- Extraer la decisión de auditoría a una política reutilizable.
- Construir un cuerpo compacto sin tools para auditar.
- Mantener el cuerpo completo únicamente para una continuación real.
- Aplicar los mismos límites a streaming, non-streaming y web loop.

### Fase D — configuración y documentación

- Exponer `BRIDGE_AUDIT_MODE=adaptive|strict|off`, con `adaptive` por defecto,
  y conservar `BRIDGE_AUDIT_ENABLED=0` como compatibilidad.
- Documentar límites, variables y ejemplos de Analytics.
- Mantener valores seguros por defecto y límites máximos.

### Fase E — validación y cierre

- Suite unitaria y contractual del bridge.
- Streaming, non-streaming, herramientas cliente, web loop y respuestas vacías.
- Smoke con el catálogo aislado de Codex Desktop.
- `npm test`, `npm run build` y gate disponible.
- Actualizar roadmap y registrar evidencia en completados.

## Métrica de éxito

Para un turno normal sin herramientas pendientes:

- 1 solicitud principal;
- 0 solicitudes de título al proveedor;
- 0 auditorías completas;
- auditoría compacta solo si la respuesta resulta ambigua.

El caso de referencia debe bajar de aproximadamente 91.2K tokens de entrada
agregados a una cifra próxima a la solicitud principal. La auditoría compacta
está limitada a dos mensajes y no reenvía schemas; una continuación completa
solo aparece cuando la auditoría no confirma el cierre.

## SOLID y límites

- El clasificador no genera respuestas.
- El generador local de títulos no conoce proveedores.
- La política de cierre no conoce detalles de la UI.
- La traducción no decide facturación ni Analytics.
- El catálogo solo describe modelos; no decide si una solicitud es auxiliar.
- La lógica permanece en el bridge porque el contrato Responses→Chat
  Completions es específico de este adaptador y no tiene un segundo consumidor
  confirmado en el núcleo de GloryAPI.

## Seguridad y fallos

- Nunca se registran prompts, claves ni contenido completo para clasificar.
- La auditoría trata la respuesta candidata como datos delimitados.
- Las auditorías no reciben herramientas.
- Se conservan timeouts, límites de rondas y respuesta `failed` ante una
  recuperación inconclusa.
- Un clasificador incierto no debe eliminar una solicitud principal ni inventar
  un título de proveedor.

## Criterios de aceptación

- Elegir Flash no genera una solicitud a Pro.
- Un título no produce una fila facturable de modelo.
- Una respuesta normal usa una única llamada completa.
- La auditoría, si aparece, no reenvía el historial completo.
- Un turno con herramienta pendiente continúa y no se marca como completado.
- Un turno vacío conserva la recuperación existente y queda visible como error
  recuperable si se agota el presupuesto.
- Analytics explica el tipo y la relación de cada llamada.
- ChatGPT normal, su configuración y sus historiales quedan intactos.

## Evidencia y limitaciones

El diagnóstico inicial confirmó `tool-source-missing` en Sentinel, por lo que
no se declarará un PASS de gate mientras el runtime de Sentinel no tenga la
fuente externa disponible. La comprobación reproducible del 13-ago-2026 fue:

- `sentinel --version`: `0.7.4` en PATH; runtime fijado por el proyecto: `0.7.1`.
- `sentinel --help`: capacidades `analyze`, `check`, `guard`, `doctor`,
  `status`, `task` y `recover` presentes.
- `sentinel doctor --json --workspace .`: `ready=false`,
  `readyForAnalyze=false`, `readyForGate=false`; único issue:
  `tool-source-missing`, con `sourcePath` externo
  `C:\Users\Owner\OneDrive\Documentos\area-trabajo\glory-rs-rest\tools\sentinel`
  ausente. No se modificó ni se simuló ese runtime.
- `node --test integrations/codex-bridge/test/*.test.cjs`: **158/158 PASS**.
- `npm test` / `npm test -w server`: **50 archivos / 286 tests PASS**; el smoke externo que respondió
  401/modelo no soportado se omitió según el contrato del test.
- `npm run build`: **PASS** para shared, server y client.
- `git diff --check`: **PASS**.

## Estado de ejecución

- [x] Plan versionado con contexto y criterios.
- [x] Contrato de clasificación y telemetría.
- [x] Título local y aislamiento del alias auxiliar.
- [x] Auditoría compacta adaptativa.
- [x] Configuración y Analytics en español.
- [x] Suite dirigida, build y evidencia local.

## Handoff reproducible

Repositorio: `C:\Users\Owner\OneDrive\Documentos\area-trabajo\gloryapi`  
Rama: `gloryapi`  
Commit base revisado: `5d2d35d`  
Cambios propios dentro del repositorio:

- `Agente/planes/completados/plan-ahorro-tokens-bridge-2026-08-12.md`
- `Agente/completados/tareas-2026-08-13.md`
- `client/src/components/analytics/AnalyticsTypes.ts`
- `client/src/pages/AnalyticsPage.tsx`
- `integrations/codex-bridge/README.md`
- `integrations/codex-bridge/bridge/config.js`
- `integrations/codex-bridge/bridge/context-adapter.js`
- `integrations/codex-bridge/bridge/http-server.js`
- `integrations/codex-bridge/bridge/request-classifier.js`
- `integrations/codex-bridge/bridge/response-handlers.js`
- `integrations/codex-bridge/bridge/responses-adapter.js`
- `integrations/codex-bridge/bridge/server.js`
- `integrations/codex-bridge/bridge/title-responder.js`
- `integrations/codex-bridge/bridge/upstream-adapter.js`
- `integrations/codex-bridge/test/anti-falso-complete.test.cjs`
- `integrations/codex-bridge/test/browser-stall-regression.test.cjs`
- `integrations/codex-bridge/test/configuration-contract.test.cjs`
- `integrations/codex-bridge/test/mock-http-contract.test.cjs`
- `integrations/codex-bridge/test/request-classifier.test.cjs`
- `roadmap.md`
- `server/src/__tests__/db/idempotency.test.ts`
- `server/src/db/index.ts`
- `server/src/lib/analytics/contract.ts`
- `server/src/routes/analytics/index.ts`
- `server/src/routes/proxy-log.ts`
- `server/src/routes/proxy.ts`

Cambios propios fuera del repositorio: ninguno.  
Cambio ajeno preservado y no incluido en esta tarea:
`integrations/codex-bridge/test/_e2e_apply_patch.cjs`.

## Implementación realizada

- `request-classifier.js` identifica la duplicación Flash → alias de título con
  una huella SHA-256 acotada; nunca registra el texto de usuario. Una selección
  explícita inicial de Pro no se reclasifica.
- `title-responder.js` responde localmente el título con texto sanitizado y
  longitud limitada, sin enviar una fila de modelo a GloryAPI.
- `context-adapter.js` separa auditoría compacta de continuación completa y
  comparte un presupuesto total. El timeout de auditoría deja margen para la
  recuperación real.
- `upstream-adapter.js` propaga `X-Glory-Request-Kind` y
  `X-Glory-Parent-Request-Id`. GloryAPI persiste esos campos y migra bases
  existentes de forma aditiva.
- Analytics muestra solicitudes principales/auxiliares, auditorías,
  continuaciones, relación con el turno padre y tokens cacheados.
- La suite dirigida pasó `41/41` y `npm run build` pasó para shared, server y
  client. `npm run quality:doctor` sigue limitado por `tool-source-missing` del
  runtime externo de Sentinel; no se declara PASS de gate.

## Autorización y no alcance

Este plan autoriza edición, pruebas, build, documentación y commit locales.
No autoriza deploy, push, escrituras en servicios externos ni SSH directo.
