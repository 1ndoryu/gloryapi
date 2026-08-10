# GloryAPI

## Alcance

Este repositorio es la derivación aislada de GloryAPI. `../freellmapi` es el legado operativo y no debe
compartir con este workspace datos, SQLite/WAL, `.env`, puertos, PID, logs, bridge ni configuración activa.

## Reglas locales

- No copiar secretos, bases runtime, dependencias instaladas, builds, caches ni logs al repositorio.
- No abrir la SQLite del legado desde GloryAPI; las migraciones usarán snapshots/exportaciones versionadas.
- La API local debe escuchar en loopback por defecto. Cualquier exposición de red requiere una decisión y
  pruebas explícitas.
- Las credenciales se identifican por fingerprint/metadatos; sus valores no aparecen en listados, logs,
  fixtures, reportes ni documentación.
- Mantener el catálogo operativo separado de la bóveda de credenciales.
- Ejecutar `npm run build` y las suites relevantes desde este workspace antes de cerrar un cambio.
- No añadir remoto heredado ni publicar desde este repositorio sin autorización explícita.
- Los backups se solicitan con `POST /api/settings/backup`, usando `Authorization: Bearer <unified-key>` y una
  ruta absoluta externa en `GLORYAPI_BACKUP_DIR`; la respuesta nunca incluye la ruta ni secretos.
- El gate usa Sentinel 0.7.1 fijado en `sentinel.lock.json` y ejecutado desde `.quality-tools/sentinel`.
  `quality-tools.json` declara de forma explícita el checkout externo usado para provisionar el runtime;
  un clon limpio requiere sustituir esa fuente por un artefacto/checkout disponible antes de declarar
  reproducibilidad completa.
- El gate requiere un `HEAD` propio válido. `npm run task:check -- GLORY-BASELINE` ya pasa contra el
  commit baseline actual; cualquier checkout sin historia debe quedar bloqueado de forma fail-closed.

## Comandos descubiertos

```text
npm install --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run build:server
npm run quality:doctor
npm run quality:analyze
npm run task:check -- GLORY-BASELINE
```

`quality:doctor` verifica política, lock, versión, capacidades, dependencias y evidencia del runtime.
`task:check` ejecuta el gate full con el manifiesto `scripts/quality/stages.json`; su primera ejecución
requiere una historia Git con `HEAD` válido. Los hallazgos baseline actuales quedan documentados en
`Agente/documentacion/migracion/fase-0-1-2026-08-10.md`.

## Documentación

- `PLAN-GLORYAPI.md`: plan maestro heredado como referencia de ejecución.
- `Agente/documentacion/migracion/fase-0-1-2026-08-10.md`: evidencia de la derivación, backup y gate.
- `roadmap.md`: cola compacta de trabajo abierto.
