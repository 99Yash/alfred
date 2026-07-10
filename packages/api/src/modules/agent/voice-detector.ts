/**
 * A zero-dependency detector for the "AI-writing" tells that `voice.ts` tells
 * the models to avoid. It is the machine-checkable slice of that prompt — the
 * rules with a low false-positive rate on short assistant prose — adapted from
 * https://github.com/conorbronsdon/avoid-ai-writing. Stylometric checks (TTR,
 * burstiness) and judgment calls (copula avoidance, promotional tone) are left
 * out on purpose: they need reading for meaning, and they misfire on the short,
 * tool-grounded replies Alfred actually produces.
 *
 * The eval lane runs this as a deterministic scorer over generated chat prose
 * (`evals/voice-ai-tells.eval.ts`) so the voice rules can't quietly rot out of
 * the prompt. Keep the rule set in step with `DEFAULT_VOICE_PROMPT`.
 *
 * Pure and side-effect free — safe to import anywhere.
 */

export type VoiceTellSeverity = "high" | "medium" | "low";

export interface VoiceTell {
  /** Stable rule identifier, e.g. `inflated-word`. */
  ruleId: string;
  /** Human-facing grouping for the finding. */
  category: string;
  severity: VoiceTellSeverity;
  /** The exact offending substring. */
  match: string;
  /** Offset into the normalized text (code + smart quotes stripped). */
  index: number;
}

export interface DetectOptions {
  /**
   * Skip the emoji rule. Chat may mirror a user who writes with emoji, so a
   * caller scoring live chat where the user used emoji should pass `true`.
   * The briefing (no user turn) and the default both flag emoji.
   */
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

/** `\b(word|word)\b`, case-insensitive, global — for whole-word / phrase lists. */
function wordRule(
  ruleId: string,
  category: string,
  severity: VoiceTellSeverity,
  words: readonly string[],
): Rule {
  const alt = words.map(escapeRegExp).join("|");
  return { ruleId, category, severity, pattern: new RegExp(`\\b(?:${alt})\\b`, "gi") };
}

// Inflated vocabulary — say the plain word. (Tier 1 of the source table.)
const INFLATED_WORDS = [
  "leverage",
  "leverages",
  "leveraged",
  "leveraging",
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
  "robust",
  "seamless",
  "seamlessly",
  "streamline",
  "streamlines",
  "streamlined",
  "streamlining",
  "facilitate",
  "facilitates",
  "facilitated",
  "facilitating",
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

// Flattery / chatbot service language that can appear anywhere in a reply.
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

// "Let's ..." throat-clearing before getting to the point.
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

// Hype / significance inflation.
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

// Formulaic closers that say nothing.
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
  wordRule("lets-construction", "\"Let's\" opener", "medium", LETS_CONSTRUCTIONS),
  wordRule("hype", "Hype / significance inflation", "medium", HYPE_PHRASES),
  wordRule("generic-conclusion", "Generic conclusion", "medium", GENERIC_CONCLUSIONS),
  // Chatbot openers, only when they actually open a line.
  {
    ruleId: "chatbot-opener",
    category: "Chatbot opener",
    severity: "high",
    pattern:
      /^[ \t>*_-]*(certainly|absolutely|of course|sure thing|great question|good question|excellent question|great choice|great point|excellent point)\b/gim,
  },
  // "It's not X, it's Y" false concession, within a single sentence.
  {
    ruleId: "false-concession",
    category: "\"It's not X, it's Y\"",
    severity: "medium",
    pattern: /it'?s not\b[^.?!\n]{2,80}?\bit'?s\b/gi,
  },
  // Rhetorical question as an opener.
  {
    ruleId: "rhetorical-opener",
    category: "Rhetorical-question opener",
    severity: "low",
    pattern: /^[ \t>*_-]*(what if|ever wondered|have you ever wondered)\b[^\n]*\?/gim,
  },
  // Em-dash, spaced en-dash, or double-hyphen used as a dash.
  {
    ruleId: "em-dash",
    category: "Em-dash",
    severity: "high",
    pattern: /—|\s–\s|\s--\s|\w--\w/g,
  },
];

// Common emoji blocks: pictographs, emoticons, transport, dingbats, misc
// symbols, geometric/arrow stars, regional indicators, and VS-16.
const EMOJI_PATTERN =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]\u{FE0F}?/gu;

/**
 * Strip fenced code blocks, inline code, and normalize smart quotes so the
 * rules run against prose only — a `--flag` or `utilize()` inside a code sample
 * is not an AI tell.
 */
function normalize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
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
