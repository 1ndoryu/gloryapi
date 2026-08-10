# ADR-002 — Registro declarativo y routing basado en evidencia

Estado: aceptado para GloryAPI local  
Fecha: 2026-08-10

## Decisión

El registro backend es la fuente de verdad para providers, modelos, auth metadata
y capabilities. El router recibe un snapshot validado y produce una traza
sanitizada de candidatos, exclusiones, presupuesto y resultado. La UI no mantiene
allowlists ni decide fallback.

Las capabilities tienen precedencia:

```text
override explícito versionado
  > fixture/E2E aprobado
  > probe live limitado
  > unknown
```

`unknown` no habilita una capacidad obligatoria. Un probe no puede retargetear una
credencial ni cambiar routing activo sin una revisión/promoción registrada.

## Consecuencias

- Agregar un provider requiere draft, validación de endpoint/auth, probe explícito,
  revisión y activación.
- El orden persistido no cambia por health, éxito o coste.
- Los quirks pertenecen al adapter/registry, no a condicionales de UI.
- La evidencia real de proveedores se mantiene separada de fixtures deterministas.

## No decidido aquí

No se decide todavía si un provider soporta Responses nativo: esa decisión requiere
probe por modelo y cliente. El bridge de Codex Desktop permanece detenido.
