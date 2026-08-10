import type { CapabilityProfile, ProviderAdapterKind } from '@gloryapi/shared/types.js';

export type ProviderTemplate = {
  id: string;
  displayName: string;
  adapter: ProviderAdapterKind;
  wireProtocol: 'chat-completions' | 'chat-completions-reasoning' | 'gemini-content';
  authScheme: 'bearer' | 'account-and-token';
  endpointHint: string;
  capabilities: CapabilityProfile;
  discovery: 'openai-models' | 'manual-selection';
  description: string;
};

const openAiCapabilities: CapabilityProfile = {
  streaming: true,
  tools: true,
  reasoning: false,
  multimodal: false,
  maxContextWindow: 131072,
};

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'openai-chat',
    displayName: 'OpenAI-compatible Chat Completions',
    adapter: 'openai-compatible',
    wireProtocol: 'chat-completions',
    authScheme: 'bearer',
    endpointHint: 'https://provider.example/v1',
    capabilities: openAiCapabilities,
    discovery: 'openai-models',
    description: 'Base contract for providers exposing /chat/completions and optional /models discovery.',
  },
  {
    id: 'openai-reasoning-chat',
    displayName: 'OpenAI-compatible reasoning',
    adapter: 'openai-compatible',
    wireProtocol: 'chat-completions-reasoning',
    authScheme: 'bearer',
    endpointHint: 'https://provider.example/v1',
    capabilities: { ...openAiCapabilities, reasoning: true },
    discovery: 'openai-models',
    description: 'Chat Completions variant that declares reasoning explicitly and must be probed before activation.',
  },
  {
    id: 'gemini-content',
    displayName: 'Google Gemini content',
    adapter: 'google-gemini',
    wireProtocol: 'gemini-content',
    authScheme: 'bearer',
    endpointHint: 'https://generativelanguage.googleapis.com',
    capabilities: { streaming: true, tools: true, reasoning: false, multimodal: true, maxContextWindow: 1048576 },
    discovery: 'manual-selection',
    description: 'Native Gemini adapter; model selection stays explicit because its request/response unions differ.',
  },
];

export function getProviderTemplates(): ProviderTemplate[] {
  return PROVIDER_TEMPLATES.map(template => ({
    ...template,
    capabilities: { ...template.capabilities },
  }));
}
