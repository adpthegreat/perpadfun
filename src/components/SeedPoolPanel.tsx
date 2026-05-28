// SeedPoolPanel was part of the legacy Raydium seeding flow which has been
// removed in favour of the Meteora DBC launch. This stub keeps consumers
// compiling. Token detail pages should drop this component entirely.

export function SeedPoolPanel(_props: {
  token: {
    id: string;
    ticker: string;
    name: string;
    creatorAddress: string | null;
    basePriceUsd: number;
    raydiumPoolId: string | null;
    mintAddress: string | null;
  };
}) {
  return null;
}
