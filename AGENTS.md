# gloryapi — instrucciones del proyecto

Especializa el `AGENTS.md` del área (`area-trabajo/AGENTS.md`): el protocolo común,
el gate (§5–§6) y el sistema documental (§7) valen aquí; abajo solo lo propio del proyecto.

Derivación aislada de GloryAPI; `../freellmapi` es el legado operativo y NO comparte con este
workspace datos, SQLite/WAL, `.env`, puertos, PID, logs, bridge ni configuración activa.

- No copiar secretos, bases runtime, dependencias instaladas, builds, caches ni logs al repositorio.
- No abrir la SQLite del legado; migraciones con snapshots/exportaciones versionadas.
- API local en loopback por defecto; exposición de red requiere decisión y pruebas explícitas.
- Credenciales identificadas por fingerprint/metadatos; sus valores nunca aparecen en listados,
  logs, fixtures, reportes ni documentación. Catálogo operativo separado de la bóveda.
- Backups: `POST /api/settings/backup` con `Authorization: Bearer <unified-key>` y ruta absoluta
  externa en `GLORYAPI_BACKUP_DIR`; la respuesta nunca incluye la ruta ni secretos.
- Gate: Sentinel 0.7.1 fijado en `sentinel.lock.json`, ejecutado desde `.quality-tools/sentinel`;
  `quality-tools.json` declara el checkout externo. `npm run task:check -- GLORY-BASELINE` ya pasa;
  checkout sin historia queda bloqueado fail-closed.
- Comandos: `npm install --ignore-scripts --no-audit --no-fund`, `npm run build`, `npm test`,
  `npm run build:server`, `npm run quality:doctor`, `npm run quality:analyze`,
  `npm run task:check -- GLORY-BASELINE`. Documentación: `PLAN-GLORYAPI.md`, `Agente/documentacion/`, `roadmap.md`.
