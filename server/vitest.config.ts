import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Los tests asumen entorno test (p. ej. keys.ts permite providers
    // archivados solo con NODE_ENV=test). El shell trae NODE_ENV=development
    // y vitest no lo pisa si ya existe: fijarlo aquí hace la suite hermética.
    env: { NODE_ENV: 'test' },
  },
})
