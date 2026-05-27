/**
 * Slack webhook registration — pure helpers. Build the wire registration
 * body for a Slack app's event subscription.
 *
 * The Slack app side (create app, set Request URL, install to workspace,
 * grant scopes) is a manual one-time UI flow per persona. This module
 * just wires the persona's wire-side webhook so events sent by Slack land
 * on the agent's channel.
 *
 * Slack Request URL the operator pastes into api.slack.com:
 *   ${WIRE_EXTERNAL_URL}/webhooks/${agentId}/slack/${workspace}
 */

import { buildSlackValidator } from "./validator.js";
import { buildSlackResponder } from "./responder.js";

export interface SlackWebhookOptions {
  /** Caller's wire agent id (the persona). */
  agentId: string;
  /** Workspace label, used in the wire URL path and as the source label. */
  workspace: string;
  /** Slack app Signing Secret — stored as a wire secret. */
  signingSecret: string;
  /** Optional filter expression — null = pure firehose (the default). */
  filter?: string;
  /**
   * Optional session_id — if set, wire purges this webhook the moment the
   * registering session ends. Default (null) = agent-scoped, persists
   * across sessions; janitor catches strays via heartbeat staleness.
   */
  sessionId?: string;
}

export interface SlackWebhookRegistration {
  /** The body to POST to wire at /agents/<agentId>/webhooks. */
  wireBody: {
    plugin: string;
    name: string;
    validator: string;
    responder: string;
    secrets: { signing_secret: string };
    filter?: string;
    session_id?: string;
  };
  /** The Slack-side Request URL to paste into api.slack.com. */
  requestUrl: (wireExternalUrl: string) => string;
}

export function buildSlackWebhook(opts: SlackWebhookOptions): SlackWebhookRegistration {
  return {
    wireBody: {
      plugin: "slack",
      name: opts.workspace,
      validator: buildSlackValidator({ workspace: opts.workspace }),
      responder: buildSlackResponder(),
      secrets: { signing_secret: opts.signingSecret },
      ...(opts.filter ? { filter: opts.filter } : {}),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    },
    requestUrl: (wireExternalUrl) =>
      `${wireExternalUrl.replace(/\/+$/, "")}/webhooks/${opts.agentId}/slack/${opts.workspace}`,
  };
}
