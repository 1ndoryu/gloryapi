# Prevención: orden del wizard de proveedores

Fecha: 2026-08-10  
Proyecto: `gloryapi`

## Caso mínimo

En `ProviderKeyWizard`, seleccionar `Define a new provider…` debe permitir llegar
al paso `Endpoint & auth` aunque todavía no exista slug, nombre ni endpoint. El
`POST /api/registry/providers` debe ocurrir antes del `POST /api/keys`; el secreto
no se introduce ni se transmite mientras el draft no haya respondido correctamente.

## Capa responsable

- UI: transición `__new__` → metadata → credencial.
- Control API: validación Zod del draft, autenticación administrativa y admisión de
  credenciales solo para providers activos o drafts explícitos.

## Detección esperada

- Smoke DOM local: elegir el sentinel, avanzar, comprobar el texto `Endpoint & auth`,
  guardar un fixture HTTPS y comprobar que aparece el paso `Credential`.
- Contrato server: un slug desconocido devuelve `400`; un draft explícito acepta la
  credencial cifrada y queda `unknown` + `enabled`, sin activar routing.
- Para cerrar el pendiente de cobertura UI, convertir este smoke en una prueba de
  componente/integración con `apiFetch` simulado que registre el orden de las dos
  mutaciones y pruebe cancelación/error.

## Estado

La transición se verificó manualmente en un servidor y cliente temporales de
loopback, sin credenciales reales. La automatización de componente queda como
pendiente separado; no se usa esta evidencia para declarar completo el wizard.
