# TokenHarbor — DeepSeek V4 Flash

## Configuración activa

GloryAPI tiene registrado el proveedor `tokenharbor` con:

- Endpoint base: `https://tokenharbor.ai/v1`
- Adaptador: OpenAI-compatible
- Autenticación: Bearer gestionado por la bóveda local
- Modelo público: `deepseek-v4-flash:free`
- Modelo reportado por el upstream: `deepseek-v4-flash`
- Capabilities verificadas/publicadas: streaming; tools, reasoning, multimodal y contexto máximo
  permanecen desactivados o nulos hasta contar con pruebas específicas del proveedor.

La documentación oficial de TokenHarbor define el endpoint compatible de Chat Completions y el
listado de modelos bajo `/v1/models`: [TokenHarbor API](https://tokenharbor.ai/docs/api/curl).

## Política de routing

La petición genérica `deepseek-v4-flash` conserva el fallback normal. La petición explícita
`deepseek-v4-flash:free` queda fijada a TokenHarbor para que el sufijo `:free` no termine usando
silenciosamente un modelo de otro proveedor.

Si una petición genérica necesita tools o `reasoning_effort`, el router excluye TokenHarbor solo
para esa petición y continúa con el siguiente modelo que sí declara esa capability. La ruta
explícita `:free` conserva su contrato fijado y falla de forma visible si se solicitan capabilities
no verificadas.

El alias del adaptador valida la respuesta upstream con el nombre reportado sin perder el
identificador público usado por GloryAPI.

## Secretos y operación

La clave se introdujo desde `http://127.0.0.1:3101/keys` y se almacena protegida por DPAPI
`CurrentUser` en `%USERPROFILE%\\.gloryapi\\gloryapi.db`. Solo se muestra enmascarada en el panel.
No guardar claves de TokenHarbor en Git, `.env`, capturas, logs ni documentación.

Para revisar el estado, abrir el panel de claves y ejecutar **Comprobar ahora**. El chequeo usa el
endpoint de modelos; el chat de prueba debe ejecutarse solo cuando se necesite validar la ruta real.

La clave original fue compartida en una conversación, por lo que debe revocarse y regenerarse en
TokenHarbor una vez confirmada esta integración.
