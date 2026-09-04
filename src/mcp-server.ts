#!/usr/bin/env bun
/**
 * Slack MCP server — runtime-agnostic adapter.
 *
 * Tools:
 *   register_slack_app   — wire up a Slack app's events to land on the
 *                          calling agent's channel. Returns the Request
 *                          URL to paste into api.slack.com.
 *   unregister_webhook   — tear down a registration by wire webhook id.
 *   post_message         — chat.postMessage with optional thread_ts/blocks.
 *   add_reaction         — reactions.add.
 *
 * Config env vars:
 *   WIRE_URL             default http://localhost:9800
 *   WIRE_EXTERNAL_URL    externally-reachable Wire URL (e.g. ngrok)
 *   AGENT_ID             required
 *   AGENT_PRIVATE_KEY    Ed25519 PKCS8 base64 (required for Wire API auth)
 *   SLACK_BOT_TOKEN      default Slack bot token for outbound calls
 *   SLACK_SIGNING_SECRET default Slack app signing secret (validator key)
 *   SLACK_WORKSPACE      this persona's workspace label — single source of
 *                        truth for the webhook identity. When set (with
 *                        AGENT_ID + SLACK_SIGNING_SECRET) the server
 *                        idempotently re-registers its webhook on boot to
 *                        self-heal a swept/dropped registration.
 *   SLACK_BOT_USER_ID    when set, register_slack_app defaults to a
 *                        self-echo filter dropping the bot's own messages.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildSlackWebhook } from "./webhooks.js";
import { postMessage, addReaction } from "./api.js";
import { createAuthJwt, importPrivateKey } from "@agiterra/wire-tools";

const WIRE_URL = process.env.WIRE_URL ?? "http://localhost:9800";
const WIRE_EXTERNAL_URL = process.env.WIRE_EXTERNAL_URL ?? WIRE_URL;
const AGENT_ID = process.env.AGENT_ID ?? "";
const DEFAULT_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const DEFAULT_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";
const DEFAULT_WORKSPACE = process.env.SLACK_WORKSPACE ?? "";
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID ?? "";
import { credsFor, envSuffix, labeledWorkspaces } from "./creds.js";

let signingKey: CryptoKey | null = null;

const mcp = new Server(
  { name: "slack", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "register_slack_app",
      description:
        "Register this agent's Slack app event subscription with Wire. Returns the Request URL to paste into the Slack app's Event Subscriptions config at api.slack.com. The Slack app itself (bot user, scopes, install to workspace) must be created manually one time per persona. Once the Request URL is set, all events the bot can see arrive as `webhook.slack` channel messages on this agent.\n\nRegistration is idempotent: if the webhook already exists it is left untouched and reported as already-registered, so this is safe to call repeatedly. Under normal circumstances OMIT the workspace param — it is read from the SLACK_WORKSPACE env var, which is the single source of truth that the on-boot self-heal also uses. Passing an explicit workspace risks registering a SECOND webhook under a different label that diverges from the one the server heals on boot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workspace: {
            type: "string",
            description: "Workspace label — used in the URL path and as the event source attribute, e.g. 'mivid-studios'. OMIT under normal circumstances: defaults to the SLACK_WORKSPACE env var (the single source of truth shared with the boot self-heal). Only pass this to register an additional/ad-hoc workspace.",
          },
          org_name: { type: "string", description: "Human name of the Slack org (e.g. 'Mivid Studios'); stamped as slack_org on every delivery. Defaults to SLACK_ORG_NAME[_<LABEL>] env or the label title-cased." },
          team_id: { type: "string", description: "Slack team id (T…) to stamp alongside the org name. Defaults to SLACK_TEAM_ID[_<LABEL>] env." },
          signing_secret: {
            type: "string",
            description: "Slack app Signing Secret. Defaults to SLACK_SIGNING_SECRET env var.",
          },
          filter: {
            type: "string",
            description: "Optional JS filter expression evaluated per delivery. Receives {headers, payload} and returns truthy to deliver. Example: 'payload.event?.user !== \"U_BOT_ID\"' to drop the bot's own messages.\n\nIf omitted AND SLACK_BOT_USER_ID env is set, defaults to dropping the bot's own outgoing messages (self-echo). Pass an explicit expression to override. Pass 'true' for a pure firehose.",
          },
          session_id: {
            type: "string",
            description: "Optional session_id to scope this webhook to the current session — wire purges it the moment the session ends. Default = agent-scoped (persists across sessions).",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "unregister_webhook",
      description: "Delete a Wire webhook registration by id. Useful for tearing down a Slack app's event subscription.",
      inputSchema: {
        type: "object" as const,
        properties: {
          webhook_id: { type: "number", description: "Wire webhook id." },
          agent_id: { type: "string", description: "Optional. Owning agent id; defaults to caller." },
        },
        required: ["webhook_id"],
      },
    },
    {
      name: "post_message",
      description: "Post a message to a Slack channel, DM, or thread (chat.postMessage).",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Channel id, user id (DM), or channel name." },
          text: { type: "string", description: "Message text (fallback when blocks are used)." },
          thread_ts: { type: "string", description: "Optional parent message ts to reply into." },
          blocks: { type: "array", description: "Optional Block Kit blocks." },
          bot_token: { type: "string", description: "Slack bot token; defaults to SLACK_BOT_TOKEN env." },
          workspace: { type: "string", description: "Workspace label (as registered, e.g. 'mivid-studios'): selects SLACK_BOT_TOKEN_<LABEL>. Omit for the default workspace." },
        },
        required: ["channel", "text"],
      },
    },
    {
      name: "add_reaction",
      description: "Add an emoji reaction to a message (reactions.add).",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string" },
          ts: { type: "string", description: "Message timestamp returned by post_message." },
          name: { type: "string", description: "Emoji name without colons. e.g. 'thumbsup'." },
          bot_token: { type: "string", description: "Slack bot token; defaults to SLACK_BOT_TOKEN env." },
          workspace: { type: "string", description: "Workspace label (as registered): selects SLACK_BOT_TOKEN_<LABEL>. Omit for the default workspace." },
        },
        required: ["channel", "ts", "name"],
      },
    },
  ],
}));

async function wirePost(path: string, body: string): Promise<Response> {
  if (!signingKey) throw new Error("no signing key — Wire auth disabled");
  const token = await createAuthJwt(signingKey, AGENT_ID, body);
  return fetch(`${WIRE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
}

async function wireDelete(path: string): Promise<Response> {
  if (!signingKey) throw new Error("no signing key — Wire auth disabled");
  const body = "{}";
  const token = await createAuthJwt(signingKey, AGENT_ID, body);
  return fetch(`${WIRE_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
}

/**
 * Build + POST a Slack webhook registration to Wire. Shared by the
 * register_slack_app tool and the on-boot self-heal. Wire's POST is
 * idempotent (v1.15.0+): if the webhook already exists it returns the
 * existing record with registered:false and leaves it untouched.
 */
async function registerSlackWebhook(opts: {
  workspace: string;
  signingSecret: string;
  filter?: string;
  sessionId?: string;
  /** Bot user id of the app in THIS workspace (self-echo filter). Defaults to the label's SLACK_BOT_USER_ID_<LABEL>, else SLACK_BOT_USER_ID. */
  botUserId?: string;
  /** Human org name stamped on every delivery (SLACK_ORG_NAME / SLACK_ORG_NAME_<LABEL> env, or the label title-cased). */
  orgName?: string;
  teamId?: string;
}): Promise<{ webhookId: number; registered: boolean; requestUrl: string; filterSource: string | null }> {
  // Default to a self-echo filter if the caller didn't supply one and we
  // have the bot's user id in env. Without this, every agent that posts to
  // Slack via post_message sees its own message echoed back as an inbound
  // event — a trap every operator independently rediscovers. Substitute the
  // user_id literal so the filter sandbox doesn't need process.env access.
  let filter = opts.filter;
  let filterSource: string | null = null;
  if (filter) {
    filterSource = "caller-supplied";
  } else {
    // Per-workspace bot user: webhook 99 (brioche/mivid-studios) defaulted to the Fabrica app's
    // id and let every Mivid self-post echo back (2026-09-04).
    const uid = opts.botUserId || credsFor(opts.workspace, process.env).botUserId || BOT_USER_ID;
    if (uid) {
      filter = `payload.event?.user !== "${uid}"`;
      filterSource = `defaulted to self-echo filter (bot user ${uid} for workspace ${opts.workspace})`;
    }
  }

  const reg = buildSlackWebhook({
    agentId: AGENT_ID,
    workspace: opts.workspace,
    signingSecret: opts.signingSecret,
    filter,
    sessionId: opts.sessionId,
    orgName: opts.orgName || process.env[`SLACK_ORG_NAME_${envSuffix(opts.workspace)}`] || (opts.workspace === DEFAULT_WORKSPACE ? process.env.SLACK_ORG_NAME : undefined),
    teamId: opts.teamId || process.env[`SLACK_TEAM_ID_${envSuffix(opts.workspace)}`] || (opts.workspace === DEFAULT_WORKSPACE ? process.env.SLACK_TEAM_ID : undefined),
  });

  const wireRes = await wirePost(`/agents/${AGENT_ID}/webhooks`, JSON.stringify(reg.wireBody));
  if (!wireRes.ok) throw new Error(`Wire registration failed (${wireRes.status}): ${await wireRes.text()}`);
  const { webhook_id, registered } = (await wireRes.json()) as { webhook_id: number; registered: boolean };
  return { webhookId: webhook_id, registered, requestUrl: reg.requestUrl(WIRE_EXTERNAL_URL), filterSource };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "register_slack_app") {
      // Workspace is normally read from SLACK_WORKSPACE (single source of
      // truth shared with the boot self-heal); an explicit param overrides
      // it only for ad-hoc/additional registrations.
      const workspace = (a.workspace as string) || DEFAULT_WORKSPACE;
      if (!workspace) throw new Error("no workspace — set SLACK_WORKSPACE env (preferred) or pass workspace param");
      const signingSecret = (a.signing_secret as string) || credsFor(workspace, process.env).signingSecret;
      if (!signingSecret) throw new Error(`no Slack signing secret for workspace '${workspace}' — set SLACK_SIGNING_SECRET (default workspace) / SLACK_SIGNING_SECRET_<LABEL>, or pass signing_secret param`);

      const { webhookId, registered, requestUrl, filterSource } = await registerSlackWebhook({
        workspace,
        signingSecret,
        filter: a.filter as string | undefined,
        sessionId: a.session_id as string | undefined,
        orgName: a.org_name as string | undefined,
        teamId: a.team_id as string | undefined,
      });

      const filterLine = filterSource ? `\nFilter: ${filterSource}` : "\nFilter: none (pure firehose — set SLACK_BOT_USER_ID env to default a self-echo filter)";
      const status = registered
        ? `Slack webhook registered: wire id ${webhookId}`
        : `Slack webhook already registered (idempotent): wire id ${webhookId} — existing registration left untouched`;
      return {
        content: [{
          type: "text" as const,
          text: `${status}\nRequest URL (paste into api.slack.com → Event Subscriptions): ${requestUrl}${filterLine}`,
        }],
      };
    }

    if (name === "unregister_webhook") {
      const webhookId = a.webhook_id as number;
      if (!webhookId) throw new Error("missing webhook_id");
      const ownerId = (a.agent_id as string | undefined) ?? AGENT_ID;
      const res = await wireDelete(`/agents/${ownerId}/webhooks/${webhookId}`);
      if (!res.ok) throw new Error(`Wire deletion failed (${res.status}): ${await res.text()}`);
      return {
        content: [{ type: "text" as const, text: `Webhook ${webhookId} deleted (owner=${ownerId})` }],
      };
    }

    if (name === "post_message") {
      const botToken = (a.bot_token as string) || credsFor(a.workspace as string | undefined, process.env).botToken;
      if (!botToken) throw new Error(`no Slack bot token${a.workspace ? ` for workspace '${a.workspace}' — set SLACK_BOT_TOKEN_${String(a.workspace).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}` : " — set SLACK_BOT_TOKEN"} or pass bot_token param`);
      const result = await postMessage({
        botToken,
        channel: a.channel as string,
        text: a.text as string,
        threadTs: a.thread_ts as string | undefined,
        blocks: a.blocks as unknown[] | undefined,
      });
      return {
        content: [{ type: "text" as const, text: `posted to ${result.channel} ts=${result.ts}` }],
      };
    }

    if (name === "add_reaction") {
      const botToken = (a.bot_token as string) || credsFor(a.workspace as string | undefined, process.env).botToken;
      if (!botToken) throw new Error(`no Slack bot token${a.workspace ? ` for workspace '${a.workspace}' — set SLACK_BOT_TOKEN_${String(a.workspace).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}` : " — set SLACK_BOT_TOKEN"} or pass bot_token param`);
      await addReaction(botToken, a.channel as string, a.ts as string, a.name as string);
      return { content: [{ type: "text" as const, text: `reaction :${a.name}: added` }] };
    }

    throw new Error(`unknown tool: ${name}`);
  } catch (e) {
    const err = e as Error;
    return {
      content: [{ type: "text" as const, text: `${name} failed: ${err.message}` }],
      isError: true,
    };
  }
});

export async function startServer(): Promise<void> {
  const rawKey = process.env.AGENT_PRIVATE_KEY;
  if (!rawKey) {
    console.error("[slack] no private key — Wire auth disabled");
  } else {
    signingKey = await importPrivateKey(rawKey);
  }

  if (!AGENT_ID) console.error("[slack] no AGENT_ID — tools will fail");
  if (!DEFAULT_BOT_TOKEN) console.error("[slack] no SLACK_BOT_TOKEN — agents must pass bot_token param");
  if (!DEFAULT_SIGNING_SECRET) console.error("[slack] no SLACK_SIGNING_SECRET — agents must pass signing_secret param on register");

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(`[slack] ready (agent=${AGENT_ID})`);

  // Boot self-heal: idempotently ensure our Slack webhook exists, so a
  // swept/dropped registration (janitor, manual delete, schema migration)
  // recovers on the next session without a human noticing the firehose went
  // dark. Wire's POST is idempotent (registered:false → leave untouched).
  // Best-effort and fire-and-forget — log-only, never block readiness or
  // throw (an opportunistic boot action must not break the MCP server).
  if (signingKey && AGENT_ID && DEFAULT_WORKSPACE && DEFAULT_SIGNING_SECRET) {
    registerSlackWebhook({ workspace: DEFAULT_WORKSPACE, signingSecret: DEFAULT_SIGNING_SECRET })
      .then(({ webhookId, registered }) =>
        console.error(`[slack] boot self-heal: webhook ${webhookId} ${registered ? "registered (was missing)" : "already present"} (workspace=${DEFAULT_WORKSPACE})`))
      .catch((e) => console.error(`[slack] boot self-heal failed (non-fatal): ${(e as Error).message}`));
  }
  // Labeled workspaces (SLACK_SIGNING_SECRET_<LABEL>): same idempotent self-heal, each with its own bot user id.
  if (signingKey && AGENT_ID) {
    for (const label of labeledWorkspaces(process.env)) {
      if (label === DEFAULT_WORKSPACE) continue;
      const c = credsFor(label, process.env);
      registerSlackWebhook({ workspace: label, signingSecret: c.signingSecret, botUserId: c.botUserId })
        .then(({ webhookId, registered }) => console.error(`[slack] boot self-heal: webhook ${webhookId} ${registered ? "registered (was missing)" : "already present"} (workspace=${label})`))
        .catch((e) => console.error(`[slack] boot self-heal failed for ${label} (non-fatal): ${(e as Error).message}`));
    }
  }
  if (DEFAULT_WORKSPACE && !signingKey) {
    console.error("[slack] boot self-heal skipped — SLACK_WORKSPACE set but no AGENT_PRIVATE_KEY for Wire auth");
  } else if (DEFAULT_WORKSPACE && !DEFAULT_SIGNING_SECRET) {
    console.error("[slack] boot self-heal skipped — SLACK_WORKSPACE set but no SLACK_SIGNING_SECRET");
  }
}
