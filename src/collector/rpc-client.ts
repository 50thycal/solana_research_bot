import { Connection, PublicKey, AccountInfo, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { deserializeBondingCurve, decodeBondingCurve, BondingCurveDecoded } from '../pumpfun/bonding-curve';
import { parseCreateFromAccountsAndData, PumpfunCreateEvent } from '../pumpfun/parse-create';
import { PUMP_FUN_PROGRAM_ID } from '../pumpfun/constants';
import { config } from '../config';
import { log, logError } from '../logger';

const PER_CALL_DELAY_MS = 50;
const BATCH_SIZE = 100; // max accounts per getMultipleAccounts call

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * RPC client wrapping @solana/web3.js Connection with rate limiting.
 */
export class RpcClient {
  private conn: Connection;

  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Fetch a single transaction by signature to extract Create event details.
   * Used to enrich WebSocket-detected Create events with full account data.
   */
  async fetchCreateTransaction(signature: string): Promise<PumpfunCreateEvent | null> {
    await sleep(PER_CALL_DELAY_MS);

    try {
      const tx = await this.conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.meta || tx.meta.err) return null;

      const message = tx.transaction.message;
      const accountKeys = message.staticAccountKeys
        ? message.staticAccountKeys.map((k: PublicKey) => k.toBase58())
        : (message as any).accountKeys?.map((k: PublicKey) => k.toBase58()) ?? [];

      // Also include lookup table keys if present
      if (tx.meta.loadedAddresses) {
        accountKeys.push(
          ...tx.meta.loadedAddresses.writable.map((k: PublicKey) => k.toBase58()),
          ...tx.meta.loadedAddresses.readonly.map((k: PublicKey) => k.toBase58()),
        );
      }

      // Find the pump.fun Create instruction — check both top-level and inner (CPI) instructions.
      // Pump.fun Create is often invoked via CPI through wrapper programs like proVF4...
      const compiledInstructions = message.compiledInstructions
        ?? (message as any).instructions
        ?? [];

      const pumpProgramId = PUMP_FUN_PROGRAM_ID.toBase58();

      // Helper to try parsing a pump.fun instruction
      const tryParse = (ix: any): PumpfunCreateEvent | null => {
        const programIdIndex = ix.programIdIndex;
        if (accountKeys[programIdIndex] !== pumpProgramId) return null;

        const data = Buffer.from(ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, 'base64'));
        const accountIndices: number[] = ix.accountKeyIndexes ?? (ix as any).accounts ?? [];

        return parseCreateFromAccountsAndData(
          accountKeys,
          programIdIndex,
          accountIndices,
          data,
          tx.blockTime ?? undefined
        );
      };

      // 1. Check top-level instructions
      for (const ix of compiledInstructions) {
        const parsed = tryParse(ix);
        if (parsed) return parsed;
      }

      // 2. Check inner instructions (CPI) — this is where pump.fun Create often lives
      const innerInstructions = tx.meta.innerInstructions ?? [];
      for (const inner of innerInstructions) {
        for (const ix of (inner.instructions ?? [])) {
          const parsed = tryParse(ix);
          if (parsed) return parsed;
        }
      }

      log({
        event: 'rpc_resolve_debug',
        signature,
        reason: 'no_pumpfun_create_found',
        topLevelIxCount: compiledInstructions.length,
        innerIxGroups: innerInstructions.length,
      });

      return null;
    } catch (err) {
      logError({
        event: 'rpc_fetch_create_error',
        signature,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Batch-fetch bonding curve account states using getMultipleAccounts.
   * Handles batching into groups of 100 as per Solana limits.
   * Returns a Map from PDA address → decoded state (or null if account not found).
   */
  async fetchBondingCurves(pdas: string[]): Promise<Map<string, BondingCurveDecoded | null>> {
    const results = new Map<string, BondingCurveDecoded | null>();

    for (let i = 0; i < pdas.length; i += BATCH_SIZE) {
      const batch = pdas.slice(i, i + BATCH_SIZE);
      await sleep(PER_CALL_DELAY_MS);

      try {
        const pubkeys = batch.map(addr => new PublicKey(addr));
        const accounts = await this.conn.getMultipleAccountsInfo(pubkeys);

        for (let j = 0; j < batch.length; j++) {
          const account = accounts[j];
          if (!account || !account.data) {
            results.set(batch[j], null);
            continue;
          }

          const raw = deserializeBondingCurve(Buffer.from(account.data));
          if (!raw) {
            results.set(batch[j], null);
            continue;
          }

          results.set(batch[j], decodeBondingCurve(raw));
        }
      } catch (err) {
        logError({
          event: 'rpc_fetch_curves_error',
          batchStart: i,
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fill this batch with nulls
        for (const pda of batch) {
          results.set(pda, null);
        }
      }
    }

    return results;
  }

  /**
   * Fetch transaction signatures for a bonding curve PDA.
   * Returns confirmed signatures most-recent-first.
   *
   * Paginates automatically when the result set hits the per-call limit (1000),
   * accumulating up to `maxResults` total (default 5000). This ensures
   * totalTxCount is accurate for high-volume tokens that exceed 1000 transactions,
   * which would otherwise freeze the extrapolation counter at 1000.
   */
  async fetchSignatures(
    bondingCurvePda: string,
    options?: { limit?: number; before?: string; maxResults?: number }
  ): Promise<ConfirmedSignatureInfo[]> {
    const pageSize = Math.min(options?.limit ?? 1000, 1000); // RPC max is 1000
    const maxResults = options?.maxResults ?? pageSize;
    const all: ConfirmedSignatureInfo[] = [];
    let cursor: string | undefined = options?.before;

    do {
      await sleep(PER_CALL_DELAY_MS);

      try {
        const page = await this.conn.getSignaturesForAddress(
          new PublicKey(bondingCurvePda),
          { limit: pageSize, before: cursor },
          'confirmed'
        );

        all.push(...page);

        // If the page is smaller than the page size we have everything
        if (page.length < pageSize) break;

        // Advance cursor to the oldest signature on this page for next iteration
        cursor = page[page.length - 1].signature;
      } catch (err) {
        logError({
          event: 'rpc_fetch_signatures_error',
          pda: bondingCurvePda,
          error: err instanceof Error ? err.message : String(err),
        });
        break; // Return whatever we have so far
      }
    } while (all.length < maxResults);

    return all.slice(0, maxResults);
  }

  /**
   * Fetch and parse a single transaction.
   * Returns the transaction or null on failure.
   */
  async fetchTransaction(signature: string): Promise<{
    accountKeys: string[];
    instructions: Array<{
      programIdIndex: number;
      accountIndices: number[];
      data: Buffer;
    }>;
    blockTime: number | null;
  } | null> {
    await sleep(PER_CALL_DELAY_MS);

    try {
      const tx = await this.conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.meta || tx.meta.err) return null;

      const message = tx.transaction.message;
      const accountKeys = message.staticAccountKeys
        ? message.staticAccountKeys.map((k: PublicKey) => k.toBase58())
        : (message as any).accountKeys?.map((k: PublicKey) => k.toBase58()) ?? [];

      if (tx.meta.loadedAddresses) {
        accountKeys.push(
          ...tx.meta.loadedAddresses.writable.map((k: PublicKey) => k.toBase58()),
          ...tx.meta.loadedAddresses.readonly.map((k: PublicKey) => k.toBase58()),
        );
      }

      const compiledInstructions = message.compiledInstructions
        ?? (message as any).instructions
        ?? [];

      const instructions = compiledInstructions.map((ix: any) => ({
        programIdIndex: ix.programIdIndex,
        accountIndices: ix.accountKeyIndexes ?? ix.accounts ?? [],
        data: Buffer.from(ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, 'base64')),
      }));

      return {
        accountKeys,
        instructions,
        blockTime: tx.blockTime ?? null,
      };
    } catch (err) {
      logError({
        event: 'rpc_fetch_tx_error',
        signature,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
