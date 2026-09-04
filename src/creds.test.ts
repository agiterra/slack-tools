import { describe, expect, test } from "bun:test";
import { credsFor, envSuffix, labeledWorkspaces } from "./creds";

const env = {
  SLACK_BOT_TOKEN: "xoxb-default", SLACK_SIGNING_SECRET: "sec-default", SLACK_BOT_USER_ID: "U_DEFAULT", SLACK_WORKSPACE: "fabricaland",
  SLACK_BOT_TOKEN_MIVID_STUDIOS: "xoxb-mivid", SLACK_SIGNING_SECRET_MIVID_STUDIOS: "sec-mivid", SLACK_BOT_USER_ID_MIVID_STUDIOS: "U_MIVID",
};
describe("credsFor", () => {
  test("no label → default creds", () => { expect(credsFor(undefined, env).botToken).toBe("xoxb-default"); expect(credsFor("", env).botUserId).toBe("U_DEFAULT"); });
  test("default workspace label → default creds", () => { expect(credsFor("fabricaland", env).botToken).toBe("xoxb-default"); });
  test("label selects suffixed vars (dash → underscore, case-insensitive)", () => {
    const c = credsFor("mivid-studios", env); expect(c).toEqual({ botToken: "xoxb-mivid", signingSecret: "sec-mivid", botUserId: "U_MIVID", label: "mivid-studios" });
    expect(credsFor("Mivid Studios", env).botToken).toBe("xoxb-mivid");
  });
  test("unknown label → empty, never the default token (a wrong-workspace post is worse than a refusal)", () => {
    const c = credsFor("nowhere", env); expect(c.botToken).toBe(""); expect(c.botUserId).toBe("");
  });
  test("envSuffix", () => { expect(envSuffix("mivid-studios")).toBe("MIVID_STUDIOS"); expect(envSuffix(" a.b c ")).toBe("A_B_C"); });
  test("labeledWorkspaces lists every suffixed signing secret", () => { expect(labeledWorkspaces(env)).toEqual(["mivid-studios"]); expect(labeledWorkspaces({})).toEqual([]); });
});
