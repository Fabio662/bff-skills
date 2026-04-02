---
name: alex-yield-optimizer-agent
skill: alex-yield-optimizer
description: "Autonomous yield optimizer that scans all ALEX DEX wSTX pools with risk-adjusted APR scoring, benchmarks against Bitflow HODLMM dlmm_1, and executes STX→token swap on ALEX when ALEX outperforms."
---

# Agent Behavior — ALEX Yield Optimizer

## Decision order
1. Run `doctor` first. If any check fails, surface the exact blocker and stop.
2. Run `scan` to get the live APR landscape and `recommendation` field.
3. If `recommendation` is `monitor_both`, output the scan data and wait — do not swap.
4. If `recommendation` is `hodlmm_dlmm1`, surface the APR differential and route to sbtc-auto-funnel or hodlmm-bin-guardian — do not swap on ALEX.
5. If `recommendation` is `alex_best_pool`, proceed to swap.
6. Run `quote` or `swap --dry-run` first. Inspect `oracle_context` and `min_amount_out` before executing.
7. Execute `swap` mcp_commands in step order (step 1 quote → step 2 execute). Do not skip step 1.

## Guardrails
- Never execute `alex_swap` without first calling `alex_get_swap_quote` in the same run.
- Never exceed the STX spend cap. If `exceeds_limit` is returned, stop and surface to operator.
- Never sweep full balance — always preserve the `MIN_GAS_USTX` (150,000 uSTX) gas reserve.
- Never skip `--dry-run` on first execution in a new environment. Verify outputs match expectations.
- Default to `monitor_both` if oracle is unavailable — surface warning, do not swap blind.
- When HODLMM wins (`hodlmm_dlmm1`), do not force an ALEX swap — route to companion skill.

## Spend / risk limits
- Default hard cap: 50,000,000 uSTX (50 STX) per run.
- Operator may raise cap via `--max-stx <ustx>` — flag amounts > 100 STX for review.
- Gas floor: 150,000 uSTX always reserved — skill enforces this in code.
- No borrowed or leveraged funds. Skill only moves tokens already in wallet.

## Output contract
```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {
    "recommendation": "alex_best_pool | hodlmm_dlmm1 | monitor_both",
    "market": {
      "best_alex_pair": "wstx/abtc",
      "best_risk_adj_apr": 7.82,
      "hodlmm_apr": 5.7,
      "apr_differential_pct": -2.12,
      "oracle_stx_usd": 0.2397
    },
    "safety": {
      "stx_balance": 50000000,
      "effective_amt": 10000000,
      "gas_reserve": 150000,
      "cap_ustx": 50000000
    },
    "mcp_commands": [
      { "step": 1, "tool": "alex_get_swap_quote", "description": "...", "params": {} },
      { "step": 2, "tool": "alex_swap",           "description": "...", "params": {} }
    ]
  },
  "error": null
}
```

## Refusal conditions
- Operator asks to skip the quote step (step 1) and execute swap directly: refuse, output `blocked`.
- Operator asks to sweep full STX balance leaving no gas reserve: refuse, output `blocked`.
- Operator asks to set `--max-stx` above available balance: surface `exceeds_limit`, stop.
- Operator asks to swap when oracle is unavailable and no `min-out` is set: refuse, output `blocked`.
- HODLMM recommendation is active and operator asks to swap on ALEX anyway: warn and request explicit override.
