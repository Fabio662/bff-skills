---
name: hodlmm-range-advisor
description: "Computes an optimal HODLMM bin range for new sBTC/STX deposits using realized volatility derived from the live bin liquidity distribution. Outputs a recommended min/max bin range, projected in-range probability, and fee APR estimate."
metadata:
  author: "Fabio662"
  author-agent: "Graphite Owl (YieldAgent) — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt"
  user-invocable: "false"
  arguments: "doctor | run [--pool-id <id>] [--tightness aggressive|moderate|conservative] | install-packs"
  entry: "hodlmm-range-advisor/hodlmm-range-advisor.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l2, infrastructure"
---

# HODLMM Range Advisor

## What it does

Fetches live Bitflow HODLMM bin data, computes the P10–P90 spread of the liquidity distribution as a realized volatility proxy, and recommends an optimal bin range for a new deposit. Three tightness modes — `aggressive`, `moderate`, `conservative` — scale the range width as a multiple of the volatility spread. Projects estimated in-range probability and expected fee APR at the chosen range. All data comes from Bitflow's public HODLMM and App APIs — no external oracles.

## Why agents need it

HODLMM LP performance is dominated by the entry range decision: too tight and you're out of range within hours; too wide and you dilute your fee concentration. This skill gives autonomous agents a data-driven range recommendation at entry time based on where actual liquidity has been concentrated — a proxy for where the market has been trading. Agents can chain this as a pre-deposit gate alongside `hodlmm-bin-guardian` to close the full deposit → monitor → rebalance loop.

## Safety notes

- **Read-only.** No transactions are submitted.
- **Mainnet-only.** Bitflow HODLMM API does not support testnet.
- Does not move funds. No STX or sBTC is spent.
- Projected APR is an estimate based on current 24h pool data — not a guarantee.
- `aggressive` tightness mode carries higher out-of-range risk. Warn user explicitly before deposit.

## Commands

### doctor

Checks all 4 data sources: Bitflow HODLMM pools API, bins API, app pools API, and Hiro fees API.

```bash
bun run hodlmm-range-advisor/hodlmm-range-advisor.ts doctor
```

### install-packs

No packs required — uses Bitflow and Hiro public HTTP APIs directly.

```bash
bun run hodlmm-range-advisor/hodlmm-range-advisor.ts install-packs
```

### run

Compute range recommendation for a pool with a given tightness mode.

```bash
# Default: dlmm_1, moderate tightness
bun run hodlmm-range-advisor/hodlmm-range-advisor.ts run

# Custom pool and tightness
bun run hodlmm-range-advisor/hodlmm-range-advisor.ts run --pool-id dlmm_1 --tightness aggressive
bun run hodlmm-range-advisor/hodlmm-range-advisor.ts run --pool-id dlmm_1 --tightness conservative
```

## Output contract

All outputs are strict JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "string — summary of recommendation with bin range and estimated APR",
  "data": {
    "pool_id": "dlmm_1",
    "active_bin": 504,
    "recommended_range": { "min": 498, "max": 510, "width": 12 },
    "tightness": "moderate",
    "vol_range": { "p10": 496, "p90": 512, "width": 16, "liquid_bins": 87 },
    "estimated_in_range_pct": 75,
    "pool_apr_24h_pct": 17.72,
    "projected_apr_pct": 13.29,
    "gas_estimated_stx": 0.0144,
    "pool_tvl_usd": 77143,
    "pool_vol_24h_usd": 126045
  },
  "error": null
}
```

**Error:**
```json
{ "status": "error", "action": "string", "data": {}, "error": { "code": "", "message": "", "next": "" } }
```

## Output fields

| Field | Description |
|---|---|
| `active_bin` | Pool's current active bin |
| `recommended_range.min/max` | Suggested deposit bin range |
| `recommended_range.width` | Number of bins in range |
| `tightness` | Strategy used: `aggressive` / `moderate` / `conservative` |
| `vol_range.p10/p90` | P10–P90 of bins with active liquidity — realized vol proxy |
| `vol_range.liquid_bins` | Count of bins with non-zero liquidity |
| `estimated_in_range_pct` | Estimated % of time position stays in range |
| `pool_apr_24h_pct` | Current 24h fee APR from Bitflow app API |
| `projected_apr_pct` | `pool_apr × (in_range_pct / 100)` — expected effective APR |
| `gas_estimated_stx` | Estimated STX cost for a 2-tx deposit + rebalance cycle |

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Bitflow HODLMM API | Pool list, active bin ID | `bff.bitflowapis.finance/api/quotes/v1/pools` |
| Bitflow Bins API | Per-bin liquidity distribution | `bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}` |
| Bitflow App API | TVL, 24h volume, APR, token prices | `bff.bitflowapis.finance/api/app/v1/pools` |
| Hiro Stacks API | STX fee estimate | `api.mainnet.hiro.so/v2/fees/transfer` |

## Known constraints

- Volatility estimate is based on where liquidity currently sits, not historical OHLC — suitable as a proxy but not identical to time-series vol.
- Bin width is pool-specific (dlmm_1 uses 1 bp steps). Range widths are in bin units, not USD.
- In-range probability estimate assumes roughly uniform distribution over the vol range — actual distribution varies.
