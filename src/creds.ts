/**
 * Per-workspace credentials (2026-09-04, Brioche 599545: a persona can have apps in several
 * Slack workspaces — Fabrica AND Mivid Studios — and the single SLACK_BOT_TOKEN posted into the
 * wrong one). A workspace LABEL (the same string register_slack_app uses, e.g. "mivid-studios")
 * selects SLACK_BOT_TOKEN_<LABEL>, SLACK_SIGNING_SECRET_<LABEL>, SLACK_BOT_USER_ID_<LABEL>
 * (label upper-cased, every non-alphanumeric → "_"). No label, or the default workspace's label,
 * → the unsuffixed vars. Pure: env is a parameter so it is testable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Credential FILE fallback (Brioche 599603, 2026-09-04): Claude Code's daemon pre-spawns "bg-spare"
 * sessions with the daemon's own environment, so a var added to ~/.zshenv after the daemon started
 * never reaches the session or the MCP servers it starts. A file read at CALL time sidesteps that:
 * `$HOME/.wire/slack-creds.env` (KEY=VALUE lines, `export` prefix tolerated, # comments) — the same
 * file the channel-names hook reads. process.env wins on conflict. Missing/unreadable file = {}.
 */
export function loadCredFile(path: string = join(process.env.HOME ?? "", ".wire", "slack-creds.env")): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.replace(/^export\s+/, "").match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch { return {}; }
}

/** process.env layered over the credential file — the env every credsFor() call should use. */
export function slackEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...loadCredFile(), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")) };
}

export interface SlackCreds { botToken: string; signingSecret: string; botUserId: string; label: string | null }

export function envSuffix(label: string): string {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function credsFor(
  label: string | undefined | null,
  env: Record<string, string | undefined>,
  defaultWorkspace: string = env.SLACK_WORKSPACE ?? "",
): SlackCreds {
  const base = { botToken: env.SLACK_BOT_TOKEN ?? "", signingSecret: env.SLACK_SIGNING_SECRET ?? "", botUserId: env.SLACK_BOT_USER_ID ?? "" };
  const l = label?.trim();
  if (!l || l === defaultWorkspace) return { ...base, label: l || null };
  const s = envSuffix(l);
  return {
    botToken: env[`SLACK_BOT_TOKEN_${s}`] ?? "",
    signingSecret: env[`SLACK_SIGNING_SECRET_${s}`] ?? "",
    botUserId: env[`SLACK_BOT_USER_ID_${s}`] ?? "",
    label: l,
  };
}

/** Every labeled workspace the env knows a signing secret for (boot self-heal registers each). */
export function labeledWorkspaces(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .map((k) => k.match(/^SLACK_SIGNING_SECRET_(.+)$/)?.[1])
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase().replace(/_/g, "-"));
}
