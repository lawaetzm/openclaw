import type { ReplyPayload } from "../types.js";

export const UNFULFILLED_DELEGATION_NOTE =
  "Bemærk: Denne turn indeholder et løfte om at delegere eller eksekvere en handling, men intet agent-bus job blev oprettet. Handlingen vil ikke ske automatisk. Eksekvér handlingen nu eller forklar hvad der blokerer.";

const DELEGATION_COMMITMENT_PATTERNS_DA: RegExp[] = [
  /\bjeg\s+(?:gør|starter|kører|delegerer|sender\s+til|videresender|beder|spørger)\b.*\b(?:nu|med\s+det\s+samme|straks|lige)\b/i,
  /\bjeg\s+(?:delegerer|sender|videresender)\s+(?:til\s+)?(?:axel|piper|rex|lex|saga|littlefinger)\b/i,
  /\bjeg\s+(?:tager|starter|kører)\s+(?:den|det|opgaven|testen)\b/i,
  /\bjeg\s+(?:opretter|laver)\s+(?:et\s+)?(?:job|task|opgave)\b/i,
];

const DELEGATION_COMMITMENT_PATTERNS_EN: RegExp[] = [
  /\b(?:i['']?ll|i\s+will)\s+(?:delegate|send|forward|ask|start|run|kick\s+off|create\s+a?\s*job)\b/i,
  /\b(?:i['']?ll|i\s+will)\s+(?:get|have)\s+(?:axel|piper|rex|lex|saga|littlefinger)\s+(?:to\s+)?/i,
  /\bstarting\s+(?:the|a)\s+(?:delegation|chain|job|task)\s+now\b/i,
];

const ALL_PATTERNS = [...DELEGATION_COMMITMENT_PATTERNS_DA, ...DELEGATION_COMMITMENT_PATTERNS_EN];

const FOLLOWTHROUGH_EVIDENCE = [
  /job_id[:\s]+[`'"]/i,
  /create_job\s*\(/i,
  /delegate\s*\(/i,
  /delegate_and_wait\s*\(/i,
  /complete_job\s*\(/i,
  /fail_job\s*\(/i,
  /job\s+oprettet/i,
  /delegeret\s+til/i,
  /kæde.*startet/i,
  /chain.*started/i,
];

export function hasDelegationCommitment(text: string): boolean {
  if (!text?.trim()) {
    return false;
  }
  if (text.includes(UNFULFILLED_DELEGATION_NOTE)) {
    return false;
  }
  return ALL_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasFollowthroughEvidence(allPayloadTexts: string): boolean {
  if (!allPayloadTexts?.trim()) {
    return false;
  }
  return FOLLOWTHROUGH_EVIDENCE.some((pattern) => pattern.test(allPayloadTexts));
}

export function appendUnfulfilledDelegationNote(payloads: ReplyPayload[]): ReplyPayload[] {
  const allText = payloads
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

  if (hasFollowthroughEvidence(allText)) {
    return payloads;
  }

  let appended = false;
  return payloads.map((payload) => {
    if (appended || payload.isError || typeof payload.text !== "string") {
      return payload;
    }
    if (!hasDelegationCommitment(payload.text)) {
      return payload;
    }
    appended = true;
    const trimmed = payload.text.trimEnd();
    return {
      ...payload,
      text: `${trimmed}\n\n${UNFULFILLED_DELEGATION_NOTE}`,
    };
  });
}
