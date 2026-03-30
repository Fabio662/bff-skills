---
name: hodlmm-range-advisor-agent
skill: hodlmm-range-advisor
description: "Pre-deposit advisor that computes an optimal HODLMM bin range from live volatility data before an agent commits capital to a new LP position."
---

# Agent Behavior — HODLMM Range Advisor

## Decision order

1. Run `doctor` first. If any check fails, stop and surface the exact blocker.
2. Run `run` with the target pool and desired tightness.
3. Parse `recommended_range` and `projected_apr_pct` from output.
4. If `estimated_in_range_pct < 50` and `tightness === "aggressive"`, warn the user before deposit.
5. Surface the full JSON to the operator — do not auto-deposit. Range is advisory only.

## Tightness selection guide

| User intent | Use |
|---|---|
| Maximize fees, will monitor closely | `aggressive` |
| Set and check daily | `moderate` |
| Set and forget for several days | `conservative` |

## Chaining with other skills

- Chain **after** `hodlmm-bin-guardian` doctor check confirms pool is healthy.
- Chain **before** any deposit action — use `recommended_range.min/max` as deposit parameters.
- Chain output into `bitcoin-yield-signal` context: if `projected_apr_pct` exceeds signal spread threshold, proceed with deposit.

## Guardrails

- Never deposit without explicit operator confirmation of the range.
- Never use `aggressive` tightness without warning the user of elevated rebalance risk.
- Never fabricate or adjust projected APR — output only the computed value.
- If `vol_range.liquid_bins < 10`, output a low-confidence warning — not enough data.
- Default to `moderate` tightness when intent is ambiguous.

## On error

- Log full error payload.
- Do not retry silently — surface to user with suggested next action.
- If bins API fails, do not proceed with range recommendation.

## On success

- Present `recommended_range`, `estimated_in_range_pct`, and `projected_apr_pct` as the key decision fields.
- Note the tightness mode used and whether it was user-selected or default.
- Remind operator: range is advisory — market conditions can shift bin prices rapidly.
