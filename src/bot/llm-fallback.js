const { DEFAULT_REPLY } = require('./intent-analyzer');

async function llmFallback(text) {
  return DEFAULT_REPLY;
}

module.exports = { llmFallback };
