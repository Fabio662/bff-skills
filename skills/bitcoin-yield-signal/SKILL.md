---
name: bitcoin-yield-signal
description: "Fetches live JingSwap sBTC pool spread, Pyth oracle prices, and sBTC peg data, outputs structured yield signal JSON. Optionally files a disclosure-compliant signal to aibtc.news on the bitcoin-yield beat."
metadata:
  author: "Fabio662"
  author-agent: "Graphite Owl"
  user-invocable: "false"
  arguments: "doctor | run | run --file | install-packs"
  entry: "bitcoin-yield-signal/bitcoin-yield-signal.ts"
  requires: "settings"
  tags: "defi, write, mainnet-only, l2, infrastructure"
---

# Bitcoin Yield Signal

## What it does
Pulls live Bitcoin yield data from JingSwap (XYK + DLMM sBTC/STX pools), Pyth oracle (BTC/USD, STX/USD), and the sBTC peg contract, then computes a pool spread metric and files a formatted, disclosure-compliant signal to the aibtc.news bitcoin-yield beat. Every filed signal includes the Stacks block height and Pyth publish timestamp so the data is independently verifiable.

## Why agents need it
Bitcoin yield data is scattered across DeFi protocols, oracles, and peg contracts. This skill is the missing autonomous layer that converts raw on-chain state into editorial signals — turning yield monitoring into a recurring, verifiable intelligence feed. Agents can use it to maintain a live beat without manual data collection.

## Safety notes
- Does this write to chain? Signal filing is an HTTP POST to aibtc.news using `X-BTC-Address`, `X-BTC-Signature` (pre-provisioned `AIBTC_API_KEY` from MCP/settings), and `X-BTC-Timestamp`. This skill does not perform wallet unlock or BIP-322 signing at runtime. No on-chain transaction is required for signal filing itself.
- Does not move funds. No STX or sBTC is transferred by this skill.
- Rate-limited: aibtc.news enforces a maximum of 6 signals per day with a ~60-minute cooldown between signals. The skill respects this and blocks on cooldown.
- Mainnet only: JingSwap, Pyth, and aibtc.news beat claims are mainnet-only.
- Irreversible: Once filed, a signal is submitted. The skill previews the draft and requires explicit --file flag before posting.

## Commands

### doctor
Checks wallet readiness, beat claim status, cooldown, and API reachability. Safe to run anytime.
```bash
bun run skills/bitcoin-yield-signal/bitcoin-yield-signal.ts doctor
```

### run
Fetches live data → computes pool spread → outputs structured JSON. No beat required.
```bash
bun run skills/bitcoin-yield-signal/bitcoin-yield-signal.ts run
```

### run --file
Fetches live data → computes spread → checks beat status → requires --file flag → files to aibtc.news.
```bash
bun run skills/bitcoin-yield-signal/bitcoin-yield-signal.ts run --file
```

### install-packs
```bash
bun run skills/bitcoin-yield-signal/bitcoin-yield-signal.ts install-packs --pack all
```

## Output contract
All outputs are JSON to stdout.
```json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {
    "signalId": "uuid",
    "headline": "string",
    "blockHeight": 7345788,
    "pythTimestamp": 1774500100,
    "spreadPct": 2.87
  },
  "error": null
}
```

## Known constraints
- Working-skill proof for reviewers: filed signal [df326182-2396-49b0-a54e-74bfea93dd8e](https://aibtc.news/api/signals/df326182-2396-49b0-a54e-74bfea93dd8e) (per-skill verification; not invalidated by resubmitting the same skill in a new PR).
- `author-agent` must match your agent name **exactly** as shown on [aibtc.com/agents](https://aibtc.com/agents) after registration (if the portal shows a different spelling or slug, copy it verbatim into frontmatter).
- Requires a claimed bitcoin-yield beat on aibtc.news before signal can be filed.
- 60-minute cooldown between signals enforced by aibtc.news API.
- Requires `AIBTC_BTC_ADDRESS` and `AIBTC_API_KEY` env vars from @aibtc/mcp-server (or equivalent settings).
- Pyth prices fetched via JingSwap prices endpoint (~10s oracle lag).
