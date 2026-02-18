import { PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID } from './constants';

/**
 * Derive the bonding curve PDA for a given mint.
 * Seeds: ["bonding-curve", mint_pubkey]
 */
export function deriveBondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the associated bonding curve token account.
 * This is the standard ATA for the bonding curve PDA holding the token mint.
 */
export function deriveAssociatedBondingCurve(
  bondingCurvePda: PublicKey,
  mint: PublicKey
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [
      bondingCurvePda.toBuffer(),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  );
  return ata;
}
