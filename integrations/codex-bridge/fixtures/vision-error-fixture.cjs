const originalFetch = global.fetch;

// Deterministic remote fixture: the body deliberately contains prompt-like
// text. The bridge must classify the failure without copying this body to logs.
global.fetch = async (input, init) => {
  const url = String(input);
  if (url === 'https://opencode.ai/zen/go/v1/chat/completions') {
    return new Response(JSON.stringify({ error: 'SECRET_QUERY' }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'content-length': '12' },
    });
  }
  return originalFetch(input, init);
};
