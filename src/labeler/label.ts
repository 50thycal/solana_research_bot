import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config, configSnapshot } from '../config';
import {
  insertRun,
  completeRun,
  failRun,
  getCompletedCollectRuns,
  getRun,
} from '../db/queries/runs';
import { getMintsWithSnapshots, getSnapshotsForToken } from '../db/queries/snapshots';
import { insertOutcome, deleteOutcomesForCollectRun } from '../db/queries/outcomes';
import { evaluateEntryCondition } from './entry-condition';
import { calculateOutcomeMetrics } from './outcome-calculator';

/**
 * Run the label mode.
 * Reads snapshots from completed collect runs, applies the parameterized entry
 * condition, computes outcome metrics, and writes results to the outcomes table.
 * Safe to re-run — existing outcomes for the target runs are cleared first.
 */
export async function runLabel(db: Database.Database): Promise<void> {
  const labelRunId = uuidv4();

  // Create the label run record
  insertRun(db, labelRunId, 'label', configSnapshot());

  console.log(JSON.stringify({
    event: 'label_init',
    labelRunId,
    targetRunId: config.labelRunId,
    entryMinBuyCount: config.entryMinBuyCount,
    entryMinUniqueBuyers: config.entryMinUniqueBuyers,
    entryMinBuyVelocity: config.entryMinBuyVelocity,
    entryMaxSellRatio: config.entryMaxSellRatio,
    entryMaxSeconds: config.entryMaxSeconds,
    outcomeWindowSeconds: config.outcomeWindowSeconds,
  }));

  try {
    // Resolve which collect runs to label
    let collectRunIds: string[];

    if (config.labelRunId === 'all') {
      const runs = getCompletedCollectRuns(db);
      collectRunIds = runs.map(r => r.run_id);
      console.log(JSON.stringify({
        event: 'label_target_runs',
        labelRunId,
        collectRunCount: collectRunIds.length,
      }));
    } else {
      const run = getRun(db, config.labelRunId);
      if (!run) {
        throw new Error(`Collect run not found: ${config.labelRunId}`);
      }
      if (run.mode !== 'collect') {
        throw new Error(
          `Run ${config.labelRunId} is mode '${run.mode}', expected 'collect'`
        );
      }
      collectRunIds = [config.labelRunId];
    }

    if (collectRunIds.length === 0) {
      console.log(JSON.stringify({
        event: 'label_no_runs',
        labelRunId,
        message: 'No completed collect runs to label',
      }));
      completeRun(db, labelRunId, 0, 0);
      return;
    }

    const entryConfigJson = JSON.stringify({
      entryMinBuyCount: config.entryMinBuyCount,
      entryMinUniqueBuyers: config.entryMinUniqueBuyers,
      entryMinBuyVelocity: config.entryMinBuyVelocity,
      entryMaxSellRatio: config.entryMaxSellRatio,
      entryMaxSeconds: config.entryMaxSeconds,
      outcomeWindowSeconds: config.outcomeWindowSeconds,
    });

    let totalTokensProcessed = 0;
    let totalEntriesTriggered = 0;

    for (const collectRunId of collectRunIds) {
      // Clear any prior outcomes for this collect run to allow re-labeling
      const deleted = deleteOutcomesForCollectRun(db, collectRunId);
      if (deleted > 0) {
        console.log(JSON.stringify({
          event: 'label_cleared_previous',
          labelRunId,
          collectRunId,
          rowsDeleted: deleted,
        }));
      }

      const mints = getMintsWithSnapshots(db, collectRunId);
      let runEntriesTriggered = 0;

      for (const mint of mints) {
        const snapshots = getSnapshotsForToken(db, mint, collectRunId);
        if (snapshots.length === 0) continue;

        const entry = evaluateEntryCondition(
          snapshots,
          config.entryMaxSeconds,
          config.entryMinBuyCount,
          config.entryMinUniqueBuyers,
          config.entryMinBuyVelocity,
          config.entryMaxSellRatio
        );

        if (entry.triggered && entry.snapshot) {
          const metrics = calculateOutcomeMetrics(
            entry.snapshot,
            snapshots,
            config.outcomeWindowSeconds
          );

          insertOutcome(db, {
            mint,
            labelRunId,
            collectRunId,
            entryTriggered: 1,
            entryPriceSol: metrics.entryPriceSol,
            entrySeconds: metrics.entrySeconds,
            entrySnapshotId: metrics.entrySnapshotId,
            maxPriceSol: metrics.maxPriceSol,
            maxPriceSeconds: metrics.maxPriceSeconds,
            minPriceAfterEntry: metrics.minPriceAfterEntry,
            finalPriceSol: metrics.finalPriceSol,
            maxGainPct: metrics.maxGainPct,
            maxDrawdownPct: metrics.maxDrawdownPct,
            finalGainPct: metrics.finalGainPct,
            hit2x: metrics.hit2x ? 1 : 0,
            timeTo2xSeconds: metrics.timeTo2xSeconds,
            timeToPeakSeconds: metrics.timeToPeakSeconds,
            entryConfigJson,
          });

          runEntriesTriggered++;
        } else {
          // No entry triggered — record the absence of entry (still useful data)
          insertOutcome(db, {
            mint,
            labelRunId,
            collectRunId,
            entryTriggered: 0,
            entryPriceSol: null,
            entrySeconds: null,
            entrySnapshotId: null,
            maxPriceSol: null,
            maxPriceSeconds: null,
            minPriceAfterEntry: null,
            finalPriceSol: null,
            maxGainPct: null,
            maxDrawdownPct: null,
            finalGainPct: null,
            hit2x: null,
            timeTo2xSeconds: null,
            timeToPeakSeconds: null,
            entryConfigJson,
          });
        }

        totalTokensProcessed++;
      }

      totalEntriesTriggered += runEntriesTriggered;

      console.log(JSON.stringify({
        event: 'label_collect_run_done',
        labelRunId,
        collectRunId,
        mintsProcessed: mints.length,
        entriesTriggered: runEntriesTriggered,
        entryRate: mints.length > 0
          ? (runEntriesTriggered / mints.length * 100).toFixed(1) + '%'
          : '0%',
      }));
    }

    completeRun(db, labelRunId, totalTokensProcessed, totalEntriesTriggered);

    console.log(JSON.stringify({
      event: 'label_complete',
      labelRunId,
      collectRunsProcessed: collectRunIds.length,
      totalTokensProcessed,
      totalEntriesTriggered,
      entryRate: totalTokensProcessed > 0
        ? (totalEntriesTriggered / totalTokensProcessed * 100).toFixed(1) + '%'
        : '0%',
    }));
  } catch (err) {
    failRun(db, labelRunId);

    console.error(JSON.stringify({
      event: 'label_error',
      labelRunId,
      error: err instanceof Error ? err.message : String(err),
    }));

    throw err;
  }
}
