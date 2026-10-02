import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slack-ste-"));
process.env.STE_GLOSSARY_PATH = join(dir, "glossary.md");
process.env.STE_RULES_PATH = join(dir, "rules.md");
writeFileSync(process.env.STE_GLOSSARY_PATH, "| Approved name | Banned synonyms | Meaning |\n|---|---|---|\n| worktree | checkout, clone | a git worktree |\n");
writeFileSync(process.env.STE_RULES_PATH, "```json ste-lint-config\n{\"max_words_slack\": 25}\n```\n");
const { steForSlackPost, POST_MESSAGE_DESCRIPTION } = await import("./mcp-server.js");

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ") + ".";

describe("post_message STE lint (AGI-154)", () => {
  test("banned synonym + 40-word sentence in text -> warnings, slack mode", () => {
    const r = steForSlackPost(`Open the checkout. ${words(40)}`, undefined);
    expect(r).toContain("STE (slack, warn-only — the message was sent)");
    expect(r).toContain('"checkout": write "worktree"');
    expect(r).toContain("Sentence has 40 words (cap 25)");
  });
  test("22 words passes in slack mode (cap 25, not the IPC 20)", () => {
    expect(steForSlackPost(words(22), undefined)).toBe("");
  });
  test("prose inside blocks is linted too", () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Please clone the repo first." } }];
    expect(steForSlackPost("fallback text here", blocks)).toContain('"clone": write "worktree"');
  });
  test("clean message -> empty string; missing text does not throw", () => {
    expect(steForSlackPost("I merged PR 41. CI is green.", undefined)).toBe("");
    expect(steForSlackPost(undefined, undefined)).toBe("");
  });
  test("description carries the core rules and the glossary path", () => {
    expect(POST_MESSAGE_DESCRIPTION).toContain("/opt/agiterra/pod-tools/share/ste/glossary/glossary.md");
    expect(POST_MESSAGE_DESCRIPTION).toContain("25 words or fewer");
  });
});
