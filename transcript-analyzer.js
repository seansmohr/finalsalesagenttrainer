// Server-side transcript analysis — infers violation type from conversation content
// when the <<VIOLATION>> marker was not captured from the voice AI.

const SECTION_NAMES = {
  1: "Scheduled Call Opening", 2: "Webinar Question Loop", 3: "Needs Assessment Permission",
  4: "Client Profile Discovery", 5: "Current Coverage Cost", 6: "Health History Discovery",
  7: "CHS Exposure Discovery", 8: "Skilled Nursing Exposure", 9: "Part B Premium Qualification",
  10: "Parked Questions Transition", 11: "Level 1 Education", 12: "Level 2 Education",
  13: "Level 3 Education", 14: "Formal Recommendation", 15: "Objection Handling",
  16: "Enrollment Readiness Check", 17: "Ancillary-First Close",
  18: "Application Consent", 19: "Post-Close Path", 20: "Follow-Up Booking",
};

// Patterns that indicate each section was covered by the agent
const SECTION_SIGNALS = {
  1: /\b(scheduled|catch you at a good time|call scheduled|how are you|good (morning|afternoon|evening))\b/,
  2: /\b(webinar|watch(ed)?|questions? (from|about) (the|it)|takeaway|any other questions)\b/,
  3: /\b(permission|do you mind if i ask|client needs assessment|mind if i ask|my own questions)\b/,
  4: /\b(date of birth|zip code|d\.?o\.?b|birthday|currently working|employer|type of insurance)\b/,
  5: /\b(monthly premium|deductible|out[- ]of[- ]pocket|dental|vision|paying.*month|how much.*insurance)\b/,
  6: /\b(health history|hospital stay|surger|medication|past (5|five) years|anything serious)\b/,
  7: /\b(cancer|heart attack|stroke|family history.*(cancer|heart|stroke)|c\.?h\.?s)\b/,
  8: /\b(skilled nursing|nursing facilit|97[- ]?day|nursing home)\b/,
  9: /\b(part b premium|tax(es)?.*fil(e|ing)|income|single or joint|filed.*single)\b/,
  10: /\b(wraps up|needs assessment|answer.*questions.*earlier|parked questions|refresher|levels? of coverage)\b/,
  11: /\b(part a.*(hospital|free)|part b.*(outpatient|\$202|\$283)|1[,.]?736|medicare foundation)\b/,
  12: /\b(medicare advantage|medicare supplement|advantage vs|supplement vs|copay|network|5[- ]star|premium plan)\b/,
  13: /\b(umbrella coverage|level (3|three)|non[- ]medicare[- ]approved|even with.*(advantage|supplement))\b/,
  14: /\b(formal recommendation|my recommendation|recommend.*plan|based on everything|total benefit|price.*month|\$\d+.*per month)\b/,
};

function analyzeTranscript(transcriptText) {
  if (!transcriptText || transcriptText.length < 50) return null;

  const text = transcriptText.toLowerCase();

  // Determine which sections the agent likely covered
  const coveredSections = new Set();
  for (const [section, pattern] of Object.entries(SECTION_SIGNALS)) {
    if (pattern.test(text)) {
      coveredSections.add(parseInt(section));
    }
  }

  const discoveryComplete = [4, 5, 6, 7, 8, 9].every(s => coveredSections.has(s));
  const educationComplete = [11, 12, 13].every(s => coveredSections.has(s));

  const recommendationPattern = /\b(recommend|recommendation|my.*suggestion|i('d| would) (suggest|recommend)|based on (everything|what)|the (plan|coverage) (i|we) recommend|price.*would be|total benefit)\b/;
  const agentRecommended = recommendationPattern.test(text);

  // PREMATURE_RECOMMENDATION: before discovery
  if (agentRecommended && !discoveryComplete) {
    const missingSections = [4, 5, 6, 7, 8, 9].filter(s => !coveredSections.has(s));
    const lastCovered = Math.max(...([...coveredSections].filter(s => s <= 9)), 1);
    const nextExpected = missingSections.length > 0 ? missingSections[0] : lastCovered + 1;
    return {
      type: "PREMATURE_RECOMMENDATION",
      currentSection: lastCovered,
      expectedSection: Math.min(nextExpected, 9),
      description: `Jumped to recommendation before completing discovery. Missing: ${missingSections.map(s => `S${s} (${SECTION_NAMES[s]})`).join(", ")}`,
    };
  }

  // PREMATURE_RECOMMENDATION: before education
  if (agentRecommended && discoveryComplete && !educationComplete) {
    const missingSections = [11, 12, 13].filter(s => !coveredSections.has(s));
    const lastCovered = Math.max(...([...coveredSections].filter(s => s <= 13)), 10);
    const nextExpected = missingSections.length > 0 ? missingSections[0] : 11;
    return {
      type: "PREMATURE_RECOMMENDATION",
      currentSection: lastCovered,
      expectedSection: nextExpected,
      description: `Jumped to recommendation before completing education. Missing: ${missingSections.map(s => `S${s} (${SECTION_NAMES[s]})`).join(", ")}`,
    };
  }

  // PREMATURE_ENROLLMENT
  const enrollmentPattern = /\b(enroll|sign.*up|application|let('s| us) get (you |this )?(started|going|enrolled)|ready to (get started|move forward))\b/;
  if (enrollmentPattern.test(text) && !educationComplete) {
    const lastCovered = Math.max(...[...coveredSections], 1);
    return {
      type: "PREMATURE_ENROLLMENT",
      currentSection: lastCovered,
      expectedSection: [11, 12, 13].find(s => !coveredSections.has(s)) || 11,
      description: "Tried to move into enrollment before completing education sections (11, 12, 13)",
    };
  }

  // SKIPPED_PERMISSION
  const askedPersonal = coveredSections.has(4) || coveredSections.has(5) || coveredSections.has(6);
  if (askedPersonal && !coveredSections.has(3)) {
    return {
      type: "SKIPPED_PERMISSION",
      currentSection: 2,
      expectedSection: 3,
      description: "Jumped into personal discovery questions without asking permission first (Section 3)",
    };
  }

  // ANSWERED_PARKED_QUESTIONS
  const earlyMedicareExplanation = /\b(medicare (is|works|covers)|part (a|b) (is|covers)|supplement (is|covers|plan)|advantage (is|covers|plan))\b/;
  if (coveredSections.has(2) && !coveredSections.has(10) && !coveredSections.has(11)) {
    const questionLoopEnd = text.indexOf("needs assessment") !== -1 ? text.indexOf("needs assessment") : text.length;
    const earlyText = text.substring(0, Math.min(questionLoopEnd, text.length / 3));
    if (earlyMedicareExplanation.test(earlyText)) {
      return {
        type: "ANSWERED_PARKED_QUESTIONS",
        currentSection: 2,
        expectedSection: 3,
        description: "Answered webinar questions by explaining Medicare concepts instead of parking them for later",
      };
    }
  }

  // SSN_WITHOUT_EXPLANATION
  const ssnPattern = /\b(social security|ssn|social.*number|bank (account|info|routing)|routing number)\b/;
  const ssnExplanationPattern = /\b(reason.*(social|ssn|bank)|why.*(need|ask).*(social|ssn|bank)|(social|ssn|bank).*because|medical records|underwriting|fraud prevention)\b/;
  if (ssnPattern.test(text) && !ssnExplanationPattern.test(text)) {
    return {
      type: "SSN_WITHOUT_EXPLANATION",
      currentSection: 18,
      expectedSection: 18,
      description: "Asked for sensitive information (SSN or bank details) without explaining why first",
    };
  }

  // MAJOR_ORDER_SKIP
  const sortedCovered = [...coveredSections].sort((a, b) => a - b);
  for (let i = 1; i < sortedCovered.length; i++) {
    const gap = sortedCovered[i] - sortedCovered[i - 1];
    if (gap > 2) {
      return {
        type: "MAJOR_ORDER_SKIP",
        currentSection: sortedCovered[i - 1],
        expectedSection: sortedCovered[i - 1] + 1,
        description: `Jumped from S${sortedCovered[i - 1]} (${SECTION_NAMES[sortedCovered[i - 1]] || "Unknown"}) to S${sortedCovered[i]} (${SECTION_NAMES[sortedCovered[i]] || "Unknown"}), skipping ${gap - 1} section(s)`,
      };
    }
  }

  // SKIPPED_MAJOR_SECTION
  if (coveredSections.has(4) && coveredSections.has(9)) {
    const skipped = [5, 6, 7, 8].filter(s => !coveredSections.has(s));
    if (skipped.length > 0) {
      return {
        type: "SKIPPED_MAJOR_SECTION",
        currentSection: skipped[0] - 1,
        expectedSection: skipped[0],
        description: `Skipped S${skipped[0]} (${SECTION_NAMES[skipped[0]] || "Unknown"}) during discovery`,
      };
    }
  }

  // Best-effort: return what sections we detected
  if (sortedCovered.length > 0) {
    const lastSection = sortedCovered[sortedCovered.length - 1];
    const nextExpected = lastSection + 1;
    return {
      type: "SKIPPED_MAJOR_SECTION",
      currentSection: lastSection,
      expectedSection: nextExpected <= 20 ? nextExpected : lastSection,
      description: `Went off-structure around S${lastSection} (${SECTION_NAMES[lastSection] || "Unknown"}). Sections detected: ${sortedCovered.join(", ")}`,
    };
  }

  return null;
}

module.exports = { analyzeTranscript, SECTION_NAMES };
