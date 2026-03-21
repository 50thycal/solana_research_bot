import { PublicKey } from '@solana/web3.js';

/** Pump.fun program ID */
export const PUMP_FUN_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);

/** Pump.fun global account (fee recipient) */
export const PUMP_FUN_FEE_RECIPIENT = new PublicKey(
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'
);

/** System program */
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Token program */
export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);

/** Associated token program */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

/** Token-2022 program (used by pump.fun CreateV2) */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);

/** Rent sysvar */
export const RENT_PROGRAM_ID = new PublicKey(
  'SysvarRent111111111111111111111111111111111'
);

/**
 * Bonding curve account data layout offsets and sizes.
 * Total account size: 49 bytes of data (after the 8-byte discriminator).
 *
 * Layout (from pump.fun program):
 *   [0..8]   discriminator (u64)
 *   [8..16]  virtual_token_reserves (u64)
 *   [16..24] virtual_sol_reserves (u64)
 *   [24..32] real_token_reserves (u64)
 *   [32..40] real_sol_reserves (u64)
 *   [40..48] token_total_supply (u64)
 *   [48]     complete (bool, u8)
 */
export const BONDING_CURVE_LAYOUT = {
  DISCRIMINATOR_OFFSET: 0,
  VIRTUAL_TOKEN_RESERVES_OFFSET: 8,
  VIRTUAL_SOL_RESERVES_OFFSET: 16,
  REAL_TOKEN_RESERVES_OFFSET: 24,
  REAL_SOL_RESERVES_OFFSET: 32,
  TOKEN_TOTAL_SUPPLY_OFFSET: 40,
  COMPLETE_OFFSET: 48,
  EXPECTED_SIZE: 49,
} as const;

/** SOL has 9 decimals (lamports) */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Pump.fun tokens have 6 decimals */
export const TOKEN_DECIMALS = 6;
export const TOKEN_MULTIPLIER = 10 ** TOKEN_DECIMALS;
