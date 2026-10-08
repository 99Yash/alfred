/**
 * Detects the "AI-writing" tells `DEFAULT_VOICE_PROMPT` forbids. Only rules with few false
 * positives on short replies; adapted from https://github.com/conorbronsdon/avoid-ai-writing.
 * The eval `voice-ai-tells.eval.ts` scores with it. Keep it in step with the prompt.
 */

type VoiceTellSeverity = "high" | "medium" | "low";

export interface VoiceTell {
  /** For example `inflated-word`. */
  ruleId: string;
  category: string;
  severity: VoiceTellSeverity;
  match: string;
  /** Offset into the normalized text, with code and quotes removed. */
  index: number;
}

export interface DetectOptions {
  /** Pass `true` when the user wrote emoji, because chat may mirror them. */
  allowEmoji?: boolean;
}

interface Rule {
  ruleId: string;
  category: string;
  severity: VoiceTellSeverity;
  pattern: RegExp;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word match for any of `words`. */
function wordRule(
  ruleId: string,
  category: string,
  severity: VoiceTellSeverity,
  words: readonly string[],
): Rule {
  const alt = words.map(escapeRegExp).join("|");

  return { ruleId, category, severity, pattern: new RegExp(`\\b(?:${alt})\\b`, "gi") };
}

// Inflated words. Use the plain word.
const INFLATED_WORDS = [
  "utilize",
  "utilizes",
  "utilized",
  "utilizing",
  "utilise",
  "utilises",
  "utilised",
  "utilising",
  "commence",
  "commences",
  "commenced",
  "commencing",
  "seamless",
  "seamlessly",
  "endeavor",
  "endeavors",
  "endeavored",
  "endeavoring",
  "endeavour",
  "endeavours",
  "endeavoured",
  "endeavouring",
  "delve",
  "delves",
  "delved",
  "delving",
  "myriad",
  "plethora",
] as const;

// Non-substantive padding.
const FILLER_PHRASES = [
  "in order to",
  "due to the fact that",
  "a wide range of",
  "needless to say",
  "it is worth noting",
  "it's worth noting",
] as const;

// Flattery and chatbot service language.
const FLATTERY_PHRASES = [
  "you're absolutely right",
  "you are absolutely right",
  "i hope this helps",
  "hope that helps",
  "let me know if you",
  "feel free to",
  "happy to help",
  "glad to help",
  "my pleasure",
] as const;

// "Let's ..." before the point.
const LETS_CONSTRUCTIONS = [
  "let's dive in",
  "let's dive into",
  "let's break it down",
  "let's break this down",
  "let's explore",
  "let's take a look",
  "let's get started",
  "let's unpack",
] as const;

// Hype.
const HYPE_PHRASES = [
  "game-changer",
  "game changer",
  "cutting-edge",
  "cutting edge",
  "state-of-the-art",
  "revolutionary",
  "groundbreaking",
  "supercharge",
  "supercharges",
  "supercharged",
  "powerhouse",
  "vibrant",
  "nestled",
  "bustling",
  "thriving",
  "watershed",
  "paradigm shift",
  "paradigm-shift",
  "unlock the power",
  "unleash the power",
  "take it to the next level",
  "elevate your",
] as const;

// Closers that say nothing.
const GENERIC_CONCLUSIONS = [
  "the future looks bright",
  "only time will tell",
  "the possibilities are endless",
  "at the end of the day",
  "in today's fast-paced world",
  "ever-evolving landscape",
  "the sky's the limit",
] as const;

const RULES: readonly Rule[] = [
  wordRule("inflated-word", "Inflated vocabulary", "medium", INFLATED_WORDS),
  wordRule("filler", "Filler phrase", "medium", FILLER_PHRASES),
  wordRule("flattery", "Flattery / chatbot filler", "high", FLATTERY_PHRASES),
  wordRule("lets-construction", '"Let\'s" opener', "medium", LETS_CONSTRUCTIONS),
  wordRule("hype", "Hype / significance inflation", "medium", HYPE_PHRASES),
  wordRule("generic-conclusion", "Generic conclusion", "medium", GENERIC_CONCLUSIONS),
  // Chatbot openers, only at the start of a line.
  {
    ruleId: "chatbot-opener",
    category: "Chatbot opener",
    severity: "high",
    pattern:
      /^[ \t>*_-]*(certainly|absolutely|of course|sure thing|great question|good question|excellent question|great choice|great point|excellent point)\b/gim,
  },
  // "It's not X, it's Y" in one sentence.
  {
    ruleId: "false-concession",
    category: "\"It's not X, it's Y\"",
    severity: "medium",
    pattern: /it'?s not\b[^.?!\n]{2,80}?\bit'?s\b/gi,
  },
  // A rhetorical question as an opener.
  {
    ruleId: "rhetorical-opener",
    category: "Rhetorical-question opener",
    severity: "low",
    pattern: /^[ \t>*_-]*(what if|ever wondered|have you ever wondered)\b[^\n]*\?/gim,
  },
  // Em dash, spaced en dash, or double hyphen used as a dash.
  {
    ruleId: "em-dash",
    category: "Em-dash",
    severity: "high",
    pattern: /—|\s–\s|\s--\s|\w--\w/g,
  },
];

// Common emoji blocks, regional indicators, and VS-16.
const EMOJI_PATTERN =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]\u{FE0F}?/gu;

/** Remove code and quoted text. Quoted source is evidence, not Alfred's voice. */
function normalize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

/** Detect AI-writing tells in a piece of user-facing prose. */
export function detectAiTells(text: string, options: DetectOptions = {}): VoiceTell[] {
  const cleaned = normalize(text);
  const tells: VoiceTell[] = [];
  const seen = new Set<string>();

  const push = (
    ruleId: string,
    category: string,
    severity: VoiceTellSeverity,
    match: string,
    index: number,
  ) => {
    const key = `${ruleId}:${match.trim().toLowerCase()}`;

    if (seen.has(key)) return;
    seen.add(key);
    tells.push({ ruleId, category, severity, match: match.trim(), index });
  };

  for (const rule of RULES) {
    for (const m of cleaned.matchAll(rule.pattern)) {
      push(rule.ruleId, rule.category, rule.severity, m[0], m.index ?? 0);
    }
  }

  if (!options.allowEmoji) {
    for (const m of cleaned.matchAll(EMOJI_PATTERN)) {
      push("emoji", "Emoji", "low", m[0], m.index ?? 0);
    }
  }

  return tells.sort((a, b) => a.index - b.index);
}

/** One-line summary of findings, for eval metadata / logs. */
export function summarizeTells(tells: readonly VoiceTell[]): string {
  if (tells.length === 0) return "clean";

  return tells.map((t) => `${t.ruleId}("${t.match}")`).join(", ");
}
