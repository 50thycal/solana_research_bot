import Database from 'better-sqlite3';

export interface TokenRow {
  mint: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  created_at: number;
  initial_virtual_sol: number | null;
  initial_virtual_token: number | null;
  initial_price_sol: number | null;
  bonding_curve_pda: string;
}

/**
 * Insert a token into the global registry.
 * Uses INSERT OR IGNORE — if the mint already exists, this is a no-op.
 */
export function insertToken(
  db: Database.Database,
  token: {
    mint: string;
    creator: string;
    name: string | null;
    symbol: string | null;
    createdAt: number;
    initialVirtualSol: number | null;
    initialVirtualToken: number | null;
    initialPriceSol: number | null;
    bondingCurvePda: string;
  }
): void {
  db.prepare(`
    INSERT OR IGNORE INTO tokens
      (mint, creator, name, symbol, created_at, initial_virtual_sol, initial_virtual_token, initial_price_sol, bonding_curve_pda)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    token.mint,
    token.creator,
    token.name,
    token.symbol,
    token.createdAt,
    token.initialVirtualSol,
    token.initialVirtualToken,
    token.initialPriceSol,
    token.bondingCurvePda
  );
}

/** Get a token by mint address. */
export function getToken(db: Database.Database, mint: string): TokenRow | undefined {
  return db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as TokenRow | undefined;
}
