/**
 * Slack webhook validator — generates the JS string stored on
 * `webhooks.validator` for wire's `runValidator` sandbox.
 *
 * Validates Slack's HMAC-SHA256 signature scheme:
 *   X-Slack-Signature: v0=<hex>
 *   HMAC input:        v0:<X-Slack-Request-Timestamp>:<rawBody>
 *   Key:               <signing_secret>
 * Anti-replay: rejects requests whose timestamp is >5 minutes off.
 *
 * Returns `{ source, topic }` on success so wire surfaces the workspace
 * label as the event source. The `topic` always falls back to
 * `webhook.slack` for the agent's channel routing — agent-side filtering
 * (webhooks.filter) is the noise gate.
 *
 * Note: URL-verification handshakes (Slack pings new event URLs once with
 * `type: "url_verification"`, expecting the `challenge` field echoed back)
 * need wire-side support for the validator to return a direct HTTP body.
 * The current validator contract is pass/fail + source/topic only. Until
 * wire supports `respond_with`, run app-config validation manually OR add
 * a `?challenge=...` query-handler path. Tracked as an upstream issue.
 */

export interface SlackValidatorOptions {
  /** The workspace label used as the source/topic suffix (e.g. "mivid-studios"). */
  workspace: string;
  /** Topic to use; defaults to "webhook.slack". */
  topic?: string;
  /** Anti-replay window in milliseconds. Default 5 minutes. */
  replayToleranceMs?: number;
}

/** Build the validator JS body for wire to store in webhooks.validator. */
export function buildSlackValidator(opts: SlackValidatorOptions): string {
  const workspace = JSON.stringify(opts.workspace);
  const topic = JSON.stringify(opts.topic ?? "webhook.slack");
  const tolerance = opts.replayToleranceMs ?? 5 * 60 * 1000;

  // The string body is what wire stores. `secrets.signing_secret` is the
  // Slack app's Signing Secret. The body executes inside wire's sandbox
  // with (headers, body, secrets, directory) bound as named args.
  return `
    const sig = headers["x-slack-signature"];
    const ts = headers["x-slack-request-timestamp"];
    if (!sig || !ts) return false;

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    const ageMs = Math.abs(Date.now() - tsNum * 1000);
    if (ageMs > ${tolerance}) return false;

    const signingSecret = secrets.signing_secret;
    if (!signingSecret) return false;

    const sigVersion = "v0";
    const baseString = sigVersion + ":" + ts + ":" + body;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(baseString));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const expected = sigVersion + "=" + hex;

    // Constant-time-ish compare
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return false;

    return { source: ${workspace}, topic: ${topic} };
  `.trim();
}
