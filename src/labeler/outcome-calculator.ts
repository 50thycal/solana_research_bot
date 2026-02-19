import { SnapshotRow } from '../db/queries/snapshots';

export interface OutcomeMetrics {
  entryPriceSol: number;
  entrySeconds: number;
  entrySnapshotId: number;
  maxPriceSol: number | null;
  maxPriceSeconds: number | null;
  minPriceAfterEntry: number | null;
  finalPriceSol: number | null;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
  finalGainPct: number | null;
  hit2x: boolean;
  timeTo2xSeconds: number | null;
  timeToPeakSeconds: number | null;
}

/**
 * Compute outcome metrics from an entry snapshot and all subsequent snapshots
 * within the outcome window.
 *
 * Post-entry snapshots are those with seconds_since_creation > entry seconds
 * and within outcomeWindowSeconds of entry time. Only snapshots with a non-null
 * price_sol contribute to price metrics.
 *
 * time_to_2x_seconds uses the FIRST snapshot where price >= entry_price * 2,
 * not the max-price snapshot (per spec).
 */
export function calculateOutcomeMetrics(
  entrySnapshot: SnapshotRow,
  allSnapshots: SnapshotRow[],
  outcomeWindowSeconds: number
): OutcomeMetrics {
  const entryPriceSol = entrySnapshot.price_sol!;
  const entrySeconds = entrySnapshot.seconds_since_creation;
  const outcomeEndSeconds = entrySeconds + outcomeWindowSeconds;

  // Snapshots strictly after entry and within the outcome window with a valid price
  const window = allSnapshots.filter(
    s =>
      s.seconds_since_creation > entrySeconds &&
      s.seconds_since_creation <= outcomeEndSeconds &&
      s.price_sol !== null
  );

  if (window.length === 0) {
    return {
      entryPriceSol,
      entrySeconds,
      entrySnapshotId: entrySnapshot.id,
      maxPriceSol: null,
      maxPriceSeconds: null,
      minPriceAfterEntry: null,
      finalPriceSol: null,
      maxGainPct: null,
      maxDrawdownPct: null,
      finalGainPct: null,
      hit2x: false,
      timeTo2xSeconds: null,
      timeToPeakSeconds: null,
    };
  }

  let maxPriceSol = -Infinity;
  let maxPriceSeconds = 0;
  let minPriceAfterEntry = Infinity;
  let timeTo2xSeconds: number | null = null;

  for (const snap of window) {
    const price = snap.price_sol!;

    if (price > maxPriceSol) {
      maxPriceSol = price;
      maxPriceSeconds = snap.seconds_since_creation;
    }

    if (price < minPriceAfterEntry) {
      minPriceAfterEntry = price;
    }

    // Record the first snapshot that hits 2x — not the max-price snapshot
    if (timeTo2xSeconds === null && price >= entryPriceSol * 2) {
      timeTo2xSeconds = snap.seconds_since_creation - entrySeconds;
    }
  }

  const finalPriceSol = window[window.length - 1].price_sol!;
  const hit2x = maxPriceSol >= entryPriceSol * 2;

  const maxGainPct = ((maxPriceSol - entryPriceSol) / entryPriceSol) * 100;
  const maxDrawdownPct = ((minPriceAfterEntry - entryPriceSol) / entryPriceSol) * 100;
  const finalGainPct = ((finalPriceSol - entryPriceSol) / entryPriceSol) * 100;
  const timeToPeakSeconds = maxPriceSeconds - entrySeconds;

  return {
    entryPriceSol,
    entrySeconds,
    entrySnapshotId: entrySnapshot.id,
    maxPriceSol,
    maxPriceSeconds,
    minPriceAfterEntry,
    finalPriceSol,
    maxGainPct,
    maxDrawdownPct,
    finalGainPct,
    hit2x,
    timeTo2xSeconds,
    timeToPeakSeconds,
  };
}
