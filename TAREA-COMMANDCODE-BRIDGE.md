# Tarea: integrar CommandCode y selector de modelos en el ChatGPT Bridge

## Objetivo

Integrar CommandCode como proveedor nuevo de GloryAPI y permitir que la ventana de ChatGPT que usa el
bridge mantenga el comportamiento actual `auto`, pero también permita seleccionar explícitamente un
proveedor y modelo para cada conversación o solicitud.

El ChatGPT normal no debe modificarse ni compartir historial/configuración con el perfil bridge.

## Contexto operativo que no se debe perder

Este trabajo pertenece al proyecto `gloryapi` en:

```text
C:\Users\Owner\OneDrive\Documentos\area-trabajo\gloryapi
```

La arquitectura actual es:

```text
ChatGPT Desktop bridge
  -> CODEX_HOME aislado: %USERPROFILE%\.codex-gloryapi
  -> bridge local: 127.0.0.1:4100
  -> GloryAPI local: 127.0.0.1:3101
  -> proveedor/modelo seleccionado por GloryAPI
```

El ChatGPT normal usa `%USERPROFILE%\.codex`, tiene su propio historial y no debe ser modificado.
El bridge usa otro perfil, otra configuración y otro historial. No copiar `auth.json`, conversaciones,
`state_*.sqlite` ni la base del home normal.

Rutas persistentes actuales:

- Base GloryAPI: `%USERPROFILE%\.gloryapi\gloryapi.db`.
- Runtime GloryAPI: `%USERPROFILE%\.gloryapi\runtime`.
- Runtime/logs del bridge: `%USERPROFILE%\.gloryapi\runtime\bridge-runtime`.
- Home/historial del bridge: `%USERPROFILE%\.codex-gloryapi`.
- Launcher del acceso directo: `integrations/codex-bridge/mode/start-codex-bridge.ps1`.
- Launcher del servicio: `integrations/codex-bridge/bridge/start-bridge.ps1`.

Al abrir el acceso directo, `start-bridge.ps1` debe comprobar siempre ambos servicios. Si `4100` sigue
activo pero `3101` fue cerrado, debe iniciar GloryAPI y esperar `/api/ping` antes de devolver éxito.
No matar ni reiniciar procesos del ChatGPT normal.

## Estado actual antes de implementar

- Rama de trabajo: `gloryapi`.
- Último commit documental conocido: `0d8cacc`.
- Cambios funcionales recientes:
  - `c446592`: recuperación ante narración sin herramienta/falso cierre.
  - `ea9d11c`: fallback de visión, diagnóstico honesto ante `429` y rutas configurables.
  - `ad951d5`: fallback de visión a OpenCode Go `mimo-v2.5` usando clave DPAPI.
  - `fc0ea74`: el acceso directo recupera GloryAPI si `3101` está cerrado.
  - `0402e1c`: compatibilidad con items de ciclo de vida de Codex.
- Existe un archivo no rastreado ajeno: `integrations/codex-bridge/test/_e2e_apply_patch.cjs`.
  No tocarlo, borrarlo, incluirlo en commits ni usarlo como fuente de configuración.

Proveedores/modelos actualmente observados en la base local, sin incluir secretos:

- `andoryyu` / DeepSeek V4 Flash.
- `opencode-zen` / DeepSeek V4 Flash Free.
- `opencode-go` / DeepSeek V4 Flash.
- `tokenharbor` / DeepSeek V4 Flash Free.

El modelo principal actual del bridge es `deepseek-v4-flash`; cambiarlo globalmente rompería el
comportamiento actual. La nueva selección debe ser explícita y compatible con `Auto`.

## Problemas históricos que la implementación debe conservar corregidos

No reintroducir estos fallos:

1. DeepSeek puede devolver solo `reasoning` o `tool_calls`. El bridge no debe cerrar el turno como
   completado si no existe resultado visible ni llamada ejecutable.
2. `FALLBACK_REASONING` solo sirve para satisfacer el contrato histórico de DeepSeek y no debe aparecer
   como mensaje visible del agente.
3. Contextos muy grandes provocaban respuestas vacías; conservar límites, compactación/recuperación y
   errores estructurados.
4. No mezclar herramientas web internas con herramientas ejecutadas por el cliente en una misma ronda.
5. No reenviar imágenes al modelo de texto si el contrato actual usa adaptación de visión a texto.
6. En visión, una imagen recibida con proveedor fallido no debe convertirse en “la carpeta está vacía”.
   El bridge debe indicar la causa real y continuar sin inventar contenido.
7. No romper nombres de herramientas con namespaces, deduplicación, streaming, cancelación ni respuestas
   Responses traducidas a Chat Completions.

## Decisión de diseño para el selector

Antes de editar, identificar cuál de estas capas es la fuente real del selector:

- selector/configuración de modelos de la aplicación Codex Desktop;
- `config.toml` del perfil bridge;
- endpoint/catálogo de GloryAPI;
- campo `model` o metadato de enrutamiento del request Responses;
- otra configuración ya existente del bridge.

No crear una UI paralela ni editar directamente el `config.toml` normal. La preferencia debe persistir
solo en el perfil bridge y tener un contrato versionado. Debe existir una representación equivalente a:

```json
{
  "provider": "auto",
  "model": null
}
```

para `Auto`, y:

```json
{
  "provider": "commandcode",
  "model": "<id-documentado-exacto>"
}
```

para selección explícita. Los nombres de ejemplo no son IDs válidos hasta comprobar la documentación
oficial.

El selector debe permitir, como mínimo:

- `Auto`.
- CommandCode → DeepSeek Flash.
- CommandCode → Muse Spark 1.2 Contributor.
- Los proveedores/modelos existentes que ya exponga el catálogo, sin eliminarlos.

Si la aplicación no permite selector dinámico en la versión instalada, documentar la limitación exacta
y construir primero el contrato/catálogo estable para que la UI pueda consumirlo sin hardcodear modelos.

## Proveedor solicitado

- Proveedor: `commandcode`
- Documentación: <https://commandcode.ai/docs>
- Modelos que deben exponerse de CommandCode:
  - DeepSeek Flash
  - Muse Spark 1.2 Contributor: <https://commandcode.ai/models/muse-spark-1-2-contributor>
- La clave API fue proporcionada por el usuario, pero NO debe copiarse a este archivo, al código, a Git,
  logs ni a mensajes. Debe registrarse mediante la UI/bóveda DPAPI de GloryAPI. Como fue pegada en texto
  plano, recomendar al usuario revocarla y generar otra antes de almacenarla.

## Requisitos funcionales

1. Investigar en la documentación oficial el endpoint, esquema de autenticación, nombres/IDs exactos de
   modelos, límites y compatibilidad con OpenAI Chat Completions o Responses.
2. Registrar `commandcode` en el catálogo/registro de proveedores de GloryAPI, sin hardcodear la clave.
3. Añadir la credencial mediante el flujo seguro existente de `api_keys` + DPAPI.
4. Añadir únicamente los dos modelos restantes solicitados de CommandCode. No importar automáticamente todo el
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
11. El proveedor/modelo elegido debe quedar en trazas sanitizadas para diagnóstico, pero nunca la API key,
    `Authorization`, prompt completo ni argumentos sensibles.

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
- `server/src/scripts/bridge-upstream-auth.ts`
- `server/src/scripts/bridge-vision-auth.ts`
- `server/src/lib/dpapi-vault.ts`
- `server/src/db/index.ts` y migraciones del catálogo
- `server/src/providers/openai-compat.ts`
- Tests existentes del bridge, especialmente `static-contract.test.cjs`,
  `readiness-contract.test.cjs`, `mock-http-contract.test.cjs`, `stream-http-contract.test.cjs`,
  `vision-body-timeout.test.cjs` y `vision-error-redaction.test.cjs`.

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

GloryAPI ya usa `api_keys` con DPAPI (`dpapi-current-user`) y tiene rutas de catálogo/credenciales. Reutilizar
ese flujo. No crear una base paralela ni recuperar claves desde FreeLLMAPI. El helper de una credencial debe
seguir el patrón de leer SQLite en modo `readonly`, resolver DPAPI y entregar el secreto solo al request.

La prueba directa de proveedores debe hacerse con el endpoint y modelo exactos obtenidos de la documentación;
no asumir que CommandCode usa la misma ruta o el mismo formato que OpenCode, TokenHarbor o Freebuff.

## Pruebas obligatorias

- Build de servidor y type-check.
- Tests del catálogo/registro de proveedores y credenciales.
- Test de selección `auto` sin cambios de comportamiento.
- Test de selección explícita de cada uno de los dos modelos CommandCode.
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
- Los dos modelos restantes aparecen con nombres e IDs correctos; DeepSeek V4 Pro está retirado.
- El selector del perfil bridge ofrece `Auto` y selección explícita.
- `Auto` mantiene el comportamiento anterior.
- La selección explícita enruta correctamente y deja evidencia de proveedor/modelo sin secretos.
- Las conversaciones normales siguen intactas y separadas.
- Tests y build pasan; el bridge y GloryAPI quedan saludables.
- Documentación y comandos de operación quedan actualizados.
- Entregar commit(s), rutas modificadas, comandos ejecutados y limitaciones reales.

## Procedimiento de trabajo para el siguiente modelo

1. Leer este documento completo, `AGENTS.md`, `README.md`, `PLAN-CODEX-BRIDGE.md` y el estado Git.
2. Consultar la documentación oficial de CommandCode y guardar solo IDs/nombres/contratos, nunca la clave.
3. Auditar el catálogo actual y el origen real de configuración del perfil bridge.
4. Escribir un plan corto antes de editar: proveedor, credenciales, catálogo, contrato de selección, bridge,
   pruebas y documentación.
5. Implementar en bloques pequeños y probar cada bloque.
6. Añadir la credencial solo mediante la UI/bóveda DPAPI o el mecanismo local autorizado. Si el usuario no
   ha revocado la clave expuesta, detener la configuración de esa credencial y pedir una nueva.
7. Ejecutar build, tests, health de `3101`/`4100` y una solicitud controlada por cada modelo. Redactar todo
   secreto de las salidas.
8. Revisar diff y cambios ajenos. No usar `git add .` ni incluir `_e2e_apply_patch.cjs`.
9. Actualizar documentación y registrar evidencia reproducible antes del commit.

## Información que debe devolver el modelo que complete la tarea

- IDs exactos de CommandCode usados y fuente oficial consultada.
- Rutas modificadas y motivo de cada una.
- Cómo se almacena/resuelve la credencial sin exponerla.
- Cómo se representa `Auto` y la selección explícita.
- Evidencia de que el ChatGPT normal y sus historiales no cambiaron.
- Comandos exactos, resultados de tests/build/health y cualquier limitación.
- Commits creados. No incluir claves, tokens, cookies ni cuerpos sensibles.
