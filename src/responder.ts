/**
 * Slack responder — JS stored on `webhooks.responder` for wire's post-
 * validator hook (wire v1.13.0+).
 *
 * Satisfies Slack's URL verification handshake: Slack POSTs once to a
 * newly-configured Event Subscriptions URL with
 *   { "type": "url_verification", "challenge": "<opaque>" }
 * and expects the same challenge echoed back in the response body.
 *
 * Returning null on a non-handshake POST lets wire continue to normal
 * filter → route. The responder runs only after the validator (HMAC
 * signature check) passes, so handshake echoes stay authenticated.
 */

export function buildSlackResponder(): string {
  return `
    if (parsedBody && typeof parsedBody === "object" && parsedBody.type === "url_verification") {
      return { body: { challenge: parsedBody.challenge } };
    }
    return null;
  `.trim();
}
