/**
 * Social-mode (sweepstakes) text replacements.
 *
 * Stake's social-casino jurisdiction (stake.us) prohibits gambling
 * vocabulary in player-facing text. The bridge sets
 * `INIT.config.socialMode = true` when the operator sends
 * `?social=true` (or jurisdiction.socialCasino is on), and games are
 * expected to feed every user-visible string through
 * `applySocialReplacements()` before rendering.
 *
 * Source dictionary: https://stake-engine.com/docs/reference/social-mode
 *
 * The bridge applies replacements case-insensitively and preserves
 * the casing of the matched word ('Bet' → 'Play', 'BET' → 'PLAY',
 * 'bet' → 'play'). Phrase rules (e.g. 'bonus buy' → 'bonus / feature')
 * are sorted by length descending so that longer phrases match before
 * their substrings.
 *
 * The doc explicitly states that when `social=true` games should
 * render English regardless of `lang`. Other languages are not
 * required to honour these replacements.
 */

export interface SocialReplacementRule {
  /** Source text (case-insensitive whole-word match by default). */
  from: string;
  /** Replacement text. */
  to: string;
  /** Whole-word match toggle. Default: `true`. */
  wholeWord?: boolean;
}

/**
 * Canonical replacement rules from the Stake social-mode doc. Order
 * here is the doc order; runtime application sorts by `from.length`
 * descending so multi-word rules (e.g. "bonus buy") match before
 * single-word rules (e.g. "buy").
 */
export const SOCIAL_REPLACEMENTS: SocialReplacementRule[] = [
  { from: 'bet', to: 'play' },
  { from: 'bets', to: 'plays' },
  { from: 'bet/s', to: 'play/s' },
  { from: 'betting', to: 'playing' },
  { from: 'bonus buy', to: 'bonus / feature' },
  { from: 'bought', to: 'instantly triggered' },
  { from: 'buy', to: 'play' },
  { from: 'buy bonus', to: 'get bonus' },
  { from: 'cash', to: 'coins' },
  { from: 'cost of', to: 'can be played for' },
  { from: 'at the cost of', to: 'for' },
  { from: 'credit', to: 'coins' },
  { from: 'currency', to: 'token' },
  { from: 'deposit', to: 'get coins' },
  { from: 'gamble', to: 'play' },
  { from: 'loss limit', to: 'stop limit' },
  { from: 'loss streak', to: 'miss streak' },
  { from: 'money', to: 'coins' },
  { from: 'paid', to: 'won' },
  { from: 'paid out', to: 'won' },
  { from: 'pay', to: 'win' },
  { from: 'pay out', to: 'win / won' },
  { from: 'pay table', to: 'win table' },
  { from: 'payer', to: 'winner' },
  { from: 'pays', to: 'wins' },
  { from: 'pays out', to: 'win' },
  { from: 'place your bets', to: 'come and play / join in the game' },
  { from: 'profit', to: 'net gain' },
  { from: 'purchase', to: 'play' },
  { from: 'rebet', to: 'respin' },
  { from: 'stake', to: 'play amount' },
  { from: 'total bet', to: 'total play' },
  { from: 'wager', to: 'play' },
  { from: 'win feature', to: 'play feature' },
  { from: 'withdraw', to: 'redeem' },
  {
    from: "be awarded to player's accounts",
    to: "appear in player's accounts",
  },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply the social-mode replacement rules to `text`.
 *
 * Rules are auto-sorted by `from.length` descending so multi-word
 * phrases match before any of their substrings. Casing is preserved:
 * `Bet` → `Play`, `BET` → `PLAY`, `bet` → `play`.
 */
export function applySocialReplacements(
  text: string,
  rules: SocialReplacementRule[] = SOCIAL_REPLACEMENTS,
): string {
  // Defensive copy + sort by length descending so longer phrases win.
  const sorted = [...rules].sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const rule of sorted) {
    const wholeWord = rule.wholeWord ?? true;
    const pattern = wholeWord
      ? new RegExp(`\\b${escapeRegex(rule.from)}\\b`, 'gi')
      : new RegExp(escapeRegex(rule.from), 'gi');
    out = out.replace(pattern, (match) => preserveCase(match, rule.to));
  }
  return out;
}

function preserveCase(source: string, target: string): string {
  if (source.toUpperCase() === source && /[A-Z]/.test(source)) {
    return target.toUpperCase();
  }
  if (source[0] === source[0]?.toUpperCase()) {
    return target[0]?.toUpperCase() + target.slice(1);
  }
  return target.toLowerCase();
}
