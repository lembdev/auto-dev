import { describe, expect, it } from "vitest";
import { parseVerdict } from "../../src/orchestrator/verdict.js";

const approved = '{ "approved": true, "summary": "Looks good", "blockers": [] }';
const blocked = '{ "approved": false, "summary": "Two issues", "blockers": [{ "where": "src/a.ts:10", "what": "null check" }] }';

describe("QA verdict", () => {
  it("parses a bare JSON object, one inside a code fence and one after prose", () => {
    const expected = { approved: true, summary: "Looks good", blockers: [] };
    expect(parseVerdict(approved)).toEqual(expected);
    expect(parseVerdict("Вердикт:\n\n```json\n" + approved + "\n```\n")).toEqual(expected);
    expect(parseVerdict("Проверил всё.\n" + blocked)).toEqual({
      approved: false,
      summary: "Two issues",
      blockers: [{ where: "src/a.ts:10", what: "null check" }],
    });
  });

  it("treats approved with blockers as not approved", () => {
    const verdict = parseVerdict('{"approved": true, "summary": "ok", "blockers": [{"where": "x", "what": "y"}]}');
    expect(verdict).toMatchObject({ approved: false, blockers: [{ where: "x", what: "y" }] });
  });

  it("rejects text without a verdict, with a malformed one or with two of them", () => {
    expect(parseVerdict("done, all good")).toBeUndefined();
    expect(parseVerdict('{"approved": "yes", "summary": 1}')).toBeUndefined();
    expect(parseVerdict('{"approved": true, "summary": "a", "blockers": [{"where": "x"}]}')).toBeUndefined();
    expect(parseVerdict(`${approved}\n\n${blocked}`)).toBeUndefined();
    expect(parseVerdict('{"approved": true, "summary": "unterminated", "blockers": []')).toBeUndefined();
  });

  it("ignores braces inside strings and nested objects when counting", () => {
    const verdict = parseVerdict('{"approved": false, "summary": "see {x} and }", "blockers": [{"where": "f({})", "what": "}"}]}');
    expect(verdict).toMatchObject({ approved: false, blockers: [{ where: "f({})", what: "}" }] });
    expect(parseVerdict('{"a": {"b": 1}} ' + approved)).toEqual({ approved: true, summary: "Looks good", blockers: [] });
  });
});
