# Prevención: no ejecutar el controlador Codex legacy desde `.codex`

## Caso reproducible

Los enlaces bajo `%USERPROFILE%\.codex` pueden resolver a
`freellmapi\integrations\codex-bridge\mode\codex-mode.ps1` aunque GloryAPI tenga una
fuente nueva con `-Preview` y preflight fail-closed. Ejecutar el enlace legacy puede
aceptar `-Mode deepseek` sin conocer `-Preview` y mutar el perfil activo.

## Capa responsable

La activación pertenece al controlador GloryAPI y al preflight
`glory-codex-activation-preflight-v1`. FreeLLMAPI queda fuera de esta reparación y no
se modifica durante la migración.

## Detección esperada

Antes de cualquier canary se ejecuta:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\integrations\codex-bridge\mode\codex-activation-preflight.ps1 -Json
```

Si alguno de `bridge`, `codex-mode.ps1`, `switch-chatgpt.ps1` o
`switch-deepseek.ps1` devuelve `target-not-gloryapi`, se detiene el flujo y no se
invoca ningún script bajo `%USERPROFILE%\.codex`.

## Evidencia actual

El preflight corregido del 2026-08-10 detecta los cuatro enlaces legacy, el perfil
DeepSeek 4000/bearer sin `auth.command` y el bridge detenido. El modo activo quedó en
ChatGPT después de la recuperación operativa; no se ejecutará un enlace legacy de
nuevo durante esta migración.

## Registro de recuperación

Una invocación de prueba al enlace legacy no reconoció `-Preview` y cambió
temporalmente el perfil. Se restauró inmediatamente desde el snapshot ChatGPT conocido
y se detuvo el bridge. Se conservaron solo fingerprints, no contenido: hash observado
antes `0B9B690FFA32EDC2BE9B30E28F4F5F3229620B91BF3F7314AC2CF68548AAAFEE`, hash
intermedio DeepSeek `9D762EB872261E6A19029A4CF9F489960B8D8DB7DD1AC2F5EA25AD96EEA2E2C5`
y hash restaurado `392827F634046D3E8E8C1F343450DEF235CCC8FD264FECBAB4167CB699B3EB75`.
El hash previo no tiene una copia local recuperable en el inventario de backups, por
lo que debe revisarse manualmente antes de cualquier cutover.

## Actualización tras el cutover local

El 2026-08-10 se creó un snapshot `glory-codex-cutover.rollback-*.json`, se
repuntaron los cuatro enlaces a GloryAPI y el preflight pasó `ready=true`. La
protección sigue vigente: si un enlace vuelve a `freellmapi`, se bloquea el flujo
y no se ejecuta el controlador desde `%USERPROFILE%\.codex` hasta repararlo.

La comprobación posterior de solo lectura confirmó que el hash actual coincide
exactamente con `config.chatgpt.toml` (`392827F634046D3E8E8C1F343450DEF235CCC8FD264FECBAB4167CB699B3EB75`),
no quedan journal/temporales/lock del controlador, no existe `bridge.pid` y no hay
listener en 4100. Otros archivos runtime recientes del perfil pertenecen al estado
normal de Codex y no se atribuyen a esta recuperación sin un snapshot previo.
