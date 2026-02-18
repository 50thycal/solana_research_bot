import { PUMP_FUN_PROGRAM_ID } from './constants';

/**
 * Known discriminators for pump.fun buy and sell instructions.
 * Anchor discriminators: sha256("global:buy")[0..8] and sha256("global:sell")[0..8]
 */
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

export type TxClassification = 'buy' | 'sell' | 'unknown';

export interface ClassifiedTx {
  signature: string;
  classification: TxClassification;
  /** The wallet that executed the buy/sell (signer). */
  wallet: string | null;
}

/**
 * Classify a pump.fun transaction as buy, sell, or unknown.
 *
 * Checks the instruction data discriminator to determine the type.
 * The signer (wallet) is the first account key.
 */
export function classifyTransaction(
  accountKeys: string[],
  instructions: Array<{
    programIdIndex: number;
    accountIndices: number[];
    data: Buffer;
  }>
): { classification: TxClassification; wallet: string | null } {
  for (const ix of instructions) {
    if (accountKeys[ix.programIdIndex] !== PUMP_FUN_PROGRAM_ID.toBase58()) continue;
    if (ix.data.length < 8) continue;

    const disc = ix.data.subarray(0, 8);

    if (disc.equals(BUY_DISCRIMINATOR)) {
      // The buyer is typically the signer = first account in the instruction
      const wallet = ix.accountIndices.length > 0
        ? accountKeys[ix.accountIndices[0]] ?? null
        : accountKeys[0] ?? null;
      return { classification: 'buy', wallet };
    }

    if (disc.equals(SELL_DISCRIMINATOR)) {
      const wallet = ix.accountIndices.length > 0
        ? accountKeys[ix.accountIndices[0]] ?? null
        : accountKeys[0] ?? null;
      return { classification: 'sell', wallet };
    }
  }

  return { classification: 'unknown', wallet: null };
}
