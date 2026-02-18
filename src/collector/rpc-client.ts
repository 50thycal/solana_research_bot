import { Connection, PublicKey, AccountInfo, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { deserializeBondingCurve, decodeBondingCurve, BondingCurveDecoded } from '../pumpfun/bonding-curve';
import { parseCreateFromAccountsAndData, PumpfunCreateEvent } from '../pumpfun/parse-create';
import { PUMP_FUN_PROGRAM_ID } from '../pumpfun/constants';
import { config } from '../config';

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

      // Find the pump.fun instruction
      const compiledInstructions = message.compiledInstructions
        ?? (message as any).instructions
        ?? [];

      for (const ix of compiledInstructions) {
        const programIdIndex = ix.programIdIndex;
        if (accountKeys[programIdIndex] !== PUMP_FUN_PROGRAM_ID.toBase58()) continue;

        const data = Buffer.from(ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, 'base64'));
        const accountIndices: number[] = ix.accountKeyIndexes ?? (ix as any).accounts ?? [];

        const parsed = parseCreateFromAccountsAndData(
          accountKeys,
          programIdIndex,
          accountIndices,
          data,
          tx.blockTime ?? undefined
        );

        if (parsed) return parsed;
      }

      return null;
    } catch (err) {
      console.error(JSON.stringify({
        event: 'rpc_fetch_create_error',
        signature,
        error: err instanceof Error ? err.message : String(err),
      }));
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
        console.error(JSON.stringify({
          event: 'rpc_fetch_curves_error',
          batchStart: i,
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
        }));
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
   * Returns the full list of confirmed signatures (most recent first).
   */
  async fetchSignatures(
    bondingCurvePda: string,
    options?: { limit?: number; before?: string }
  ): Promise<ConfirmedSignatureInfo[]> {
    await sleep(PER_CALL_DELAY_MS);

    try {
      return await this.conn.getSignaturesForAddress(
        new PublicKey(bondingCurvePda),
        {
          limit: options?.limit ?? 1000,
          before: options?.before,
        },
        'confirmed'
      );
    } catch (err) {
      console.error(JSON.stringify({
        event: 'rpc_fetch_signatures_error',
        pda: bondingCurvePda,
        error: err instanceof Error ? err.message : String(err),
      }));
      return [];
    }
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
      console.error(JSON.stringify({
        event: 'rpc_fetch_tx_error',
        signature,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }
}
