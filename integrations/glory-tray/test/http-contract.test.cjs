const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawn } = require('node:child_process')
const path = require('node:path')

function startMock(responder) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, headers: req.headers, body })
      responder(req, res, body)
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })))
}

test('productive PowerShell save function sends one revisioned PUT and refreshes after a conflict', async () => {
  let putCount = 0
  const mock = await startMock((req, res, body) => {
    if (req.method === 'PUT' && req.url === '/api/fallback') {
      putCount += 1
      assert.equal(req.headers.authorization, 'Bearer tray-test-token')
      const parsed = JSON.parse(body)
      assert.equal(parsed.expectedRevision, 7)
      assert.deepEqual(parsed.entries, [{ modelDbId: 11, priority: 1, enabled: true }])
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'routing_revision_conflict' } }))
      return
    }
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/api/control/status')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ routing: { revision: 8 }, runtime: { lastCompleted: null }, models: [] }))
  })
  try {
    const base = `http://127.0.0.1:${mock.port}`
    const modulePath = path.join(__dirname, '..', 'GloryApiTray.Core.psm1').replaceAll("'", "''")
    const command = [
      `Import-Module -Name '${modulePath}' -Force`,
      `$snapshot = [pscustomobject]@{ routing = [pscustomobject]@{ revision = 7 } }`,
      `$rows = @([pscustomobject]@{ modelDbId = 11; enabled = $true })`,
      `$result = Save-GloryControlOrder -BaseUrl '${base}' -AdminToken 'tray-test-token' -LatestSnapshot $snapshot -ModelRows $rows`,
      `if ($result.Succeeded) { exit 2 }`,
      `if (-not $result.Snapshot -or $result.Snapshot.routing.revision -ne 8) { exit 3 }`,
    ].join('; ')
    const run = await new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', status => resolve({ status, stdout, stderr }))
    })
    assert.equal(run.status, 0, `${run.stderr || ''}${run.stdout || ''} requests=${JSON.stringify(mock.requests)}`)
    assert.equal(putCount, 1)
    assert.deepEqual(mock.requests.map(request => `${request.method} ${request.path}`), ['PUT /api/fallback', 'GET /api/control/status'])
  } finally {
    await new Promise(resolve => mock.server.close(resolve))
  }
})
