import type { ChatCompletionRequest } from '@gloryapi/shared/types.js';

export const ANDORYYU_REGRESSION_FIXTURE = {
  schemaVersion: 'glory-andoryyu-regression-v1',
  model: 'deepseek-v4-flash',
  chatgpt: {
    request: {
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [
        { role: 'user', content: 'fixture: summarize the deployment status' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'fixture reasoning',
          tool_calls: [{
            id: 'fixture-call-1',
            type: 'function',
            function: { name: 'read_status', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'fixture-call-1', content: '{"status":"ready"}', name: 'read_status' },
      ],
    } satisfies ChatCompletionRequest,
    upstreamOutcome: 'stream_truncated',
    expectedFallback: true,
    expectedErrorCode: 'stream_truncated',
    expectedNextPlatform: 'opencode-zen',
  },
  vscode: {
    request: {
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'fixture: summarize the deployment status' }],
    } satisfies ChatCompletionRequest,
    upstreamOutcome: 'completed',
    expectedFallback: false,
    expectedErrorCode: null,
    expectedNextPlatform: null,
  },
} as const;

export type AndoryyuRegressionFixture = typeof ANDORYYU_REGRESSION_FIXTURE;
