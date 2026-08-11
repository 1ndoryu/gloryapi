import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DATABASE_PATH, resolveDatabasePath } from '../../config/database-path.js'

describe('GloryAPI database path', () => {
  it('defaults runtime data outside the repository', () => {
    expect(DEFAULT_DATABASE_PATH).toBe(path.join(os.homedir(), '.gloryapi', 'gloryapi.db'))
  })

  it('resolves an explicit persistent path', () => {
    expect(resolveDatabasePath('relative/gloryapi.db')).toBe(path.resolve('relative/gloryapi.db'))
  })

  it('preserves the in-memory test sentinel', () => {
    expect(resolveDatabasePath(':memory:')).toBe(':memory:')
  })

  it('rejects paths inside the FreeLLMAPI legacy tree', () => {
    expect(() => resolveDatabasePath('freellmapi/server/data/freeapi.db'))
      .toThrow(/FreeLLMAPI legacy tree/)
  })
})
