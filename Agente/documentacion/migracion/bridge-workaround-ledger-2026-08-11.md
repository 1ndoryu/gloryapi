# Ledger de workarounds del bridge

Este inventario separa contrato estable, adaptación observada, compatibilidad legacy,
duda de laboratorio y código muerto. Cada entrada debe conservar su fixture antes de
retirarse; ninguna regla se debe reintroducir como condicional disperso en `server.js`.

| ID | Entrada observable | Categoría | Cliente/modelo | Salida esperada | Evidencia | Propietario/retirada |
| --- | --- | --- | --- | --- | --- | --- |
| Q-001 | `reasoning_content` requerido en assistant con tools | quirk vigente | DeepSeek thinking | reasoning real reinyectado; fallback sintético nunca visible | `anti-falso-complete`, `reasoning-cache` | adapter; retirar cuando el proveedor acepte historial sin reasoning |
| Q-002 | nombres namespaced pierden el primer `__` | quirk vigente | DeepSeek + MCP | recuperar namespace/nombre sin inventar payload | `responses-adapter`, tool tests | translation; retirar con fixture upstream corregido |
| Q-003 | discovery tardío de `mcp__node_repl__js` | adaptación | Codex Desktop | inyección solo en perfil `codex-desktop`; `generic` no inyecta | `tool-profile`, `static-contract` | tools; retirar cuando Desktop anuncie la tool |
| Q-004 | `spawn_agent` necesita argumento fork estable | compatibilidad legacy | Codex collaboration | normalizar args sin exponer secreto | canary/app-server | translation; revisar por build Codex |
| Q-005 | custom `apply_patch` es freeform | contrato de tool | Codex custom tools | `custom_tool_call`, no function JSON | fixture contractual + canary | tools; estable mientras el cliente lo exija |
| Q-006 | web search no existe nativamente en upstream | adaptación | Codex Desktop | loop interno bounded y contenido web no confiable | browser-stall/mock HTTP | services; retirar solo con provider web probado |
| Q-007 | imágenes se describen como texto | pérdida declarada | Codex image input | no anunciar visión nativa; capability `unverified/unsupported` | vision redaction/body timeout | vision; reemplazar con adapter healthy y E2E |
| Q-008 | respuesta vacía/reasoning-only | resiliencia | modelos thinking | recuperación única bounded; si falla, `response.failed` | browser-stall/anti-falso-complete | handlers; retirar tras evidencia estable |
| Q-009 | texto que promete acción sin tool | prevención | todos los modelos | nudge solo turno actual; no nudge tras tool del turno | `anti-falso-complete` | handlers; retirar con E2E de cierre fiable |
| Q-010 | `foreign_toolset` produce downgrade/429 | proveedor observado | Andoryyu | clasificar `model_downgrade`, no cooldown ni éxito falso | regression fixture/canary | provider registry; retirar con re-test del worker |

Regla de promoción: una observación live no cambia routing ni capabilities aprobadas;
debe convertirse en fixture sanitizado, incluir versión/build y pasar el contrato antes
de ser una adaptación soportada. Una duda sigue `unverified` y falla cerrada si es obligatoria.
