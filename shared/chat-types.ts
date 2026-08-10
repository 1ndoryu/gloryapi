import type { Platform } from './types.js';

// OpenAI-compatible wire types. These stay separate from the registry and
// routing domain types so adapters can evolve without inflating the core
// shared contract module.
export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: { name: string };
  };

// OpenAI's multimodal envelope: clients like opencode / continue.dev send
// content as an array of typed blocks even for text-only messages. We accept
// it on the wire and flatten to string for providers that don't support it.
export type ChatContentBlock = { type: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  reasoning_content?: string;
  reasoning?: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionRequest extends ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type ChatCompletionResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
};

export type ChatCompletionChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
};
