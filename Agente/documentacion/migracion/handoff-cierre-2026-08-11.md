# Handoff de cierre — 2026-08-11

Este documento reúne la evidencia reproducible del bloque local. ChatGPT normal sigue activo;
el bridge y GloryAPI no se activaron, no hubo push/deploy y no contiene secretos.

## Repositorio y alcance

Repositorio: `C:\Users\Owner\OneDrive\Documentos\area-trabajo\gloryapi`
Rama: `gloryapi`
Base previa conocida: `85c4f38`
Estado: commit local creado; no se hizo push/deploy.

### Rutas Git modificadas

- `Agente/completados/tareas-2026-08-11.md`
- `PLAN-GLORYAPI.md`
- `client/src/components/keys/ProviderKeyWizard.tsx`
- `client/src/pages/FallbackPage.tsx`
- `integrations/codex-bridge/README.md`
- `integrations/codex-bridge/bridge/config.js`
- `integrations/codex-bridge/bridge/endpoint-security.js`
- `integrations/codex-bridge/bridge/http-server.js`
- `integrations/codex-bridge/bridge/reasoning-cache.js`
- `integrations/codex-bridge/bridge/response-handlers.js`
- `integrations/codex-bridge/bridge/server.js`
- `integrations/codex-bridge/bridge/vision.js`
- `integrations/codex-bridge/fixtures/responses-contract-v1.json`
- `integrations/codex-bridge/fixtures/vision-error-fixture.cjs`
- `integrations/codex-bridge/test/configuration-contract.test.cjs`
- `integrations/codex-bridge/test/mock-http-contract.test.cjs`
- `integrations/codex-bridge/test/static-contract.test.cjs`
- `integrations/codex-bridge/test/vision-body-timeout.test.cjs`
- `roadmap.md`
- `scripts/bench/routing-load.mjs`
- `sentinel.config.json`
- `server/src/routes/fallback.ts`
- `server/src/routes/proxy.ts`

### Rutas nuevas en alcance

- `Agente/documentacion/migracion/bridge-workaround-ledger-2026-08-11.md`
- `Agente/documentacion/migracion/modelo-amenazas-bridge-2026-08-11.md`
- `Agente/documentacion/migracion/handoff-cierre-2026-08-11.md`
- `client/src/components/routing/SortableModelRow.tsx`
- `integrations/codex-bridge/bridge/atomic-json.js`
- `integrations/codex-bridge/bridge/metrics.js`
- `integrations/codex-bridge/bridge/redaction.js`
- `integrations/codex-bridge/bridge/responses-schema.js`
- `integrations/codex-bridge/test/atomic-state.test.cjs`
- `integrations/codex-bridge/test/endpoint-security.test.cjs`
- `integrations/codex-bridge/test/metrics.test.cjs`
- `integrations/codex-bridge/test/redaction.test.cjs`
- `integrations/codex-bridge/test/responses-schema.test.cjs`
- `server/src/services/proxy-stream.ts`

### Fuera de alcance

- `integrations/codex-bridge/test/_e2e_apply_patch.cjs`: untracked preexistente, no tocado.
- `C:\Users\Owner\OneDrive\Documentos\area-trabajo\freellmapi\`: sibling operativo; ya estaba
  dirty y no se escribió desde este bloque.
- `C:\Users\Owner\.gloryapi\gloryapi.db`, `C:\Users\Owner\.gloryapi\backups\` y
  `C:\Users\Owner\.gloryapi\runtime\`: runtime/backup externo; este bloque no los modifica.
- `C:\Users\Owner\.codex\config.chatgpt.toml`: no modificado; SHA-256
  `392827F634046D3E8E8C1F343450DEF235CCC8FD264FECBAB4167CB699B3EB75`.

## Cambios relevantes

- `server.js` es un entrypoint/orquestador de 9226 bytes; la configuración, HTTP, Responses,
  SSE, tools, upstream, visión, estado, redacción y métricas viven en módulos separados.
- La configuración es agnóstica y acepta `BRIDGE_*` con aliases `GLORY_*`/`FREEL_*` para
  upstream, modelo, auth, contrato, perfiles y límites.
- El fallback de reasoning sintético no cruza la frontera visible; respuestas vacías,
  reasoning-only y tool-only quedan en recuperación o `response.failed` fail-closed.
- La visión valida todas las respuestas DNS, rechaza mezcla pública/privada y conecta mediante
  `lookup` fijado al conjunto validado, conservando SNI HTTPS y sin redirects.
- La caché de visión tiene TTL, LRU por número y bytes totales, y coalescing de solicitudes
  idénticas en vuelo. Las cachés persistentes usan JSON bounded y escritura atómica.

## Evidencia reproducible

| Comando | Resultado |
|---|---|
| `npm test` | exit 0; 48 archivos / 274 tests; shared y client build PASS; solo warning Vite de chunk >500 kB |
| `npm run build:server` | exit 0 |
| Suite bridge aislada | exit 0; **112 pass / 0 fail / 0 skipped / 0 todo** |
| `npm run bench:routing` con 8 | exit 0; 128/128; p95 **63.9 ms**; RSS 88784896 |
| `npm run bench:routing` con 16 | exit 0; 128/128; p95 **30.8 ms**; RSS 92778496 |
| `npm run bench:routing` con 32 | exit 0; 128/128; p95 **62.6 ms**; RSS 93859840 |
| `npm run quality:doctor` | exit 0; Sentinel 0.7.1, `ready=true`, `readyForGate=true`, `issues=[]` |
| `npm run task:check -- GLORY-BASELINE` | exit 0; full; **0 errores / 0 warnings / 0 info** |
| `git diff --check` | PASS; solo avisos informativos LF→CRLF de Git |

La suite bridge se ejecutó con `node --test --test-concurrency=1` sobre todos los
`integrations/codex-bridge/test/**/*.test.cjs`.

## Estado operativo verificado

- FreeLLMAPI sigue en `0.0.0.0:3001`, PID 10188.
- No hay listener en `:3101` (GloryAPI) ni `:4100` (bridge).
- No hay proceso cuyo command line corresponda a `server/dist` de GloryAPI o al bridge.
- ChatGPT normal sigue siendo la ruta activa; no se activó canary, E2E Desktop, cutover ni rollback.

## Pendientes que requieren contexto externo

- Remoto Git, restauración en otro perfil/equipo Windows, E2E Desktop/canary real, soak completo,
  pruebas SSRF externas para web y cierre de métricas por salto requieren destino, ventana o
  activación explícita. No se simulan como PASS manteniendo ChatGPT normal.
