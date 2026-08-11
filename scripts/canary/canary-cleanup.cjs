async function cleanupCanaryResources({
  bridgeProcess,
  serverProcess,
  upstreamServer,
  childProcesses = [],
  stopChild,
  closeServer,
  removeRuntime,
}) {
  const errors = [];
  const run = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  };

  const children = new Map();
  if (bridgeProcess) children.set(bridgeProcess, 'bridge');
  if (serverProcess) children.set(serverProcess, 'server');
  for (const child of childProcesses) {
    if (child && !children.has(child)) children.set(child, 'child');
  }
  for (const [child, label] of children) {
    await run(`stop ${label}`, () => stopChild(child));
  }
  await run('close upstream', () => closeServer(upstreamServer));
  await run('remove runtime', removeRuntime);

  if (errors.length) throw new Error(errors.join('; '));
}

module.exports = { cleanupCanaryResources };
