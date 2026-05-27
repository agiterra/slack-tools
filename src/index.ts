export {
  buildSlackValidator,
  type SlackValidatorOptions,
} from "./validator.js";

export { buildSlackResponder } from "./responder.js";

export {
  buildSlackWebhook,
  type SlackWebhookOptions,
  type SlackWebhookRegistration,
} from "./webhooks.js";

export {
  postMessage,
  addReaction,
  lookupUserByEmail,
  type PostMessageOptions,
} from "./api.js";

// MCP server (shared by claude-code and codex adapters)
export { startServer } from "./mcp-server.js";
