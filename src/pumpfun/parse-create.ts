import { PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID } from './constants';
import { deriveBondingCurvePda } from './pda';

export interface PumpfunCreateEvent {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  bondingCurvePda: string;
  /** Unix seconds — from block time if available, otherwise Date.now()/1000 */
  createdAt: number;
}

/**
 * Known discriminator for the pump.fun "create" instruction.
 * First 8 bytes of the instruction data for the Create variant.
 * This is the anchor discriminator: sha256("global:create")[0..8]
 */
const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

/**
 * Parse a pump.fun Create instruction from a transaction's logs or instruction data.
 *
 * For the WebSocket logsSubscribe approach, we parse the transaction accounts
 * and instruction data from the transaction notification.
 *
 * Account layout for pump.fun Create instruction:
 *   [0] mint
 *   [1] mintAuthority
 *   [2] bondingCurve
 *   [3] associatedBondingCurve
 *   [4] global
 *   [5] mplTokenMetadata
 *   [6] metadata
 *   [7] user (creator/signer)
 *   [8..] system accounts
 *
 * Instruction data layout (after 8-byte discriminator):
 *   [8..12]  name_len (u32 LE)
 *   [12..12+name_len] name (UTF-8)
 *   then symbol_len (u32 LE)
 *   then symbol (UTF-8)
 *   then uri_len (u32 LE)
 *   then uri (UTF-8)
 */
export function parseCreateFromAccountsAndData(
  accountKeys: string[],
  programIdIndex: number,
  instructionAccountIndices: number[],
  instructionData: Buffer,
  blockTime?: number
): PumpfunCreateEvent | null {
  // Verify this is a pump.fun instruction
  if (accountKeys[programIdIndex] !== PUMP_FUN_PROGRAM_ID.toBase58()) {
    return null;
  }

  // Check discriminator
  if (instructionData.length < 8) return null;
  const disc = instructionData.subarray(0, 8);
  if (!disc.equals(CREATE_DISCRIMINATOR)) return null;

  // Need at least 8 accounts
  if (instructionAccountIndices.length < 8) return null;

  const mint = accountKeys[instructionAccountIndices[0]];
  const bondingCurve = accountKeys[instructionAccountIndices[2]];
  const creator = accountKeys[instructionAccountIndices[7]];

  if (!mint || !bondingCurve || !creator) return null;

  // Parse name and symbol from instruction data
  let offset = 8; // skip discriminator

  const { value: name, newOffset: afterName } = readString(instructionData, offset);
  if (name === null) return null;
  offset = afterName;

  const { value: symbol, newOffset: afterSymbol } = readString(instructionData, offset);
  if (symbol === null) return null;

  return {
    mint,
    creator,
    name: name || '',
    symbol: symbol || '',
    bondingCurvePda: bondingCurve,
    createdAt: blockTime ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Parse a Create event from transaction log messages.
 * Looks for the pump.fun program log pattern that indicates a create.
 * Falls back to deriving the bonding curve PDA from the mint.
 *
 * This is a simpler approach used with logsSubscribe where we get
 * account keys + logs but may not have full instruction data.
 */
export function parseCreateInstruction(
  logs: string[],
  accountKeys: string[],
  blockTime?: number
): PumpfunCreateEvent | null {
  // Look for the pump.fun program invoke in logs
  const pumpProgramId = PUMP_FUN_PROGRAM_ID.toBase58();
  const hasCreate = logs.some(log =>
    log.includes(`Program ${pumpProgramId} invoke`) ||
    log.includes('Program log: Instruction: Create')
  );

  if (!hasCreate) return null;

  // In logsSubscribe notifications, the account keys are from the transaction.
  // For a Create tx, the mint is typically a new account (first non-system key after signer).
  // We need to identify the mint and creator from the account keys.
  //
  // Heuristic: The creator is the fee payer (first account key / signer).
  // The mint is the second account key (newly created).
  // We derive the bonding curve PDA to verify.
  if (accountKeys.length < 2) return null;

  const creator = accountKeys[0];
  const mint = accountKeys[1];

  // Verify by deriving the bonding curve PDA
  let bondingCurvePda: string;
  try {
    bondingCurvePda = deriveBondingCurvePda(new PublicKey(mint)).toBase58();
  } catch {
    return null;
  }

  // Check if our derived PDA is in the account keys (validation)
  const pdaInKeys = accountKeys.includes(bondingCurvePda);
  if (!pdaInKeys) return null;

  // We don't have name/symbol from logs alone — they'll be empty
  // The caller can fetch metadata separately if needed
  return {
    mint,
    creator,
    name: '',
    symbol: '',
    bondingCurvePda,
    createdAt: blockTime ?? Math.floor(Date.now() / 1000),
  };
}

/** Read a Borsh-style length-prefixed UTF-8 string from a buffer. */
function readString(buf: Buffer, offset: number): { value: string | null; newOffset: number } {
  if (offset + 4 > buf.length) return { value: null, newOffset: offset };
  const len = buf.readUInt32LE(offset);
  offset += 4;
  if (offset + len > buf.length) return { value: null, newOffset: offset };
  const value = buf.subarray(offset, offset + len).toString('utf-8');
  return { value, newOffset: offset + len };
}
