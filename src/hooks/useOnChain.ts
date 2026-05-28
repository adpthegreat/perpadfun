// Legacy compat stubs. The on-chain trade & legacy launch flow were removed
// in the Meteora DBC pivot. These stubs keep older route code compiling and
// surface a clear error if anyone still calls them at runtime.

export type LegacyStatus = "idle" | "signing" | "sending" | "confirming" | "done" | "error";

export function useOnChainTrade() {
  return {
    status: "idle" as LegacyStatus,
    trade: async (_args: { tokenId: string; side: "buy" | "sell"; amount: number }): Promise<{
      amountTokens: number;
      amountUsdc: number;
      graduated: boolean;
    }> => {
      throw new Error("In-app trading is disabled. Trade on Jupiter / Meteora.");
    },
  };
}

export function useOnChainLaunch() {
  return {
    status: "idle" as LegacyStatus,
    launch: async (_args: unknown): Promise<{ tokenId: string }> => {
      throw new Error("Legacy launch flow removed. Use the Meteora DBC launcher.");
    },
  };
}
