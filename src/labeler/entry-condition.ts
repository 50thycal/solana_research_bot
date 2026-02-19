import { SnapshotRow } from '../db/queries/snapshots';

export interface EntryResult {
  triggered: boolean;
  snapshot: SnapshotRow | null;
}

/**
 * Evaluate the parameterized entry condition against a token's ordered snapshots.
 * Returns the first snapshot that satisfies ALL thresholds, or null if none qualifies.
 *
 * Entry conditions (all must be true at the same snapshot):
 *   - buy_count      >= entryMinBuyCount
 *   - unique_buyers  >= entryMinUniqueBuyers
 *   - buy_velocity   >= entryMinBuyVelocity  (buys/sec)
 *   - sell_ratio     <= entryMaxSellRatio     (NULL sell_ratio counts as 0 — no sells)
 *   - price_sol      non-null                 (need a price to anchor outcome metrics)
 *   - seconds_since_creation <= entryMaxSeconds
 */
export function evaluateEntryCondition(
  snapshots: SnapshotRow[],
  entryMaxSeconds: number,
  minBuyCount: number,
  minUniqueBuyers: number,
  minBuyVelocity: number,
  maxSellRatio: number
): EntryResult {
  for (const snap of snapshots) {
    // Stop searching once outside the entry window
    if (snap.seconds_since_creation > entryMaxSeconds) break;

    // Must have a price to anchor outcome metrics
    if (snap.price_sol === null) continue;

    // buy_count threshold
    if (snap.buy_count === null || snap.buy_count < minBuyCount) continue;

    // unique_buyers threshold
    if (snap.unique_buyers === null || snap.unique_buyers < minUniqueBuyers) continue;

    // buy_velocity threshold
    if (snap.buy_velocity === null || snap.buy_velocity < minBuyVelocity) continue;

    // sell_ratio threshold — null means zero sells, which always passes
    const sellRatio = snap.sell_ratio ?? 0;
    if (sellRatio > maxSellRatio) continue;

    // All conditions met
    return { triggered: true, snapshot: snap };
  }

  return { triggered: false, snapshot: null };
}
