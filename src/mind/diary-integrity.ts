export interface IntegrityCheckResult {
  suspicious: boolean;
  patterns: string[];
}

interface PatternCategory {
  name: string;
  patterns: RegExp[];
}

const PATTERN_CATEGORIES: PatternCategory[] = [
  {
    name: "instruction_framing",
    patterns: [
      /\byou are (?:a|an) (?:ai|assistant|language model|helpful assistant)\b/i,
      /\byour (?:new )?instructions are\b/i,
      /\bsystem\s*:/i,
      /\bignore (?:all |my )?previous instructions\b/i,
      /\bdo not reveal\b/i,
    ],
  },
  {
    name: "override_language",
    patterns: [
      /\bdisregard\b/i,
      /\bforget everything\b/i,
      /\bnew instructions:/i,
      /\boverride (?:all |any |previous )?instructions\b/i,
    ],
  },
  {
    name: "role_injection",
    patterns: [
      /\bas (?:a|an) (?:ai|language model)\b/i,
      /\byou must always\b/i,
      /\byou are now\b/i,
    ],
  },
  {
    name: "boundary_markers",
    patterns: [
      /```system/i,
      /<<SYS>>/i,
      /\[INST\]/i,
      /<\/?system>/i,
      /\[system\]/i,
    ],
  },
];

export function detectSuspiciousContent(text: string): IntegrityCheckResult {
  if (!text) {
    return { suspicious: false, patterns: [] };
  }

  const matched = new Set<string>();

  for (const category of PATTERN_CATEGORIES) {
    for (const pattern of category.patterns) {
      if (pattern.test(text)) {
        matched.add(category.name);
        break;
      }
    }
  }

  return {
    suspicious: matched.size > 0,
    patterns: [...matched],
  };
}
