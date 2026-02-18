import { BONDING_CURVE_LAYOUT, LAMPORTS_PER_SOL, TOKEN_MULTIPLIER } from './constants';

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export interface BondingCurveDecoded {
  virtualTokenReserves: number;
  virtualSolReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  tokenTotalSupply: number;
  complete: boolean;
  /** Derived: virtualSolReserves / virtualTokenReserves (in SOL per token) */
  priceSol: number;
}

/**
 * Deserialize raw bonding curve account data into typed fields.
 * Returns null if the data is too short or invalid.
 */
export function deserializeBondingCurve(data: Buffer): BondingCurveState | null {
  // Account data includes the 8-byte discriminator + 41 bytes of fields = 49 bytes minimum
  if (data.length < BONDING_CURVE_LAYOUT.EXPECTED_SIZE) {
    return null;
  }

  const virtualTokenReserves = data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES_OFFSET);
  const virtualSolReserves = data.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES_OFFSET);
  const realTokenReserves = data.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_TOKEN_RESERVES_OFFSET);
  const realSolReserves = data.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_SOL_RESERVES_OFFSET);
  const tokenTotalSupply = data.readBigUInt64LE(BONDING_CURVE_LAYOUT.TOKEN_TOTAL_SUPPLY_OFFSET);
  const complete = data[BONDING_CURVE_LAYOUT.COMPLETE_OFFSET] === 1;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

/**
 * Decode bonding curve state into human-readable numbers with derived price.
 * Converts lamports → SOL and raw token amounts → token units.
 */
export function decodeBondingCurve(state: BondingCurveState): BondingCurveDecoded {
  const virtualSolReserves = Number(state.virtualSolReserves) / LAMPORTS_PER_SOL;
  const virtualTokenReserves = Number(state.virtualTokenReserves) / TOKEN_MULTIPLIER;
  const realSolReserves = Number(state.realSolReserves) / LAMPORTS_PER_SOL;
  const realTokenReserves = Number(state.realTokenReserves) / TOKEN_MULTIPLIER;
  const tokenTotalSupply = Number(state.tokenTotalSupply) / TOKEN_MULTIPLIER;

  // Price derivation: SOL per token from virtual reserves
  const priceSol = virtualTokenReserves > 0
    ? virtualSolReserves / virtualTokenReserves
    : 0;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete: state.complete,
    priceSol,
  };
}
