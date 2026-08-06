// ---------------------------------------------------------------------------
// glossary.js — the plain-English layer (Beginner tier, docs/USER-TIERS.md §4.3).
// A pure, dependency-free lookup: jargon key → a short label + a plain-English
// definition, NEPSE-appropriate and jargon-free. Consumed by the <Term> tooltip
// in the UI. No I/O, no throw — `defineTerm` returns null for anything unknown so
// a mistyped key just renders its children plainly.
// ---------------------------------------------------------------------------

// Canonical term keys → { label (short display), plain (≤ ~160 chars, plain English) }.
export const GLOSSARY = {
  BUY: {
    label: 'BUY',
    plain: 'The agent sees more upside than downside from here. Informational — you decide and place any trade yourself.',
  },
  SELL: {
    label: 'SELL',
    plain: "The agent sees more downside than upside. On NEPSE (no short-selling for retail) this reads as 'consider exiting/avoid', not 'go short'.",
  },
  HOLD: {
    label: 'HOLD',
    plain: 'No strong edge either way right now — the agent is watching, not acting.',
  },
  AVOID: {
    label: 'AVOID',
    plain: 'The agent would stay away from this one for now.',
  },
  confidence: {
    label: 'confidence',
    plain: 'How sure the agent is about the direction — LOW / MEDIUM / HIGH. Not a guarantee; weigh it with the track record.',
  },
  BULLISH: {
    label: 'BULLISH',
    plain: 'Overall market mood is leaning up.',
  },
  BEARISH: {
    label: 'BEARISH',
    plain: 'Overall market mood is leaning down.',
  },
  NEUTRAL: {
    label: 'NEUTRAL',
    plain: 'No clear market direction — mixed or flat.',
  },
  EPS: {
    label: 'EPS',
    plain: "Earnings Per Share — the company's yearly profit divided by its number of shares. Higher generally means more profitable.",
  },
  PE: {
    label: 'P/E',
    plain: "Price-to-Earnings — the share price divided by EPS. Roughly 'rupees paid per rupee of yearly profit'; very high can mean expensive.",
  },
  BV: {
    label: 'Book Value',
    plain: "Book Value per share — the company's net worth (assets minus liabilities) per share, from its accounts.",
  },
  PBV: {
    label: 'P/BV',
    plain: 'Price-to-Book — share price divided by book value. Below 1 means trading under accounting net worth.',
  },
  dividend: {
    label: 'dividend',
    plain: 'The cash (and/or bonus shares) a company pays out to shareholders from profit, quoted as a % of the Rs 100 par value on NEPSE.',
  },
  yield: {
    label: 'yield',
    plain: 'Dividend Yield — the yearly cash dividend as a % of the current share price — the income return if the price stays flat.',
  },
  week52: {
    label: '52-week range',
    plain: 'The highest and lowest price the share traded at over the last 52 weeks — a sense of its range.',
  },
  target: {
    label: 'target',
    plain: "The price level where the agent's thesis would be 'right' — an informational objective, not an order.",
  },
  stop: {
    label: 'stop-loss',
    plain: "Stop-loss — the price where the thesis is 'wrong' and you'd typically cut the loss. Risk management, not a placed order.",
  },
  entry: {
    label: 'entry',
    plain: 'The suggested price zone to act in if you agree with the idea.',
  },
  gross: {
    label: 'gross',
    plain: 'Gross return — the raw price move, before any costs.',
  },
  net: {
    label: 'net',
    plain: "Net return — what you'd actually keep after NEPSE charges (broker commission, SEBON, DP) and capital-gains tax. The honest number.",
  },
  CGT: {
    label: 'CGT',
    plain: 'Capital Gains Tax on profits when you sell — 7.5% if held under a year, 5% if a year or more (NEPSE).',
  },
  winRate: {
    label: 'win rate',
    plain: 'Share of resolved calls that hit their target vs. their stop — the track record, losses included.',
  },
  conservative: {
    label: 'conservative',
    plain: "A cautious, small-sample-adjusted win rate (statistical lower bound): with few trades it's pulled down until more results confirm it.",
  },
  turnover: {
    label: 'turnover',
    plain: 'The rupee value traded in a day — a liquidity gauge. Thin turnover means an order can move the price and be hard to exit.',
  },
  illiquid: {
    label: 'illiquid',
    plain: 'Thinly traded — few buyers/sellers, so getting in or out cleanly is hard. Higher risk for a retail order.',
  },
  watchlist: {
    label: 'watchlist',
    plain: 'The symbols you (or the curated system list) are tracking — the agent scans these plus daily discovery.',
  },
  paper: {
    label: 'paper trading',
    plain: 'A risk-free simulated account: practice buying/selling with virtual money at the real live price. Not real trading.',
  },
  discovery: {
    label: 'discovery',
    plain: "The agent's own scan of the day's movers to surface fresh candidates beyond your watchlist.",
  },
};

// Normalize any input to a comparable token: lowercase, strip everything that
// isn't a letter or digit ('P/E' → 'pe', 'Stop Loss' → 'stoploss', '52-week' → '52week').
function normalize(key) {
  return String(key == null ? '' : key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Synonym/alias → canonical GLOSSARY key. Every canonical key's own normalized
// form is added automatically below, so only true aliases live here.
const ALIASES = {
  conf: 'confidence',
  bull: 'BULLISH',
  bear: 'BEARISH',
  pe: 'PE',
  peratio: 'PE',
  priceearnings: 'PE',
  bookvalue: 'BV',
  book: 'BV',
  pbv: 'PBV',
  pricetobook: 'PBV',
  pricebook: 'PBV',
  div: 'dividend',
  dividendyield: 'yield',
  divyield: 'yield',
  week52: 'week52',
  '52week': 'week52',
  '52weekrange': 'week52',
  '52w': 'week52',
  '52wh': 'week52',
  '52wl': 'week52',
  tgt: 'target',
  sl: 'stop',
  stop: 'stop',
  stoploss: 'stop',
  netreturn: 'net',
  grossreturn: 'gross',
  capitalgainstax: 'CGT',
  capitalgains: 'CGT',
  winrate: 'winRate',
  winpercent: 'winRate',
  turnover: 'turnover',
  illiquidity: 'illiquid',
  watch: 'watchlist',
  simulated: 'paper',
  papertrading: 'paper',
  papertrade: 'paper',
  discovered: 'discovery',
  discover: 'discovery',
};

// Build the full normalized-token → canonical-key resolution table once.
const RESOLVE = {};
for (const key of Object.keys(GLOSSARY)) RESOLVE[normalize(key)] = key;
for (const alias of Object.keys(ALIASES)) RESOLVE[normalize(alias)] = ALIASES[alias];

// defineTerm(key): case-insensitive, alias-tolerant lookup. Returns
// { key, label, plain } for a known term, or null for anything unknown. Never throws.
export function defineTerm(key) {
  const token = normalize(key);
  if (!token) return null;
  const canonical = RESOLVE[token];
  if (!canonical) return null;
  const entry = GLOSSARY[canonical];
  return { key: canonical, label: entry.label, plain: entry.plain };
}
