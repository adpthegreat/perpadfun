#!/usr/bin/env node
// Unit test for profileManager.pickProfile — no network, no funds.
// Run: node keeper/scripts/profile-manager-test.mjs
import { pickProfile } from '../src/profileManager.js';

let passed = 0, failed = 0;
function check(name, got, want) {
  const ok = got.profileIndex === want.profileIndex
    && got.needsDeposit === want.needsDeposit
    && (want.depositAmountUi === undefined || got.depositAmountUi === want.depositAmountUi);
  if (ok) { passed++; console.log(`  PASS  ${name}  ->  profile ${got.profileIndex}, deposit=${got.needsDeposit}  (${got.reason})`); }
  else    { failed++; console.log(`  FAIL  ${name}\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(got)}`); }
}

const usd = (n) => n * 1_000_000; // UI -> base units

console.log('\n=== profileManager.pickProfile tests ===\n');

// 1) Single funded profile, no positions -> use it.
check('single funded profile',
  pickProfile({
    profiles: [{ profileIndex: 0, usdc: usd(50) }],
    positions: [],
  }),
  { profileIndex: 0, needsDeposit: false });

// 2) Profile 0 funded but at USDC cap -> roll to profile 1 (also funded).
check('profile 0 at usdc cap, roll to profile 1',
  pickProfile({
    profiles: [
      { profileIndex: 0, usdc: usd(150) },
      { profileIndex: 1, usdc: usd(40) },
    ],
    positions: [],
  }),
  { profileIndex: 1, needsDeposit: false });

// 3) Profile 0 funded but at position cap (5 open) -> roll to profile 1.
check('profile 0 at position cap, roll to profile 1',
  pickProfile({
    profiles: [
      { profileIndex: 0, usdc: usd(50) },
      { profileIndex: 1, usdc: usd(50) },
    ],
    positions: Array(5).fill({ profileIndex: 0, status: 'open' }),
  }),
  { profileIndex: 1, needsDeposit: false });

// 4) Profile 0 empty AND profile 1 funded -> prefer funded (skip the deposit tx).
check('profile 0 empty, prefer funded profile 1',
  pickProfile({
    profiles: [
      { profileIndex: 0, usdc: usd(2) },
      { profileIndex: 1, usdc: usd(50) },
    ],
    positions: [],
  }),
  { profileIndex: 1, needsDeposit: false });

// 4b) Only one profile and it's empty -> top it up.
check('only profile empty, top up',
  pickProfile({
    profiles: [{ profileIndex: 0, usdc: usd(2) }],
    positions: [],
  }),
  { profileIndex: 0, needsDeposit: true, depositAmountUi: 15 });

// 5) All profiles full (usdc cap) -> roll to fresh next index with deposit.
check('all profiles at cap, open fresh',
  pickProfile({
    profiles: [
      { profileIndex: 0, usdc: usd(150) },
      { profileIndex: 1, usdc: usd(150) },
    ],
    positions: [],
  }),
  { profileIndex: 2, needsDeposit: true, depositAmountUi: 15 });

// 6) No profiles at all (cold start) -> profile 0 with deposit.
check('cold start, no profiles',
  pickProfile({ profiles: [], positions: [] }),
  { profileIndex: 0, needsDeposit: true, depositAmountUi: 15 });

// 7) Profile 0 has 4 open positions (under cap), funded -> still use it.
check('profile 0 under position cap',
  pickProfile({
    profiles: [{ profileIndex: 0, usdc: usd(50) }],
    positions: Array(4).fill({ profileIndex: 0, status: 'open' }),
  }),
  { profileIndex: 0, needsDeposit: false });

// 8) Custom caps respected.
check('custom usdcCap=30 rolls earlier',
  pickProfile({
    profiles: [
      { profileIndex: 0, usdc: usd(40) },
      { profileIndex: 1, usdc: usd(20) },
    ],
    positions: [],
    caps: { usdcCap: 30 },
  }),
  { profileIndex: 1, needsDeposit: false });

// 9) Closed positions ignored.
check('closed positions do not count',
  pickProfile({
    profiles: [{ profileIndex: 0, usdc: usd(50) }],
    positions: [
      ...Array(5).fill({ profileIndex: 0, status: 'closed' }),
      { profileIndex: 0, status: 'open' },
    ],
  }),
  { profileIndex: 0, needsDeposit: false });

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
