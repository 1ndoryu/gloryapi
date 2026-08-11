import os from 'node:os'
import path from 'node:path'

/**
 * Runtime data belongs outside the repository. Tests and controlled canaries
 * can still provide an explicit path (including :memory:).
 */
export const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.gloryapi', 'gloryapi.db')

function isInsideLegacyTree(candidatePath: string): boolean {
  return path.resolve(candidatePath)
    .split(path.sep)
    .some(segment => segment.toLowerCase() === 'freellmapi')
}

export function resolveDatabasePath(configuredPath = process.env.GLORYAPI_DB_PATH): string {
  const value = configuredPath?.trim()
  if (!value) return DEFAULT_DATABASE_PATH
  if (value === ':memory:') return value
  const resolvedPath = path.resolve(value)
  if (isInsideLegacyTree(resolvedPath)) {
    throw new Error('GLORYAPI_DB_PATH cannot point inside the FreeLLMAPI legacy tree')
  }
  return resolvedPath
}
