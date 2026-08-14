export type SummaryRow = {
  total_requests: number;
  main_requests: number | null;
  auxiliary_requests: number | null;
  success_count: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_reasoning_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  avg_latency_ms: number | null;
};

export type ModelStatsRow = {
  platform: string;
  model_id: string;
  display_name: string | null;
  requests: number;
  success_rate: number;
  avg_latency_ms: number;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
};

export type PlatformStatsRow = Omit<ModelStatsRow, 'model_id' | 'display_name'>;

export type TimelineRow = {
  timestamp: string;
  requests: number;
  success_count: number;
  failure_count: number;
};

export type ErrorDetailRow = {
  platform: string;
  model_id: string;
  error_category: string;
  count: number;
};

export type CategoryRow = { category: string; count: number };
export type PlatformErrorRow = { platform: string; count: number };

export type HistoryRow = {
  id: number;
  platform: string;
  model_id: string;
  display_name: string | null;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_effort: string | null;
  reasoning_tokens: number | null;
  reasoning_tokens_source: string | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
  api_key_id: number | null;
  api_key_label: string | null;
  request_kind: string | null;
  parent_request_id: string | null;
  parent_route_id: string | null;
  parent_configuration_revision: number | null;
  parent_selection_reason: string | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  requested_model: string | null;
  route_id: string | null;
  configuration_revision: number | null;
  selection_reason: string | null;
  selection_confidence: string | null;
  result_brief: string;
};

export type RecentErrorRow = {
  id: number;
  platform: string;
  model_id: string;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
};
