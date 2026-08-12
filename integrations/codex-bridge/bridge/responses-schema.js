'use strict';

const RESPONSES_SCHEMA_VERSION = 'glory-responses-request-v1';
const ITEM_TYPES = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'item_reference', 'tool_search_call', 'tool_search_output',
  'web_search_call', 'web_search_call_output',
]);
const TOOL_TYPES = new Set(['function', 'custom', 'namespace', 'tool_search', 'web_search', 'computer_use_preview']);

function validateResponsesRequest(body, {
  maxItems = 512,
  maxTools = 128,
  maxContentParts = 256,
  maxStringLength = 2_000_000,
} = {}) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });
  const checkString = (value, path, required = false) => {
    if (required && typeof value !== 'string') add(path, 'string_required');
    else if (typeof value === 'string' && (value.length === 0 || value.length > maxStringLength)) add(path, 'string_bounds');
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, schema: RESPONSES_SCHEMA_VERSION, errors: [{ path: '$', code: 'object_required' }] };
  checkString(body.model, '$.model');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') add('$.stream', 'boolean_required');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') add('$.parallel_tool_calls', 'boolean_required');
  if (body.previous_response_id !== undefined) checkString(body.previous_response_id, '$.previous_response_id');
  if (body.instructions !== undefined && typeof body.instructions !== 'string' && !Array.isArray(body.instructions)) add('$.instructions', 'text_or_items_required');

  const input = body.input;
  if (typeof input !== 'string' && !Array.isArray(input)) add('$.input', 'string_or_array_required');
  if (typeof input === 'string') checkString(input, '$.input', true);
  if (Array.isArray(input)) {
    if (input.length === 0 || input.length > maxItems) add('$.input', 'item_count_bounds');
    input.forEach((item, index) => {
      const base = `$.input[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { add(base, 'object_required'); return; }
      if (typeof item.type !== 'string' || !ITEM_TYPES.has(item.type)) { add(`${base}.type`, 'known_item_type_required'); return; }
      if (item.role !== undefined && !['user', 'assistant', 'system', 'developer'].includes(item.role)) add(`${base}.role`, 'invalid_role');
      if (item.content !== undefined) {
        if (typeof item.content === 'string') checkString(item.content, `${base}.content`);
        else if (Array.isArray(item.content)) {
          if (item.content.length > maxContentParts) add(`${base}.content`, 'content_count_bounds');
          item.content.forEach((part, partIndex) => {
            if (!part || typeof part !== 'object') add(`${base}.content[${partIndex}]`, 'object_required');
            else if (typeof part.type !== 'string') add(`${base}.content[${partIndex}].type`, 'content_type_required');
            else if (typeof part.text === 'string') checkString(part.text, `${base}.content[${partIndex}].text`);
          });
        } else add(`${base}.content`, 'string_or_array_required');
      }
      if (item.type === 'message' && !item.role) add(`${base}.role`, 'role_required');
      if (item.type === 'function_call' && typeof item.call_id !== 'string') add(`${base}.call_id`, 'call_id_required');
      if (item.type === 'function_call_output' && typeof item.call_id !== 'string') add(`${base}.call_id`, 'call_id_required');
    });
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) add('$.tools', 'array_required');
    else if (body.tools.length > maxTools) add('$.tools', 'tool_count_bounds');
    else body.tools.forEach((tool, index) => {
      const base = `$.tools[${index}]`;
      if (!tool || typeof tool !== 'object' || !TOOL_TYPES.has(tool.type)) { add(base, 'known_tool_type_required'); return; }
      if (tool.type === 'function' && !(tool.name || tool.function?.name)) add(`${base}.name`, 'tool_name_required');
      // Responses discovery tools may omit `name`; the translator uses their
      // stable type (`tool_search`/`web_search`) as the wire name. Custom and
      // namespace tools still require an explicit name because there is no
      // unambiguous fallback for dispatching their calls.
      if ((tool.type === 'custom' || tool.type === 'namespace') && typeof tool.name !== 'string') add(`${base}.name`, 'tool_name_required');
      if (tool.type === 'namespace' && !Array.isArray(tool.tools)) add(`${base}.tools`, 'array_required');
    });
  }
  if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string' && (!body.tool_choice || typeof body.tool_choice !== 'object')) add('$.tool_choice', 'string_or_object_required');
  return { ok: errors.length === 0, schema: RESPONSES_SCHEMA_VERSION, errors };
}

module.exports = { RESPONSES_SCHEMA_VERSION, validateResponsesRequest };
