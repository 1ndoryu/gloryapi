# Plan: entrada de imágenes adaptada en ChatGPT Bridge

- **Tarea:** 18A-1
- **Objetivo:** permitir que Codex Desktop adjunte imágenes con cualquier modelo publicado por el bridge; usar Mimo para describirlas cuando el modelo elegido no tenga visión nativa y conservar `image_url` directo para Muse.
- **Alcance:** catálogo versionado del bridge, proyección `/v1/models`, generador `models.json`, pruebas y documentación operativa.
- **No alcance:** cambiar capacidades reales de los proveedores, convertir modelos de texto en multimodales nativos, tocar el home normal de Codex o guardar credenciales.
- **Dependencias:** proyección `glory-bridge-model-catalog-v2`, `nativeVision` por modelo y configuración existente de Mimo/fallbacks.

## Fases verificables

1. **Contrato:** distinguir entrada de imagen aceptada por el adaptador de visión nativa del upstream.
2. **Implementación:** publicar `text,image` al cliente para todos los modelos; dejar `supports_image_detail_original` y la ruta de traducción nativa limitados a Muse/catalog entries con `nativeVision`.
3. **Regresión:** probar catálogo generado, `/v1/models`, traducción Mimo y reenvío nativo.
4. **Operación:** documentar que hay que regenerar el home aislado/reabrir Desktop después de actualizar el catálogo.
5. **Cierre:** ejecutar suites bridge/server, build y gate proporcional; registrar evidencia.

## Estado

- **Actual:** completado; el defecto era que el catálogo Desktop publicaba `input_modalities=["text"]` para modelos sin visión nativa.
- **Implementado:** el bridge separa `acceptsImageInput` de `nativeVision`; todos los modelos publican `text,image`, Mimo describe los adjuntos no nativos y Muse conserva `image_url` directo.
- **Definition of Done:** cumplida en código, pruebas y documentación. El home aislado real requiere regeneración con `-RefreshConfig` y reinicio de la ventana.
- **Evidencia:** build PASS; server 54 archivos/310 tests PASS; bridge 176/176 tests PASS; gate `GLORY-BASELINE` PASS con 0 errores, 19 warnings y 3 info preexistentes.
- **Gate:** `npm run quality:doctor` PASS (`readyForGate=true`), `npm run quality:analyze` PASS con warning informativo de `_generated` ausente.
