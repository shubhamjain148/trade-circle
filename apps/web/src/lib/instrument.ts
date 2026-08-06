/**
 * INDmoney identifies a US holding by a numeric `investment_code`, and the
 * holdings payload carries no ticker — so for real accounts `symbol` arrives as
 * "120723" and the feed's most prominent column becomes a number nobody in the
 * group recognises. A code is not a name: it fails the one-second read the row
 * exists for.
 *
 * So when the symbol is one of those codes we lead with the instrument's name,
 * shortened to the part a person would actually say out loud, and drop the code
 * entirely — the full name still sits on the line below, and nobody here trades
 * by investment_code.
 *
 * Real tickers (NVDA, AAPL — the seeds, the tests, and any source that does
 * supply one) are untouched, and keep the monospace a ticker earns.
 *
 * Presentation only: the server's wire shape is unchanged.
 */

/** "120723", "INDS0001234" — never "NVDA", never "BRK.B". */
const CODE_LIKE = /^(?:\d{3,}|INDS[A-Za-z0-9]*)$/

/** Trailing share-class boilerplate; says nothing at a glance. */
const SHARE_CLASS_NOISE = /\s+(?:Common|Capital|Ordinary)\s+(?:Stock|Shares)$/i

/**
 * NASDAQ-style fund names repeat the issuer through the trust: "Invesco
 * Exchange-Traded Fund Trust II Invesco NASDAQ 100 ETF". The fund's own name is
 * the tail — greedy on purpose, so the *last* Trust/Fund is the seam.
 */
const FUND_TRUST_PREFIX = /^.*\b(?:Trust|Funds?)\b(?:\s+[IVXL]+)?\s+(?=\S)/i

/**
 * Corporate suffixes, at the end or immediately before a share class — so
 * "Alphabet Inc. Class A" keeps the Class A that distinguishes it from Class C.
 */
const CORPORATE_SUFFIX =
  /,?\s+(?:Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|plc|PLC|N\.V|S\.A|AG|SE)\.?(?=\s+Class\b|$)/gi

export interface InstrumentLabel {
  /** What leads the row. */
  primary: string
  /** The full name, or null when it would only repeat `primary`. */
  detail: string | null
  /** True when `primary` is a real ticker and belongs in monospace. */
  isTicker: boolean
}

export function isInstrumentCode(symbol: string): boolean {
  return CODE_LIKE.test(symbol.trim())
}

/** "Amazon.com, Inc. Common Stock" -> "Amazon.com" */
export function compactInstrumentName(name: string): string {
  let value = name.trim().replace(SHARE_CLASS_NOISE, "")

  // Only unwrap a trust when there's a real fund name left on the other side.
  const unwrapped = value.replace(FUND_TRUST_PREFIX, "")
  if (unwrapped.length >= 3) value = unwrapped

  return value.replace(CORPORATE_SUFFIX, "").replace(/[\s,]+$/, "").trim()
}

/**
 * Words the compact label is allowed to have dropped without owing the reader a
 * second line. Everything here is registrar boilerplate — if that is all the
 * full name adds, printing it under the label is a wider row, not a disclosure.
 */
const BOILERPLATE = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "plc",
  "nv",
  "sa",
  "ag",
  "se",
  "common",
  "capital",
  "ordinary",
  "stock",
  "shares",
  "class",
  "fund",
  "funds",
  "trust",
  "exchange",
  "traded",
  "the",
  "of",
  "and",
  "i",
  "ii",
  "iii",
  "iv",
  "v",
])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\./g, "")
    .split(/[^a-z0-9&]+/)
    .filter(Boolean)
}

/** True when the full name still carries a word the label doesn't imply. */
function addsSomething(name: string, compact: string): boolean {
  const known = new Set(words(compact))
  return words(name).some(
    (word) => !known.has(word) && !BOILERPLATE.has(word)
  )
}

export function instrumentLabel(
  symbol: string,
  instrumentName: string
): InstrumentLabel {
  const name = instrumentName.trim()

  if (!isInstrumentCode(symbol)) {
    return { primary: symbol, detail: name || null, isTicker: true }
  }

  const compact = compactInstrumentName(name)

  // No usable name either: the code is all we have, and an empty column is
  // worse than an unfamiliar one.
  if (!compact) return { primary: symbol, detail: null, isTicker: true }

  return {
    primary: compact,
    detail: addsSomething(name, compact) ? name : null,
    isTicker: false,
  }
}
