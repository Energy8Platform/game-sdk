/**
 * Stake-required disclaimer text.
 *
 * Stake's approval team requires every game to render a disclaimer
 * verbatim (or one that covers all 7 mandatory points) somewhere in
 * its info / paytable screen. The bridge surfaces canonical lines via
 * `INIT.config.disclaimerLines` so each game doesn't have to keep
 * its own copy.
 *
 * Source: https://stake-engine.com/docs/approval/disclaimer
 *
 * The 7 required points (must all be present in custom disclaimers):
 *   1. Malfunction clause      — "Malfunction voids all wins and plays."
 *   2. Internet requirement    — "A consistent internet connection is required."
 *   3. Disconnection recovery  — "Reload to finish uncompleted rounds."
 *   4. Expected return         — "RTP calculated over many plays."
 *   5. Display accuracy        — "Display is illustrative, not a physical device."
 *   6. Payout source           — "Winnings are settled by the RGS."
 *   7. Copyright               — "TM and © {year} Stake Engine."
 */

export interface DisclaimerOptions {
  /**
   * Year used in the copyright line. Defaults to the current calendar
   * year; specify explicitly for deterministic output.
   */
  year?: number;
  /**
   * Replace the canonical text with custom lines. The bridge will not
   * mutate these — pass exactly what the game should render.
   */
  override?: string[];
  socialMode?: boolean;
  replayMode?: boolean;
}

function buildDefault(year: number): string[] {
  return [
    'Malfunction voids all wins and plays.',
    'A consistent internet connection is required. In the event of a disconnection, reload the game to finish any uncompleted rounds.',
    'The expected return is calculated over many plays.',
    'The game display is not representative of any physical device and is for illustrative purposes only.',
    'Winnings are settled according to the amount received from the Remote Game Server and not from events within the web browser.',
    `TM and © ${year} Stake Engine.`,
  ];
}

/**
 * Default canonical disclaimer lines, computed for the current
 * calendar year. Equivalent to `buildDisclaimer({})`.
 *
 * The text mirrors Stake's [official template](https://stake-engine.com/docs/approval/disclaimer):
 *
 * > Malfunction voids all wins and plays. A consistent internet
 * > connection is required. In the event of a disconnection, reload
 * > the game to finish any uncompleted rounds. The expected return is
 * > calculated over many plays. The game display is not representative
 * > of any physical device and is for illustrative purposes only.
 * > Winnings are settled according to the amount received from the
 * > Remote Game Server and not from events within the web browser.
 * > TM and © {year} Stake Engine.
 */
export const DEFAULT_DISCLAIMER_LINES: string[] = buildDefault(
  new Date().getFullYear(),
);

/**
 * Build the disclaimer block. Returns `override` verbatim if supplied;
 * otherwise the canonical Stake template with `{year}` substituted.
 *
 * `socialMode` and `replayMode` are accepted for forward compatibility
 * but currently don't change the wording (the canonical template is
 * acceptable in both contexts).
 */
export function buildDisclaimer(opts: DisclaimerOptions = {}): string[] {
  if (opts.override) return [...opts.override];
  const year = opts.year ?? new Date().getFullYear();
  return buildDefault(year);
}
