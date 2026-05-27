/**
 * Slack Web API helpers — outbound calls using the bot token.
 *
 * Pure functions. All config via params. No env reads.
 */

const SLACK_API = "https://slack.com/api";

async function slackPost<T = unknown>(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`slack.${method} failed: ${data.error ?? "unknown"} (http ${res.status})`);
  }
  return data;
}

export interface PostMessageOptions {
  botToken: string;
  channel: string;
  text: string;
  /** Optional thread to reply into (Slack `ts` of the parent message). */
  threadTs?: string;
  /** Optional Block Kit blocks payload — text is the fallback. */
  blocks?: unknown[];
}

export async function postMessage(
  opts: PostMessageOptions,
): Promise<{ channel: string; ts: string }> {
  const result = await slackPost<{ channel: string; ts: string }>(
    "chat.postMessage",
    opts.botToken,
    {
      channel: opts.channel,
      text: opts.text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
    },
  );
  return { channel: result.channel, ts: result.ts };
}

export async function addReaction(
  botToken: string,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  await slackPost("reactions.add", botToken, { channel, timestamp: ts, name });
}

/** Look up a user by email (admin scope or users.lookupByEmail scope). */
export async function lookupUserByEmail(
  botToken: string,
  email: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch(
      `${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${botToken}` } },
    );
    const data = (await res.json()) as { ok: boolean; user?: { id: string; name: string }; error?: string };
    if (!data.ok) return null;
    return data.user ?? null;
  } catch {
    return null;
  }
}
