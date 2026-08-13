# Tarea: integrar CommandCode y selector de modelos en el ChatGPT Bridge

## Objetivo

Integrar CommandCode como proveedor nuevo de GloryAPI y permitir que la ventana de ChatGPT que usa el
bridge mantenga el comportamiento actual `auto`, pero también permita seleccionar explícitamente un
proveedor y modelo para cada conversación o solicitud.

El ChatGPT normal no debe modificarse ni compartir historial/configuración con el perfil bridge.

## Proveedor solicitado

- Proveedor: `commandcode`
- Documentación: <https://commandcode.ai/docs>
- Modelos que deben exponerse de CommandCode:
  - DeepSeek Flash
  - Muse Spark 1.2 Contributor: <https://commandcode.ai/models/muse-spark-1-2-contributor>
  - DeepSeek V4 Pro (latest): <https://commandcode.ai/models/deepseek-v4-pro>
- La clave API fue proporcionada por el usuario, pero NO debe copiarse a este archivo, al código, a Git,
  logs ni a mensajes. Debe registrarse mediante la UI/bóveda DPAPI de GloryAPI. Como fue pegada en texto
  plano, recomendar al usuario revocarla y generar otra antes de almacenarla.

## Requisitos funcionales

1. Investigar en la documentación oficial el endpoint, esquema de autenticación, nombres/IDs exactos de
   modelos, límites y compatibilidad con OpenAI Chat Completions o Responses.
2. Registrar `commandcode` en el catálogo/registro de proveedores de GloryAPI, sin hardcodear la clave.
3. Añadir la credencial mediante el flujo seguro existente de `api_keys` + DPAPI.
4. Añadir únicamente los tres modelos solicitados de CommandCode. No importar automáticamente todo el
   catálogo remoto.
5. Mantener `Auto` como opción predeterminada del selector. `Auto` debe conservar el enrutamiento/fallback
   actual de GloryAPI.
6. Añadir selección explícita de proveedor y modelo en la configuración que consume la ventana bridge.
   La selección debe viajar por una configuración/contrato versionado, no mediante cambios manuales en
   `server.js` ni variables globales ambiguas.
7. Al elegir CommandCode, enrutar solo a CommandCode y al modelo seleccionado; no cambiar silenciosamente
   a otro proveedor salvo que el contrato de `Auto` lo permita y quede visible.
8. Mostrar nombres legibles en español y conservar IDs técnicos internos.
9. Si el modelo seleccionado no existe, la clave falta o el proveedor falla, devolver un error estructurado
   y visible; no cerrar el turno como completado ni fingir que se usó otro modelo.
10. No romper streaming, herramientas, razonamiento, visión ni la separación de historiales.

## Archivos y zonas que se deben revisar

- `server/src/providers/registry.ts`
- `server/src/providers/catalog/`
- `server/src/routes/keys.ts`
- `server/src/routes/models.ts`
- `server/src/routes/proxy.ts`
- `server/src/services/router.ts` y política de fallback
- `server/src/settings/`
- `integrations/codex-bridge/bridge/config.js`
- `integrations/codex-bridge/bridge/server.js`
- `integrations/codex-bridge/bridge/http-server.js`
- `integrations/codex-bridge/bridge/upstream-adapter.js`
- `integrations/codex-bridge/mode/prepare-isolated-home.ps1`
- `integrations/codex-bridge/mode/start-codex-bridge.ps1`
- `integrations/codex-bridge/README.md`
- `integrations/codex-bridge/COMANDOS-BRIDGE.md`

Primero localizar cómo el cliente Codex/ChatGPT obtiene el proveedor y el modelo actuales. No asumir que
el selector visual pertenece al bridge: comprobar el contrato real de la aplicación y adaptar la capa de
configuración que ya existe.

## Diseño esperado

Separar claramente:

- `auto`: selección existente de GloryAPI, con sus fallbacks y trazas.
- proveedor explícito: `provider=commandcode`.
- modelo explícito: el ID exacto documentado por CommandCode.

La capa bridge debe ser agnóstica: el proveedor y sus modelos deben venir de configuración/catálogo, no de
condicionales dispersos en `server.js`. Las claves deben resolverse en memoria desde DPAPI y nunca formar
parte del JSON de configuración, logs o fixtures.

## Pruebas obligatorias

- Build de servidor y type-check.
- Tests del catálogo/registro de proveedores y credenciales.
- Test de selección `auto` sin cambios de comportamiento.
- Test de selección explícita de cada uno de los tres modelos CommandCode.
- Test de modelo/proveedor inválido.
- Test de clave ausente o deshabilitada.
- Test de error HTTP, timeout y streaming interrumpido.
- Test de que el selector no modifica el perfil normal ni sus conversaciones.
- Suite completa de `integrations/codex-bridge/test`.
- Health/readiness de GloryAPI `:3101` y bridge `:4100`.

## Seguridad y límites

- No mostrar, imprimir, copiar ni commitear la clave API.
- No usar la clave recibida en este prompt como valor por defecto.
- Validar URL pública HTTPS y evitar credenciales embebidas en URL.
- Mantener timeouts, límites de body, redacción de errores y trazabilidad de proveedor/modelo.
- No hacer deploy, push ni escrituras remotas.
- No tocar `integrations/codex-bridge/test/_e2e_apply_patch.cjs`; es un archivo ajeno/preexistente.

## Definition of Done

- CommandCode aparece en el catálogo y puede recibir una credencial desde la UI segura.
- Los tres modelos solicitados aparecen con nombres e IDs correctos.
- El selector del perfil bridge ofrece `Auto` y selección explícita.
- `Auto` mantiene el comportamiento anterior.
- La selección explícita enruta correctamente y deja evidencia de proveedor/modelo sin secretos.
- Las conversaciones normales siguen intactas y separadas.
- Tests y build pasan; el bridge y GloryAPI quedan saludables.
- Documentación y comandos de operación quedan actualizados.
- Entregar commit(s), rutas modificadas, comandos ejecutados y limitaciones reales.
