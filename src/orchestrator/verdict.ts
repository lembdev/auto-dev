import { z } from "zod";

// What the QA Agent answers with: exactly one such JSON object in its last message.
export type Blocker = { where: string; what: string };
export type Verdict = { approved: boolean; summary: string; blockers: Blocker[] };

const verdictSchema = z.object({
  approved: z.boolean(),
  summary: z.string(),
  blockers: z.array(z.object({ where: z.string(), what: z.string() })),
});

// Every balanced `{...}` at the top level of the text, string literals respected, so a JSON object
// inside a code fence or after prose is found and nested objects are not counted twice.
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

// The verdict of a QA message, or undefined when the message holds no verdict or more than one.
// `approved` is taken only with an empty blockers list: a QA that approves and names blockers blocks.
export function parseVerdict(text: string): Verdict | undefined {
  return splitVerdict(text)?.verdict;
}

// The verdict of a QA message and the prose around it, with the JSON and its code fence taken out.
export function splitVerdict(text: string): { verdict: Verdict; rest: string } | undefined {
  const candidates = topLevelObjects(text).flatMap((candidate) => {
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(candidate));
      return parsed.success ? [{ source: candidate, verdict: parsed.data }] : [];
    } catch {
      return [];
    }
  });
  if (candidates.length !== 1) return undefined;
  const { source, verdict } = candidates[0]!;
  const rest = text
    .replace(source, "")
    .replace(/```[a-z]*\s*```/gi, "")
    .trim();
  return { verdict: { ...verdict, approved: verdict.approved && verdict.blockers.length === 0 }, rest };
}

// The verdict as the Implementer and the next QA round read it.
export function formatVerdict(verdict: Verdict): string {
  const lines = [`Вердикт QA: ${verdict.approved ? "approved" : "not approved"}.`, "", verdict.summary.trim() || "(без описания)"];
  if (verdict.blockers.length > 0) {
    lines.push("", "Blockers:", "", ...verdict.blockers.map((blocker, i) => `${i + 1}. ${blocker.where}: ${blocker.what}`));
  }
  return lines.join("\n");
}

// The next message into the Implementer Session: every blocker to fix, or the summary when QA named none.
export function formatBlockers(verdict: Verdict): string {
  const lines = ["Замечания QA (blockers). Исправь каждое, снова прогони тесты и линт, закоммить и запушь, затем ответь списком «что исправлено»."];
  if (verdict.blockers.length === 0) {
    lines.push("", verdict.summary.trim() || "(QA не назвал blockers и не описал причину)");
  } else {
    lines.push("", ...verdict.blockers.map((blocker, i) => `${i + 1}. ${blocker.where}: ${blocker.what}`));
  }
  return lines.join("\n");
}
