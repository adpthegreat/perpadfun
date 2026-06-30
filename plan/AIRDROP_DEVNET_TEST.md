# Devnet mock-airdrop test

The Kamino merkle distributor is **mainnet-only** — `KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat`
returns `value:null` from `getAccountInfo` on devnet **and** testnet (only `executable:true` on
mainnet-beta). So you cannot call the real program on devnet. To exercise it there, deploy a
**copy** of the program under a new id and point the ops scripts + client at it via the env
override in `src/lib/airdrop/pda.ts`:

- ops scripts (node/bun): `DISTRIBUTOR_PROGRAM_ID=<devnet program id>`
- client/Worker build:    `VITE_DISTRIBUTOR_PROGRAM_ID=<devnet program id>`

The mainnet default (`Kdisq…`) is unchanged when neither is set — production is unaffected.

## 0. Fund the deployer (the one manual step)
An ~820 KB program deploy needs **~6 devnet SOL** (programdata rent ~2.85 + a same-size buffer
~2.85 at peak; the buffer is refunded, net ~2.85 stays locked in the program). The CLI faucet
(`solana airdrop`) is heavily rate-limited — use the web faucet **https://faucet.solana.com**
(GitHub auth, ~10 SOL/day) and send to your deployer pubkey.

## 1. Get the program binary
```
solana program dump KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat kamino.so --url mainnet-beta
```

## 2. Deploy the copy to devnet (generates a new program id)
```
solana-keygen new -o devnet-program.json          # the new program id
solana program deploy kamino.so \
  --program-id devnet-program.json \
  --keypair <funded deployer> \
  --url devnet
PROGRAM_ID=$(solana-keygen pubkey devnet-program.json)
```

## 3. Mint + distributor + claim on devnet
```
export DISTRIBUTOR_PROGRAM_ID=$PROGRAM_ID
export RPC_URL=https://api.devnet.solana.com
export ADMIN_KEYPAIR=<funded deployer>

# create a 6-decimal SPL mint, fund the admin ATA, build a small tree, then:
bun run scripts/airdrop/build-tree.ts <small-test.csv>
SKIP_HANDOVER=1 MINT=<mint> bun run scripts/airdrop/create-distributor.ts   # sentinel gate, funded
bun run scripts/airdrop/open-claims.ts                                       # flips enable_slot
# claim via a driver (see scratch-localnet/integration-test.ts) or the UI below
```
`scratch-localnet/integration-test.ts` already drives the full create -> gate -> open -> claim ->
replay sequence and asserts it; set `RPC` to devnet and `DISTRIBUTOR_PROGRAM_ID` to run it on
devnet instead of localnet.

## 4. Click-through UI on devnet
Build the client with `VITE_DISTRIBUTOR_PROGRAM_ID=$PROGRAM_ID` + a devnet RPC, serve it
(`wrangler dev` or a Cloudflare deploy), set Phantom to devnet, connect the whitelisted test wallet.

> Note: the localnet integration test (`--clone-upgradeable-program` of the real mainnet program,
> 19/19) already validates the exact mainnet bytecode against our code. This devnet path is for an
> externally-clickable instance, not for additional correctness coverage.
