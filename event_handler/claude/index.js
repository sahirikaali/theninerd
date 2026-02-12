const path = require('path');
const { render_md } = require('../utils/render-md');

const DEFAULT_MODEL = 'moonshotai/kimi-k2.5';

/**
 * Get NVIDIA API key from environment
 * @returns {string} API key
 */
function getApiKey() {
  if (process.env.NVIDIA_API_KEY) {
    return process.env.NVIDIA_API_KEY;
  }
  throw new Error('NVIDIA_API_KEY environment variable is required');
}

/**
 * Convert Anthropic tool definitions to OpenAI function format
 */
function convertToolsToOpenAI(tools) {
  return tools
    .filter((t) => t.name && t.input_schema)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema,
      },
    }));
}

/**
 * Convert Anthropic messages format to OpenAI messages format
 */
function convertMessagesToOpenAI(systemPrompt, messages) {
  const openaiMessages = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        openaiMessages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        openaiMessages.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let text = '';
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }
        const assistantMsg = { role: 'assistant' };
        if (text) assistantMsg.content = text;
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        if (!text && toolCalls.length === 0) assistantMsg.content = '';
        openaiMessages.push(assistantMsg);
      }
    }
  }

  return openaiMessages;
}

/**
 * Convert OpenAI response back to Anthropic format (internal message format)
 */
function convertResponseToAnthropic(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    return { content: [{ type: 'text', text: 'No response from model.' }], stop_reason: 'end_turn' };
  }

  const msg = choice.message;
  const content = [];

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e) {
        args = { raw: tc.function.arguments };
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: args,
      });
    }
  }

  let stopReason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  if (msg.tool_calls && msg.tool_calls.length > 0) stopReason = 'tool_use';

  return { content, stop_reason: stopReason };
}

/**
 * Call LLM via NVIDIA NIM API
 * @param {Array} messages - Conversation messages
 * @param {Array} tools - Tool definitions
 * @returns {Promise<Object>} API response in Anthropic internal format
 */
async function callClaude(messages, tools) {
  const apiKey = process.env.NVIDIA_API_KEY;
  const model = process.env.EVENT_HANDLER_MODEL || DEFAULT_MODEL;
  const systemPrompt = render_md(path.join(__dirname, '..', '..', 'operating_system', 'CHATBOT.md'));

  const openaiMessages = convertMessagesToOpenAI(systemPrompt, messages);
  const openaiTools = convertToolsToOpenAI(tools);

  const body = {
    model,
    max_tokens: 4096,
    messages: openaiMessages,
  };

  if (openaiTools.length > 0) {
    body.tools = openaiTools;
  }

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`NVIDIA NIM API error: ${response.status} ${error}`);
  }

  const openaiResponse = await response.json();
  return convertResponseToAnthropic(openaiResponse);
}

/**
 * Process a conversation turn, handling tool calls
 * @param {string} userMessage - User's message
 * @param {Array} history - Conversation history
 * @param {Array} toolDefinitions - Available tools
 * @param {Object} toolExecutors - Tool executor functions
 * @returns {Promise<{response: string, history: Array}>}
 */
async function chat(userMessage, history, toolDefinitions, toolExecutors) {
  const messages = [...history, { role: 'user', content: userMessage }];

  let response = await callClaude(messages, toolDefinitions);
  let assistantContent = response.content;

  messages.push({ role: 'assistant', content: assistantContent });

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        const executor = toolExecutors[block.name];
        let result;

        if (executor) {
          try {
            result = await executor(block.input);
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          result = { error: `Unknown tool: ${block.name}` };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (toolResults.length === 0) {
      break;
    }

    messages.push({ role: 'user', content: toolResults });

    response = await callClaude(messages, toolDefinitions);
    assistantContent = response.content;

    messages.push({ role: 'assistant', content: assistantContent });
  }

  const textBlocks = assistantContent.filter((block) => block.type === 'text');
  const responseText = textBlocks.map((block) => block.text).join('\n');

  return {
    response: responseText,
    history: messages,
  };
}

module.exports = {
  chat,
  getApiKey,
};
