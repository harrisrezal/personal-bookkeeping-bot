// Known merchant name variants seen across manual entry, receipt scans, and voice
// messages, mapped to one canonical spelling per merchant. Add new entries here
// as new inconsistent spellings show up in the Transactions sheet.
const MERCHANT_ALIASES = {
  'costco': 'Costco Wholesale',
  'costco wholesale': 'Costco Wholesale',
  'costco gas': 'Costco Gas',
  'target': 'Target',
  "trader joe's": "Trader Joe's",
  'whole foods': 'Whole Foods Market',
  'whole foods market': 'Whole Foods Market',
  'tommy hilfiger': 'Tommy Hilfiger',
  'in-n-out': 'In-N-Out Burger',
  'in-n-out burger': 'In-N-Out Burger',
  'in-n-out burger sunnyvale': 'In-N-Out Burger',
  'ikea': 'IKEA',
  'amc': 'AMC',
  '99 ranch': '99 Ranch Market',
  '99 ranch market': '99 Ranch Market',
  'wee': 'Weee!',
  'wee!': 'Weee!',
  'weee': 'Weee!',
  'weee!': 'Weee!',
  'hunan rice flour': 'Hunan Impression',
  'hunan impression': 'Hunan Impression',
  'dim sum with friends': 'Dim Sum'
};

// Regex-based rules for receipt-scanned strings that carry variable data
// (store numbers, city names) the static alias map can't cover.
const REGEX_RULES = [
  // "AMC 0420 SUNNYVALE 12" -> "AMC Sunnyvale 12"
  { pattern: /^AMC\s+\d+\s+(.+)$/i, replace: (match) => `AMC ${toTitleCase(match[1])}` }
];

function normalizeDescription(rawDescription) {
  const trimmed = String(rawDescription || '').trim();
  if (!trimmed) return trimmed;

  const alias = MERCHANT_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  for (const rule of REGEX_RULES) {
    const match = trimmed.match(rule.pattern);
    if (match) return rule.replace(match);
  }

  // Soft fallback for receipt-scanned merchants not yet in the alias map:
  // shouted-case strings ("WHOLE FOODS MARKET") get title-cased. Acronym
  // brands (IKEA, AMC, ...) should be added above so this fallback never
  // has to guess at them.
  if (isShoutedCase(trimmed)) {
    return toTitleCase(trimmed);
  }

  return trimmed;
}

function isShoutedCase(value) {
  return /[A-Z]/.test(value) && !/[a-z]/.test(value) && value.length > 1;
}

function toTitleCase(value) {
  return value.toLowerCase().replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

module.exports = { normalizeDescription, MERCHANT_ALIASES };
