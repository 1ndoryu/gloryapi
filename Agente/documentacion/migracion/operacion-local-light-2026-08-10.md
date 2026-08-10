# Operación del gate local-light

`npm run task:check:local -- <ID>` es el preflight rápido para una fase de trabajo. Ejecuta el gate
de Sentinel con el alcance explícito `docs,frontend`, sin `--full` ni `--allow-heavy`, y conserva
el mismo adaptador declarativo de etapas que el cierre completo. Su objetivo es detectar errores de
documentación, UI y estilos antes de gastar el guard de cargas pesadas.

El cierre de una fase o del rediseño sigue usando `npm run task:check -- <ID>`, `quality:doctor`, pruebas,
build y el perfil completo/CI que corresponda. Un PASS local-light no sustituye el gate completo ni prueba
proveedores, Codex Desktop, el bridge operativo o tráfico externo.

## Recuperación bajo otro perfil

`npm run recover:profile -- --mode verify --bundle <archivo-externo> --db <db-nueva-externa>` ejecuta una
verificación sintética del contrato portable bajo el perfil Windows que lance el proceso. Requiere
`GLORYAPI_BUNDLE_PASSPHRASE` de al menos 12 caracteres, exige que bundle y base estén fuera del repositorio,
que el bundle sea regular, que ningún ancestro existente sea symlink/junction y que bundle/base no existan
previamente (fail-closed para no sobrescribir ni contaminar datos operativos), comprueba dry-run sin escritura,
importación idempotente de 22 filas y
round-trip DPAPI `CurrentUser`.
La prueba negativa también rechaza crear sobre un bundle existente y verifica que repetir la restauración
contra una SQLite existente falla antes de abrirla.
No realiza health check ni tráfico de proveedor. El ensayo de creación de un usuario Windows distinto,
ACL y limpieza requiere una ventana administrativa separada; no se considera evidencia de Desktop ni de
credenciales reales hasta ejecutarlo de forma controlada.
