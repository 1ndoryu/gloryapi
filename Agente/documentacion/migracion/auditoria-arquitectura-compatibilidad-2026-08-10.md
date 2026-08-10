# Auditoría de arquitectura, compatibilidad y escalabilidad

Fecha: 2026-08-10  
Workspace: `gloryapi`  
Alcance: Fases 4, 9 y preparación de Fase 10; sin activar Codex Desktop real,
sin tocar `freellmapi` y sin enviar tráfico a proveedores reales.

## Veredicto

La arquitectura local ya separa el gateway Chat Completions, el router, los
adapters y el sidecar Responses. El caso que antes parecía “Andoryyu falla en
ChatGPT pero funciona en VS Code” no puede atribuirse todavía al proveedor: los
clientes llegan por contratos distintos. VS Code entra por Chat Completions; el
canary aislado de Codex CLI entra por Responses y se traduce en el sidecar. El
flujo ChatGPT Desktop nativo y los tres proveedores reales siguen siendo
`unverified`.

## Flujos observables

```text
VS Code / cliente OpenAI-compatible
  → POST /v1/chat/completions
  → auth + schema + CanonicalChatRequest
  → capabilities + presupuesto de routing
  → Router → provider adapter
  → JSON/SSE Chat Completions

Codex CLI canary (perfil temporal)
  → Responses /v1/responses
  → auth/readiness del sidecar
  → traducción Responses → Chat Completions
  → GloryAPI /v1/chat/completions
  → adapter determinista
  → traducción Chat → Responses
  → lifecycle/terminal para Codex
```

El flujo nativo de ChatGPT Desktop no se ha ejecutado. Por seguridad, no se
considera equivalente al canary de Codex CLI.

## Responsabilidades y límites

| Capa | Responsabilidad | Estado | Riesgo residual |
| --- | --- | --- | --- |
| `server/src/app.ts` | HTTP, CORS allowlist, límites JSON, rutas y error boundary | probado por suite/build | revisar decompression y CSP si se expone fuera de loopback |
| `routes/proxy*.ts` | auth, schema, canonicalización, routing, retry, respuesta | probado | proveedor real y tool contracts no demostrados |
| `services/router.ts` | candidatos, health, cooldown, capacidad y presupuesto | probado con mocks | afinidad/semántica real por proveedor pendiente |
| `providers/*` | contrato Chat, headers, auth y SSE por adapter | probado con mocks | cada proveedor puede tener quirks no medidos |
| `integrations/codex-bridge/bridge/server.js` | Responses↔Chat, lifecycle, auth separada, tools y cancelación | canary determinista PASS | no es prueba de Desktop ni de Responses nativo de un proveedor |
| SQLite/`db` | catálogo, vault metadata, settings, routing y snapshots | transacciones/test | recuperación bajo otro perfil Windows pendiente |
| UI | Keys, Routing, Settings, Analytics | build/test | wizard completo y bandeja aún pendientes |

## Matriz de compatibilidad actual

| Cliente / modelo | Wire de entrada | Texto | Stream | Tools | Reasoning | Imagen | Evidencia |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VS Code → Andoryyu | Chat | supported | supported | adapted | adapted | unverified | fixture Chat + canary determinista |
| VS Code → Zen | Chat | supported | supported | adapted | adapted | unverified | contrato adapter/mocks |
| VS Code → Go | Chat | supported | supported | adapted | adapted | unverified | contrato adapter/mocks |
| Codex CLI canary → GloryAPI | Responses→Chat | supported | supported | adapted | adapted | adapted/lossy | `npm run canary:codex` |
| ChatGPT Desktop nativo | desconocido | unverified | unverified | unverified | unverified | unverified | requiere prueba final aislada |
| Proveedores reales | Chat/Responses por descubrir | unverified | unverified | unverified | unverified | unverified | no se envía tráfico en esta fase |

No se anunciará `supported` para una capability que solo tenga nombre o metadata
de catálogo. `unverified` es fail-closed cuando la capability es obligatoria.

## Hallazgos de arquitectura

1. El routing ya está en GloryAPI; el sidecar no debe escoger modelo ni aplicar
   cooldown. Su responsabilidad es el contrato de Responses y el lifecycle local.
2. La normalización Chat vive en un adapter puro. Las reglas por cliente/modelo
   pertenecen a la matriz de capabilities/quirks, no a la UI ni a nombres
   dispersos en el router.
3. El fallback no modifica el orden persistido. `routing-runtime` separa
   preferencia, intentos en vuelo y último modelo completado.
4. Las respuestas stream tienen dos terminales distintos: el `[DONE]` del wire
   Chat y el lifecycle Responses del sidecar. Cada frontera debe tener un único
   propietario y nunca convertir EOF en éxito.
5. La autenticación de inferencia y control está separada; loopback no se trata
   como autorización suficiente.
6. El bridge genera o valida un `X-Glory-Request-Id` acotado, lo conserva durante
   tool loops y lo propaga al gateway; los adapters registrados lo envían al
   upstream cuando soportan headers. El ID no contiene prompts, secretos ni labels
   de métricas.
7. La fuente de verdad del catálogo es backend/SQLite; Keys y Settings consumen
   snapshots sanitizados, evitando allowlists paralelas.

## Seguridad y privacidad

Verificado localmente: auth constante, loopback por defecto, límites de body,
allowlist CORS, rechazo de URLs inseguras, redacción de errores, no reenvío del
bearer del cliente, token local DPAPI, vault con fingerprints y logs metadata-only.

Pendiente antes de exposición real: pruebas externas de SSRF/rebinding con un
servidor controlado, validación de decompression bomb, revisión de ACL con otro
perfil Windows y auditoría de CSP/HSTS si se cambia el binding.

## Rendimiento, concurrencia y fallos

El contrato actual fija presupuestos de intentos/duración, límites de SSE y body,
cancelación, backpressure básico, SQLite transaccional y cleanup de subscribers.
El canary determinista comprobó truncamiento, Unicode fragmentado y cancelación.

No se ha demostrado todavía: soak de 24 horas, 32 solicitudes reales, memoria
p95/p99, handles Windows, proveedor lento real, retry storm multi-capa ni carga
con un millón de filas. Estos resultados quedan como tareas de Fase 10.5/10.6,
no como supuestos de producción.

## Evidencia y límites

- `npm test` terminó 44 archivos/255 tests, los builds de shared/server/client,
  `npm run canary:codex`, el benchmark 128/128 (p95 68,87 ms, presupuesto 100 ms)
  y la suite determinista del bridge 31/31 pasan.
- `task:check:local -- GLORY-BASELINE` y `npm run task:check -- GLORY-REQUEST-ID-ALL`
  pasan con 0 errores y 0 warnings; `quality:doctor` confirma Sentinel 0.7.1 en
  `readyForGate: true`, y el informe full contiene `policyPath`, hash y decisión
  `enforce`. La corrección está fijada al commit `7d18a755...`/tag `v0.7.1`, con
  lock, evidencia de release y artefacto provisionado alineados; publicar el tag
  en el checkout externo queda pendiente de distribución.
- No hubo requests a Andoryyu, Zen o Go reales en esta auditoría.
- No se activó el perfil principal de Codex ni se modificó `config.toml`,
  `.codex`, `freellmapi`, VS Code ni los scripts operativos del legado.

## Próximas pruebas que desbloquean las declaraciones restantes

1. Completar el wizard/registro y el control de bandeja en GloryAPI.
2. Ejecutar probes opt-in de cada provider/modelo en perfiles temporales y
   registrar wire/capabilities por evidencia.
3. Ejecutar una prueba de Desktop real en `CODEX_HOME` temporal, con rollback
   comprobado y sin cambiar el perfil principal.
4. Ejecutar load/soak, SSRF/rebinding, otro perfil Windows y la matriz E2E.
5. Solo después valorar canary con consumidores y cutover reversible.
