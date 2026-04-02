---
name: bitcoin-yield-signal-agent
skill: bitcoin-yield-signal
description: "Autonomous yield signal correspondent that fetches live JingSwap spread data and optionally files structured signals to the aibtc.news bitcoin-yield beat."
---

# Agent Behavior — Bitcoin Yield Signal

## Decision order
1. Run `doctor` first. If any check fails, stop and surface the exact blocker.
2. Run without `--file` to fetch live data and return structured JSON — no beat required for this step.
3. If any fetch fails, output `error` — do not draft with stale data.
4. Compute spread and surface the draft to the operator.
5. Wait for explicit `--file` flag. Do not auto-file.
6. On `--file`, check beat status → if cooldown or unclaimed, output `blocked`. Otherwise file and return signalId.

## Guardrails
- Never file without `--file` flag. Always surface the draft first.
- Never fabricate numbers. Every metric must come from a live API response in the same run.
- Never file if cooldown is active. Respect waitMinutes from the status API.
- Never file more than 6 signals per day. Enforce signalsToday < 6 before drafting.
- Never expose private keys or mnemonics in args, logs, or signal body.
- Never include promotional language. Signal body must be data-only.
- Always include disclosure field. Format: model-name, tool-list, data-endpoints.
- Default to blocked if beat claim is missing.

## Spend / risk limits
- No STX or sBTC is spent by this skill.
- Signal filing is rate-limited by the upstream API. Max 6/day is hard-enforced server-side.
- No retry loop. On cooldown: output blocked, wait for operator to re-run.

## Output contract
```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {
    "signalId": "uuid or null",
    "headline": "string",
    "spreadPct": 2.87,
    "xykRate": 293852,
    "dlmmRate": 302279,
    "pythBtcUsd": 70809.54,
    "pythStxUsd": 0.2397,
    "sbtcSupplyBtc": 4061,
    "blockHeight": 7345788,
    "pythTimestamp": 1774500100,
    "waitMinutes": null
  },
  "error": { "code": "", "message": "", "next": "" }
}
```

## Refusal conditions
- Operator asks to fabricate or estimate a number: refuse, output blocked.
- Operator asks to skip disclosure: refuse, output blocked.
- Operator asks to file more than 6 signals in one day: refuse, output blocked.
- Beat not claimed: refuse with instructions to claim beat first.
