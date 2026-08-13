import { describe, expect, it } from 'vitest'
import {
  estimateReasoningTokens,
  extractProviderReasoningTokens,
  reasoningTelemetryFromUsage,
} from '../../lib/reasoning-telemetry.js'

describe('reasoning telemetry', () => {
  it('prefers the provider direct reasoning token count', () => {
    expect(extractProviderReasoningTokens({
      reasoning_tokens: 42,
      completion_tokens_details: { reasoning_tokens: 7 },
    })).toBe(42)
    expect(reasoningTelemetryFromUsage({ reasoning_tokens: 42 })).toEqual({
      reasoningTokens: 42,
      reasoningTokensSource: 'provider',
    })
  })

  it('accepts OpenAI-compatible completion and output detail shapes', () => {
    expect(extractProviderReasoningTokens({
      completion_tokens_details: { reasoning_tokens: 19 },
    })).toBe(19)
    expect(extractProviderReasoningTokens({
      output_tokens_details: { reasoning_tokens: 23 },
    })).toBe(23)
    expect(extractProviderReasoningTokens({
      completion_tokens_details: { reasoning_tokens: 0 },
    })).toBe(0)
  })

  it('returns no false provider measurement when usage omits reasoning', () => {
    expect(reasoningTelemetryFromUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      reasoningTokens: 0,
      reasoningTokensSource: 'none',
    })
    expect(estimateReasoningTokens('123456789')).toBe(3)
  })
})
