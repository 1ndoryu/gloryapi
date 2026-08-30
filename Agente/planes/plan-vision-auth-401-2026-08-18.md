# Plan: autenticación de visión Mimo en el bridge

- **Tarea:** 18A-2
- **Objetivo:** evitar el `HTTP 401` al describir imágenes usando la clave DPAPI local de OpenCode Zen en la ruta primaria por defecto y OpenCode Go como fallback.
- **Alcance:** helper de credenciales token-only, launcher aislado, diagnóstico metadata-only, pruebas y documentación.
- **No alcance:** imprimir/copiar claves, cambiar credenciales remotas, hacer llamadas externas de prueba, tocar ChatGPT normal o modificar el endpoint configurado explícitamente por el usuario.
- **Dependencias:** `api_keys` local con plataformas `opencode-zen`/`opencode-go`, `bridge-vision-auth.js` compilado y `start-bridge.ps1`.

## Fases verificables

1. Confirmar que el adjunto llega y que el fallo es de autenticación, no de validación de imagen.
2. Permitir al helper seleccionar únicamente plataformas de visión autorizadas (`opencode-zen`, `opencode-go`) sin cambiar el modo token-only.
3. En la configuración por defecto, resolver Zen para `mimo-v2.5-free`; resolver Go para el fallback; respetar claves/endpoints explícitos.
4. Registrar solo presencia de credencial, ruta lógica, estado HTTP y bytes; nunca cuerpos ni secretos.
5. Compilar, ejecutar pruebas y reiniciar solo el sidecar local; comprobar health/capabilities y dejar la prueba externa de imagen al usuario para evitar una llamada no autorizada.

## Estado

- **Actual:** implementación completada y bridge local cargado; queda el reintento funcional del usuario para cerrar la evidencia de inferencia real.
- **Evidencia reproducible:** `npm run build:server` PASS; helper `bridge-vision-auth.js --check` PASS para `opencode-zen` y `opencode-go`, y rechaza plataformas no autorizadas; `node --test --test-concurrency=1 integrations/codex-bridge/test/*.test.cjs` **176/176 PASS**; `npm test -w server` **54 archivos / 310 tests PASS**; `npm run quality:doctor` PASS con `readyForGate=true`; `npm run quality:analyze` PASS con el warning conocido de `_generated` ausente; `npm run task:check -- GLORY-BASELINE` PASS con 0 errores.
- **Estado live metadata-only:** `/health` y `/ready` en `127.0.0.1:4100` PASS; `vision routes=2 primaryAuth=present fallbackAuth=1`; `/capabilities` publica `imageInput=true`, `vision=true` y lifecycle `ready`; el `models.json` aislado tiene 7 entradas con `text,image` y solo Muse con `supports_image_detail_original=true`.
- **Limitación:** no se ejecutó una inferencia real de Mimo desde la herramienta para no consumir cuota ni exponer una llamada externa no solicitada; falta que el usuario reintente el adjunto. Si vuelve a fallar, `bridge.err.log` debe mostrar únicamente metadatos por ruta (`id`, presencia de auth, estado HTTP y bytes), nunca el cuerpo ni la clave.
- **Definition of Done:** cerrar después de que la nueva ventana procese una imagen sin 401; la corrección ya deja primaria Zen autenticada y fallback Go autenticado, con reintentos acotados.
