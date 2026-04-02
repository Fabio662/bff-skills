---
name: alex-yield-optimizer
description: "Scans all ALEX DEX wSTX pools for live risk-adjusted APR (fee yield × TVL weight), ranks top opportunities, benchmarks against Bitflow HODLMM dlmm_1, and executes STX→token swap on ALEX DEX when ALEX outperforms."
metadata:
  author: "Fabio662"
  author-agent: "Graphite Owl (YieldAgent) — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt"
  user-invocable: "false"
  arguments: "doctor | scan | quote | swap | run | install-packs"
  entry: "alex-yield-optimizer/alex-yield-optimizer.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, l2, infrastructure"
---

# ALEX Yield Optimizer

## What it does
Queries every ALEX DEX wSTX liquidity pool for live 24-hour APR and TVL, computes a risk-adjusted score (`apr × min(1, sqrt(tvlUsd / 1_000_000))`) that penalises thin-liquidity pools, ranks the top opportunities, and compares the best against the Bitflow HODLMM dlmm_1 benchmark. When ALEX outperforms, it produces ready-to-execute `mcp_commands` for a two-step quote-then-swap pipeline. When HODLMM wins, it routes the agent to the appropriate companion skill instead of forcing a suboptimal ALEX trade.

Oracle context (BTC/USD, STX/USD via JingSwap Pyth feed) is surfaced on every swap output so the agent can sanity-check USD value before executing.

## Why agents need it
ALEX is the largest DEX on Stacks mainnet by volume but has no dedicated bff-skill. Agents with idle STX have no automated path to: (1) compare risk-adjusted ALEX pool yield vs HODLMM dlmm_1 in real time, (2) identify which ALEX token (aBTC, waeUSDC, ALEX governance, wlqSTX, sUSDT) is offering the best entry, or (3) get a validated swap path with gas-reserve enforcement. This skill closes all three gaps.

Supported ALEX tokens (wSTX pairs):
- `token-abtc` — aBTC (ALEX Bitcoin)
- `age000-governance-token` — ALEX governance
- `token-waeusdc` — waeUSDC (Allbridge USDC)
- `token-wlqstx` — wlqSTX (Liquid Staked STX)
- `token-susdt` — sUSDT

## Safety notes
- Hard spend cap: 50 STX default (override with `--max-stx <ustx>`). Cap enforced in code.
- Gas reserve: 0.15 STX always held back — skill blocks if STX balance would fall below floor.
- Oracle context on every swap: BTC/USD and STX/USD from Pyth via JingSwap prices endpoint.
- `--dry-run` flag on all write commands — outputs full mcp_command params without executing.
- No direct key handling. Signing is delegated to the agent MCP framework via mcp_command output.
- Swap step always outputs `alex_get_swap_quote` before `alex_swap` — never skips quote step.
- Mainnet only: ALEX DEX, Bitflow HODLMM, and Pyth oracle feeds are mainnet-only.

## Commands

### doctor
Checks STX balance (gas reserve), ALEX API reachability, HODLMM benchmark status, and oracle freshness.
```bash
bun run alex-yield-optimizer/alex-yield-optimizer.ts doctor --address <stx_address>
```

### scan
Fetches all ALEX wSTX pools + TVL/APR stats, computes risk-adjusted scores, ranks top 5, and compares against HODLMM dlmm_1. Returns a `recommendation` field: `alex_best_pool | hodlmm_dlmm1 | monitor_both`.
```bash
bun run alex-yield-optimizer/alex-yield-optimizer.ts scan [--min-tvl <usd>]
```

### quote
Outputs an `alex_get_swap_quote` mcp_command for any token pair without executing. Use this to validate price before calling swap.
```bash
bun run alex-yield-optimizer/alex-yield-optimizer.ts quote --token-x <contractId> --token-y <contractId> --amount <ustx>
```

### swap
Validates gas reserve and balance, then outputs a two-step mcp_command pipeline (step 1: `alex_get_swap_quote`, step 2: `alex_swap`). Supports `--dry-run`.
```bash
bun run alex-yield-optimizer/alex-yield-optimizer.ts swap --address <stx_address> --token-x <contractId> --token-y <contractId> --amount <ustx> [--min-out <amount>] [--dry-run]
```

### run
Full autonomous pipeline: scan all pools → pick best → if ALEX wins, output swap mcp_commands; if HODLMM wins, route to companion skill; if yields are within margin, output `monitor_both`.
```bash
bun run alex-yield-optimizer/alex-yield-optimizer.ts run --address <stx_address> [--amount <ustx>] [--max-stx <ustx>] [--dry-run]
```

### install-packs
```bash
bun run alex-yield-optimizer/alex-yield-optimizer.ts install-packs
```

## Output contract
All commands output strict JSON to stdout.
```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {
    "recommendation": "alex_best_pool | hodlmm_dlmm1 | monitor_both",
    "apr_differential_pct": -2.1,
    "hodlmm_wins": false,
    "pools_scanned": 50,
    "pools_above_tvl_filter": 12,
    "alex_top5": [
      {
        "pair": "wstx/abtc",
        "apr_24h": 8.3,
        "tvl_usd": 1400000,
        "risk_adjusted_apr": 7.82,
        "recommendation": "Bitcoin exposure via ALEX"
      }
    ],
    "hodlmm_benchmark": { "pool_id": "dlmm_1", "apr_24h": 5.7, "tvl_usd": 890000 },
    "oracle": { "btc_usd": 70809, "stx_usd": 0.2397, "publish_time": 1774500100 },
    "mcp_commands": [
      { "step": 1, "tool": "alex_get_swap_quote", "description": "...", "params": {} },
      { "step": 2, "tool": "alex_swap",           "description": "...", "params": {} }
    ]
  },
  "error": null
}
```

## Known constraints
- Requires `STACKS_ADDRESS` env var or `--address` flag for write commands.
- ALEX pool APR/TVL sourced from `app.alex.fi/api/v1/pool-token-stats` — may lag 1–2 minutes.
- HODLMM APR from `bff.bitflowapis.finance` — 24-hour rolling average.
- Oracle from Pyth via JingSwap prices endpoint — ~10-second lag.
- When `recommendation` is `hodlmm_dlmm1`, no ALEX swap is executed — use sbtc-auto-funnel or hodlmm-bin-guardian to act on the HODLMM signal.
- Risk-adjusted APR formula: `apr × min(1, sqrt(tvlUsd / 1_000_000))` — $1M TVL pool gets full credit; $100k pool gets ~31.6% discount.
