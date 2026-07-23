'use strict';

// Official OpenAI model ids belong to the Codex provider even when a
// compatibility gateway makes them appear in Claude Code's transcript.
const OPENAI_MODEL = /^(gpt|chatgpt|chat-|codex|o\d)/i;
const CLAUDE_MODEL = /^claude-(?:(?:\d+(?:[-.]\d+)*-)?(?:fable|mythos|opus|sonnet|haiku)|(?:instant-)?\d+(?:[-.]\d+)*)(?:[-.]?\d+)*(?:-|$)/i;

function isOpenAIModel(model) {
  return OPENAI_MODEL.test(String(model || ''));
}

function isClaudeModel(model) {
  return CLAUDE_MODEL.test(String(model || ''));
}

function isFirstPartyModel(model) {
  return isClaudeModel(model) || isOpenAIModel(model);
}

module.exports = { isClaudeModel, isFirstPartyModel, isOpenAIModel };
