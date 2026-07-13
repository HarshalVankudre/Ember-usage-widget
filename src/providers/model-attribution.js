'use strict';

// Official OpenAI model ids belong to the Codex provider even when a
// compatibility gateway makes them appear in Claude Code's transcript.
const OPENAI_MODEL = /^(gpt|chatgpt|chat-|codex|o\d)/i;

function isOpenAIModel(model) {
  return OPENAI_MODEL.test(String(model || ''));
}

module.exports = { isOpenAIModel };
