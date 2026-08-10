# ADR-001 — Sidecar Responses aislado para Codex Desktop

- **Estado:** aceptada con reserva de E2E
- **Fecha:** 2026-08-10
- **Alcance:** `integrations/codex-bridge/`
- **Fixture:** `glory-codex-responses-fixture-v1`
- **Versiones:** `adapterVersion=gloryapi-codex-bridge-v1`, `gloryApiContract=chat-completions-v1`

## Contexto

Codex Desktop usa `wire_api = "responses"`, mientras el gateway de GloryAPI
expone Chat Completions. La traducción actual también necesita conservar
reasoning, tool calls, custom tools, búsqueda web y cancelación. Mezclar esa
compatibilidad con el router central haría que un cambio del cliente de Desktop
alterara la ruta de VS Code y dificultaría el rollback.

## Decisión

Mantener el bridge como un **sidecar local, versionado y aislado**:

1. Escucha únicamente en loopback y expone Responses.
2. Consume una versión explícita del contrato Chat Completions de GloryAPI.
3. Traduce request/response y controla su propio stream, lifecycle y estado efímero.
4. No decide el orden de routing ni conserva credenciales upstream; GloryAPI sigue
   siendo responsable de auth de inferencia, capacidades y fallback.
5. Separa autenticación cliente → sidecar de sidecar → GloryAPI. El bearer recibido
   de Codex no se reenvía ciegamente como credencial de proveedor.
6. Un contrato incompatible debe impedir readiness con diagnóstico sanitizado; no
   debe fallar a mitad de una conversación.
7. El rollback consiste en detener el sidecar y restaurar el perfil ChatGPT; no
   modifica la ruta directa de VS Code ni la base de GloryAPI.

## Lifecycle

- `start`: reservar puerto, validar identidad de la instancia, comprobar contrato y
  publicar readiness solo después de que la dependencia local responda.
- `ready`: `/health` devuelve únicamente identidad, versión y modelo; capabilities y
  diagnóstico detallado requieren autenticación.
- `draining`: rechazar nuevas conversaciones, abortar upstreams en vuelo y cerrar
  streams con terminación explícita o cierre de conexión.
- `stop`: verificar identidad PID/ruta antes de detener y eliminar únicamente el
  estado temporal propio.
- `recover`: una caché corrupta o contrato incompatible se descarta/inhabilita de
  forma fail-closed; nunca se recuperan prompts ni tokens desde archivos de estado.

## Contrato y fixtures

`fixtures/responses-contract-v1.json` fija casos sanitizados de texto, reasoning y
function tools, error upstream y cancelación. Sus invariantes principales son:

- `response.created` precede a los deltas;
- un item reasoning se anuncia antes de su delta;
- la salida termina en `response.completed` solo tras completar el upstream;
- no se fabrica `function_call_output` dentro de `response.output`;
- error y cancelación no se presentan como respuesta completa;
- no aparecen credenciales, prompts reales ni URLs privadas.

## Alternativas rechazadas

- **Integrar Responses en el router central:** acopla clientes y mezcla lifecycle con
  selección de providers.
- **Traducir Responses directamente en configuración del provider:** no permite
  aislar quirks de Codex ni versionar el rollback.
- **Anunciar compatibilidad E2E ahora:** las pruebas actuales usan mocks; la prueba
  real desde Codex Desktop queda pendiente hasta activar un perfil temporal y
  ejecutar el canary reversible.

## Consecuencias

Se acepta un salto local adicional y dos contratos que mantener. A cambio, la ruta
Chat Completions de VS Code permanece estable, el sidecar puede evolucionar con el
cliente Desktop y cada quirk puede retirarse mediante fixture y versión.
