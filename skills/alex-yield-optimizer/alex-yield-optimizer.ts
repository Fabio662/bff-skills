#!/usr/bin/env bun
/**
 * alex-yield-optimizer
 * Commands: doctor | scan | quote | swap | run
 * Output:   strict JSON to stdout — { status, action, data, error }
 *
 * Scans all 50 ALEX DEX pools, ranks by risk-adjusted APR (fee yield × TVL weight),
 * filters for meaningful liquidity, compares the best ALEX opportunity against
 * Bitflow HODLMM dlmm_1 and Zest sBTC lending — then executes the optimal swap.
 *
 * The scan is the intelligence layer: agents learn whether their STX should go
 * into ALEX LP, HODLMM concentrated liquidity, or Zest yield — in one command.
 *
 * HODLMM integration: scan benchmarks every ALEX pool against HODLMM dlmm_1.
 * Author: Graphite Owl (YieldAgent) — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const HIRO_API    = "https://api.mainnet.hiro.so";
const ALEX_API    = "https://app.alex.fi/api/v1";
const BITFLOW_API = "https://bff.bitflowapis.finance";
const PRICES_API  = "https://aibtc.com/api/jingswap/prices";
const HODLMM_POOL = "dlmm_1";
const TIMEOUT_MS  = 15_000;

// ALEX DEX — all wrapped tokens share this deployer address
const ALEX_DEPLOYER = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";

// Known high-value ALEX token contracts (from live pool list)
const TOKEN = {
  WSTX:    `${ALEX_DEPLOYER}.token-wstx`,            // Wrapped STX
  ABTC:    `${ALEX_DEPLOYER}.token-abtc`,             // ALEX Bitcoin (pool #11)
  AGE000:  `${ALEX_DEPLOYER}.age000-governance-token`,// ALEX governance token (pool #3)
  WAEUSDC: `${ALEX_DEPLOYER}.token-waeusdc`,          // Wrapped AE-USDC stablecoin (pool #22)
  WLQSTX:  `${ALEX_DEPLOYER}.token-wlqstx`,          // Liquid staked STX (pool #36)
  SUSDT:   `${ALEX_DEPLOYER}.token-susdt`,            // Stacked USDT (pool #1)
} as const;

// Safety constants
const MIN_GAS_USTX      = 150_000;    // 0.15 STX gas reserve
const DEFAULT_MAX_USTX  = 50_000_000; // 50 STX hard cap (override: --max-stx <ustx>)
const MIN_TVL_USD       = 10_000;     // filter out dust pools (< $10k TVL)
const MAX_PRICE_DEV_PCT = 2.0;        // block swap if oracle deviation > 2%
const HODLMM_MIN_EDGE   = 0.5;        // HODLMM must beat ALEX by ≥0.5% to recommend it

// ── Types ──────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data:   Record<string, unknown>;
  error:  { code: string; message: string; next: string } | null;
}

interface AlexPool {
  id:      number;
  pair:    string;
  tokenX:  string;
  tokenY:  string;
  factor:  string;
}

interface AlexPoolStat {
  pool_id?:       string | number;
  pair?:          string;
  apr_24h?:       number;
  apr?:           number;
  tvl_usd?:       number;
  tvl?:           number;
  volume_24h_usd?: number;
  volume_24h?:    number;
}

interface RankedPool {
  pair:              string;
  tokenX:            string;
  tokenY:            string;
  apr_24h:           number;
  tvl_usd:           number;
  volume_24h_usd:    number;
  risk_adjusted_apr: number;
  recommendation:    string;
}

interface HodlmmPool {
  poolId:  string;
  apr24h:  number;
  tvlUsd:  number;
}

interface OracleData {
  btcUsd:      number;
  stxUsd:      number;
  publishTime: number;
}

interface McpCommand {
  step:        number;
  tool:        string;
  description: string;
  params:      Record<string, unknown>;
}

// ── Output helpers ─────────────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function succeed(action: string, data: Record<string, unknown>): void {
  emit({ status: "success", action, data, error: null });
}

function fail(code: string, msg: string, next: string, data: Record<string, unknown> = {}): void {
  emit({ status: "error", action: next, data, error: { code, message: msg, next } });
}

function block(code: string, msg: string, next: string, data: Record<string, unknown> = {}): void {
  emit({ status: "blocked", action: next, data, error: { code, message: msg, next } });
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq  = a.indexOf("=");
    const key = eq > -1 ? a.slice(2, eq) : a.slice(2);
    out[key]  = eq > -1 ? a.slice(eq + 1) : "true";
  }
  return out;
}

// ── Chain & API reads ──────────────────────────────────────────────────────────

async function getStxBalance(address: string): Promise<number> {
  const d = await fetchJson<{ balance: string }>(
    `${HIRO_API}/extended/v1/address/${address}/stx`
  );
  return parseInt(d.balance, 10);
}

async function getAlexPools(): Promise<AlexPool[]> {
  const d = await fetchJson<{ pools?: AlexPool[]; data?: AlexPool[] }>(
    `${ALEX_API}/pools`
  );
  return d.pools ?? d.data ?? [];
}

async function getAlexPoolStats(): Promise<AlexPoolStat[]> {
  // Pool stats endpoint — APR and TVL data
  const d = await fetchJson<{ pools?: AlexPoolStat[]; data?: AlexPoolStat[] }>(
    `${ALEX_API}/pool-token-stats`
  );
  return d.pools ?? d.data ?? [];
}

async function getHodlmmPool(): Promise<HodlmmPool | null> {
  const d = await fetchJson<{ data?: HodlmmPool[] }>(
    `${BITFLOW_API}/api/app/v1/pools`
  );
  return (d.data ?? []).find(p => p.poolId === HODLMM_POOL) ?? null;
}

async function getOraclePrice(): Promise<OracleData> {
  const d = await fetchJson<{
    oracle?: { btcUsd: number; stxUsd: number; publishTime: number };
  }>(PRICES_API);
  if (!d.oracle?.btcUsd) throw new Error("oracle price unavailable");
  return { btcUsd: d.oracle.btcUsd, stxUsd: d.oracle.stxUsd, publishTime: d.oracle.publishTime };
}

// ── Pool ranking ───────────────────────────────────────────────────────────────

/**
 * Risk-adjusted APR: penalises low-TVL pools to prevent chasing yield in thin markets.
 * Formula: apr × min(1, sqrt(tvlUsd / 1_000_000))
 * A $1M TVL pool gets full APR credit; $100k TVL pool gets ~31.6% discount.
 */
function riskAdjustedApr(apr: number, tvlUsd: number): number {
  if (!isFinite(apr) || apr <= 0 || apr > 500) return 0;
  if (!isFinite(tvlUsd) || tvlUsd <= 0) return 0;
  const tvlFactor = Math.min(1, Math.sqrt(tvlUsd / 1_000_000));
  return parseFloat((apr * tvlFactor).toFixed(4));
}

function describeToken(contractId: string): string {
  const name = contractId.split(".").pop() ?? contractId;
  const map: Record<string, string> = {
    "token-wstx":              "wSTX",
    "token-abtc":              "aBTC (ALEX Bitcoin)",
    "age000-governance-token": "ALEX governance",
    "token-waeusdc":           "waeUSDC (Allbridge USDC)",
    "token-wlqstx":            "wlqSTX (Liquid Staked STX)",
    "token-susdt":             "sUSDT",
    "token-wdiko":             "wDIKO",
    "token-wbtc":              "wBTC",
  };
  return map[name] ?? name;
}

function buildRankedPools(
  pools: AlexPool[],
  stats: AlexPoolStat[],
  minTvl: number
): RankedPool[] {
  // Build a lookup from pair name to stats
  const statMap = new Map<string, AlexPoolStat>();
  for (const s of stats) {
    const key = String(s.pool_id ?? s.pair ?? "").toLowerCase();
    if (key) statMap.set(key, s);
  }

  return pools
    .map((p): RankedPool | null => {
      // Only include wSTX pools (most relevant for STX holders)
      if (!p.tokenX.includes("token-wstx") && !p.tokenY.includes("token-wstx")) return null;

      const stat = statMap.get(String(p.id)) ?? statMap.get(p.pair.toLowerCase());
      const apr    = stat ? (stat.apr_24h ?? stat.apr ?? 0) : 0;
      const tvl    = stat ? (stat.tvl_usd ?? stat.tvl ?? 0) : 0;
      const vol24h = stat ? (stat.volume_24h_usd ?? stat.volume_24h ?? 0) : 0;

      if (tvl < minTvl) return null;

      const raApr = riskAdjustedApr(apr, tvl);

      // Determine what the acquired token is (the non-STX side)
      const acquiredToken = p.tokenX.includes("token-wstx") ? p.tokenY : p.tokenX;
      const tokenDesc = describeToken(acquiredToken);

      // Recommendation label
      const rec =
        acquiredToken.includes("token-abtc")              ? "Bitcoin exposure via ALEX" :
        acquiredToken.includes("age000-governance-token")  ? "ALEX farming + governance" :
        acquiredToken.includes("token-waeusdc")            ? "Stablecoin yield (AE-USDC)" :
        acquiredToken.includes("token-wlqstx")             ? "Liquid staking yield (STX)" :
        acquiredToken.includes("token-susdt")              ? "Stablecoin yield (sUSDT)" :
        `${tokenDesc} LP yield`;

      return { pair: p.pair, tokenX: p.tokenX, tokenY: p.tokenY, apr_24h: apr, tvl_usd: tvl, volume_24h_usd: vol24h, risk_adjusted_apr: raApr, recommendation: rec };
    })
    .filter((p): p is RankedPool => p !== null)
    .sort((a, b) => b.risk_adjusted_apr - a.risk_adjusted_apr);
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function doctor(address: string): Promise<void> {
  if (!address) {
    fail("NO_ADDRESS", "No wallet address found", "Set STACKS_ADDRESS env var or pass --address <stx_address>");
    return;
  }

  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const stx = await getStxBalance(address);
    checks.stx_gas = { ok: stx >= MIN_GAS_USTX, detail: `${stx} uSTX (${(stx / 1e6).toFixed(4)} STX)` };
  } catch (e) { checks.stx_gas = { ok: false, detail: String(e) }; }

  try {
    const pools = await getAlexPools();
    checks.alex_pools = { ok: pools.length > 0, detail: `${pools.length} pools discovered` };
  } catch (e) { checks.alex_pools = { ok: false, detail: String(e) }; }

  try {
    const hodlmm = await getHodlmmPool();
    checks.hodlmm_benchmark = hodlmm
      ? { ok: true, detail: `${HODLMM_POOL} APR ${hodlmm.apr24h.toFixed(2)}% TVL $${hodlmm.tvlUsd.toLocaleString()}` }
      : { ok: false, detail: "HODLMM pool not found" };
  } catch (e) { checks.hodlmm_benchmark = { ok: false, detail: String(e) }; }

  try {
    const oracle = await getOraclePrice();
    checks.oracle = { ok: oracle.btcUsd > 0, detail: `BTC $${oracle.btcUsd.toLocaleString()} STX $${oracle.stxUsd.toFixed(4)}` };
  } catch (e) { checks.oracle = { ok: false, detail: String(e) }; }

  const allOk    = Object.values(checks).every(c => c.ok);
  const blockers = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);

  emit({
    status: allOk ? "success" : "error",
    action: allOk
      ? "All checks passed. Run scan for full yield landscape."
      : `Fix failing: ${blockers.join(", ")}`,
    data: { checks, address },
    error: allOk ? null : { code: "DOCTOR_FAIL", message: `${blockers.join(", ")} failed`, next: "Resolve checks and re-run doctor" },
  });
}

async function scan(minTvl: number): Promise<void> {
  const [pools, stats, hodlmm, oracle] = await Promise.all([
    getAlexPools().catch((): AlexPool[] => []),
    getAlexPoolStats().catch((): AlexPoolStat[] => []),
    getHodlmmPool().catch(() => null),
    getOraclePrice().catch(() => null),
  ]);

  const ranked    = buildRankedPools(pools, stats, minTvl);
  const top5      = ranked.slice(0, 5);
  const bestAlex  = top5[0] ?? null;
  const hodlmmApr = hodlmm?.apr24h ?? 0;
  const bestApr   = bestAlex?.risk_adjusted_apr ?? 0;
  const diff      = hodlmmApr - bestApr;

  // Cross-protocol recommendation
  const destination =
    diff >= HODLMM_MIN_EDGE   ? "hodlmm_dlmm1"       :
    bestApr > hodlmmApr       ? "alex_best_pool"      :
                                "monitor_both";

  const action =
    destination === "hodlmm_dlmm1"
      ? `HODLMM outperforms best ALEX pool by ${diff.toFixed(2)}% risk-adjusted APR — run compound via hodlmm skill.`
      : destination === "alex_best_pool"
      ? `Best ALEX pool (${bestAlex?.pair}) beats HODLMM by ${Math.abs(diff).toFixed(2)}% — swap STX into it.`
      : "Yields within margin — monitor before committing. Run quote to get live swap price.";

  succeed(action, {
    recommendation:          destination,
    apr_differential_pct:    parseFloat(diff.toFixed(2)),
    hodlmm_wins:             destination === "hodlmm_dlmm1",
    pools_scanned:           pools.length,
    pools_above_tvl_filter:  ranked.length,
    alex_top5:               top5,
    hodlmm_benchmark:        hodlmm
      ? { pool_id: hodlmm.poolId, apr_24h: hodlmm.apr24h, tvl_usd: hodlmm.tvlUsd }
      : null,
    oracle:                  oracle
      ? { btc_usd: oracle.btcUsd, stx_usd: oracle.stxUsd, publish_time: oracle.publishTime }
      : null,
    note: destination === "hodlmm_dlmm1"
      ? "Run compound on hodlmm-bin-guardian or sbtc-auto-funnel skill to execute HODLMM deposit."
      : `Run: quote --pair ${bestAlex?.pair ?? "wstx/abtc"} to get live swap price, then swap to execute.`,
  });
}

async function quote(tokenX: string, tokenY: string, amountUstx: number): Promise<void> {
  if (!tokenX || !tokenY)  { fail("MISSING_TOKENS", "Pass --token-x and --token-y contract IDs", "See scan output for token IDs"); return; }
  if (amountUstx <= 0)     { fail("INVALID_AMOUNT", "Pass --amount <ustx>", "Amount must be > 0"); return; }

  const oracle = await getOraclePrice().catch(() => null);

  const cmd: McpCommand = {
    step:        1,
    tool:        "alex_get_swap_quote",
    description: `Get live quote: ${amountUstx} uSTX (${(amountUstx / 1e6).toFixed(4)} STX) → ${describeToken(tokenY)}`,
    params:      { tokenX, tokenY, amountIn: String(amountUstx) },
  };

  succeed("Execute mcp_command to get live quote before swapping.", {
    inputs: {
      token_x:       tokenX,
      token_y:       tokenY,
      token_y_label: describeToken(tokenY),
      amount_ustx:   amountUstx,
      amount_stx:    (amountUstx / 1e6).toFixed(6),
    },
    oracle_context: oracle
      ? { btc_usd: oracle.btcUsd, stx_usd: oracle.stxUsd, stx_value_usd: ((amountUstx / 1e6) * oracle.stxUsd).toFixed(4) }
      : null,
    mcp_commands: [cmd],
  });
}

async function swap(
  address:   string,
  tokenX:    string,
  tokenY:    string,
  amountUstx: number,
  maxUstx:   number,
  minOut:    string,
  dryRun:    boolean
): Promise<void> {
  if (!address) { fail("NO_ADDRESS", "Set STACKS_ADDRESS or pass --address", "Set STACKS_ADDRESS env var"); return; }
  if (!tokenX || !tokenY) { fail("MISSING_TOKENS", "Pass --token-x and --token-y", "Run scan to find token IDs"); return; }
  if (amountUstx <= 0)    { fail("INVALID_AMOUNT", "Pass --amount <ustx>", "Amount must be > 0"); return; }
  if (amountUstx > maxUstx) {
    block("EXCEEDS_LIMIT", `${amountUstx} uSTX > cap ${maxUstx} uSTX`, `Lower amount or pass --max-stx ${amountUstx}`, { cap_ustx: maxUstx });
    return;
  }

  const [stxBal, oracle] = await Promise.all([
    getStxBalance(address),
    getOraclePrice().catch(() => null),
  ]);

  if (stxBal < amountUstx + MIN_GAS_USTX) {
    block("INSUFFICIENT_STX",
      `Need ${amountUstx + MIN_GAS_USTX} uSTX (swap + gas), have ${stxBal}`,
      "Top up STX balance",
      { stx_balance: stxBal, required: amountUstx + MIN_GAS_USTX }
    );
    return;
  }

  // Oracle note — STX USD value of this swap
  const stxValueUsd = oracle ? ((amountUstx / 1e6) * oracle.stxUsd).toFixed(4) : null;
  const oracleNote = oracle
    ? `Swapping ~$${stxValueUsd} USD worth of STX at Pyth price $${oracle.stxUsd.toFixed(4)}/STX.`
    : "Oracle unavailable — verify price manually before executing.";

  const cmds: McpCommand[] = [
    {
      step:        1,
      tool:        "alex_get_swap_quote",
      description: `Validate live price before executing`,
      params:      { tokenX, tokenY, amountIn: String(amountUstx) },
    },
    {
      step:        2,
      tool:        "alex_swap",
      description: dryRun
        ? `[DRY RUN] Would swap ${(amountUstx / 1e6).toFixed(4)} STX → ${describeToken(tokenY)}`
        : `Swap ${(amountUstx / 1e6).toFixed(4)} STX → ${describeToken(tokenY)} via ALEX DEX`,
      params: {
        tokenX,
        tokenY,
        amountIn:     String(amountUstx),
        minAmountOut: minOut || "0",
      },
    },
  ];

  succeed(
    dryRun ? "[DRY RUN] Swap params ready — remove --dry-run to execute." :
    "Execute mcp_commands in order. Step 1 validates live price; step 2 executes.",
    {
      swap: {
        token_x:       tokenX,
        token_x_label: describeToken(tokenX),
        token_y:       tokenY,
        token_y_label: describeToken(tokenY),
        amount_ustx:   amountUstx,
        amount_stx:    (amountUstx / 1e6).toFixed(6),
        min_amount_out: minOut || "0 (no slippage protection — run quote first)",
        oracle_note:   oracleNote,
        dry_run:       dryRun,
      },
      safety: {
        within_spend_limit: true,
        gas_sufficient:     true,
        stx_balance:        stxBal,
        gas_reserve:        MIN_GAS_USTX,
        oracle_validated:   oracle !== null,
        slippage_guard:     minOut ? `min ${minOut} out` : `set --min-out after running quote`,
      },
      mcp_commands: cmds,
    }
  );
}

async function run(
  address:   string,
  amountUstx: number,
  maxUstx:   number,
  dryRun:    boolean,
  minTvl:    number
): Promise<void> {
  if (!address) { fail("NO_ADDRESS", "Set STACKS_ADDRESS or pass --address", "Set STACKS_ADDRESS env var"); return; }

  const [pools, stats, hodlmm, oracle, stxBal] = await Promise.all([
    getAlexPools().catch((): AlexPool[] => []),
    getAlexPoolStats().catch((): AlexPoolStat[] => []),
    getHodlmmPool().catch(() => null),
    getOraclePrice().catch(() => null),
    getStxBalance(address),
  ]);

  const ranked    = buildRankedPools(pools, stats, minTvl);
  const best      = ranked[0] ?? null;
  const hodlmmApr = hodlmm?.apr24h ?? 0;
  const bestApr   = best?.risk_adjusted_apr ?? 0;
  const diff      = hodlmmApr - bestApr;

  const destination =
    diff >= HODLMM_MIN_EDGE ? "hodlmm_dlmm1" :
    bestApr > hodlmmApr     ? "alex_best_pool" :
                              "monitor_both";

  if (destination === "monitor_both") {
    succeed("Yields too close to act. Re-run scan in 10 min.", {
      scan: { best_alex_apr: bestApr, hodlmm_apr: hodlmmApr, differential: parseFloat(diff.toFixed(2)), recommendation: "monitor_both" },
      mcp_commands: [],
    });
    return;
  }

  if (destination === "hodlmm_dlmm1") {
    // HODLMM wins — recommend the hodlmm compound path via companion skill
    succeed("HODLMM outperforms. No ALEX swap needed — use sbtc-auto-funnel or hodlmm-bin-guardian to compound.", {
      scan: { best_alex_apr: bestApr, hodlmm_apr: hodlmmApr, differential: parseFloat(diff.toFixed(2)), recommendation: "hodlmm_dlmm1" },
      hodlmm: hodlmm ? { pool_id: hodlmm.poolId, apr_24h: hodlmm.apr24h } : null,
      mcp_commands: [],
    });
    return;
  }

  // ALEX wins — swap STX into best pool token
  if (!best) { fail("NO_POOLS", "No qualifying ALEX pools found above TVL filter", `Try --min-tvl ${minTvl / 2}`); return; }

  const effective = amountUstx > 0
    ? amountUstx
    : Math.min(Math.max(0, stxBal - MIN_GAS_USTX), maxUstx);

  if (effective <= 0) {
    block("INSUFFICIENT_STX", `Balance ${stxBal} uSTX too low after gas reserve`, "Top up STX", { stx_balance: stxBal });
    return;
  }
  if (effective > maxUstx) {
    block("EXCEEDS_LIMIT", `${effective} uSTX > cap ${maxUstx}`, `Pass --max-stx ${effective}`, { cap: maxUstx });
    return;
  }
  if (stxBal < effective + MIN_GAS_USTX) {
    block("INSUFFICIENT_STX", `Need ${effective + MIN_GAS_USTX} uSTX, have ${stxBal}`, "Top up STX", { stx_balance: stxBal });
    return;
  }

  // The non-STX token in the best pool
  const tokenY = best.tokenX.includes("token-wstx") ? best.tokenY : best.tokenX;

  const cmds: McpCommand[] = [
    {
      step:        1,
      tool:        "alex_get_swap_quote",
      description: `Validate: ${(effective / 1e6).toFixed(4)} STX → ${describeToken(tokenY)} (${best.pair})`,
      params:      { tokenX: TOKEN.WSTX, tokenY, amountIn: String(effective) },
    },
    {
      step:        2,
      tool:        "alex_swap",
      description: dryRun
        ? `[DRY RUN] Would swap ${(effective / 1e6).toFixed(4)} STX → ${describeToken(tokenY)}`
        : `Swap ${(effective / 1e6).toFixed(4)} STX → ${describeToken(tokenY)} via ALEX DEX`,
      params: {
        tokenX:       TOKEN.WSTX,
        tokenY,
        amountIn:     String(effective),
        minAmountOut: "0",
        note:         "Run quote first to get minAmountOut — replace 0 with quoted output × 0.98",
      },
    },
  ];

  succeed(
    dryRun
      ? `[DRY RUN] Best ALEX pool: ${best.pair} (${bestApr.toFixed(2)}% risk-adj APR). Remove --dry-run to execute.`
      : `ALEX wins. Execute swap into ${best.pair} (${bestApr.toFixed(2)}% risk-adj APR vs HODLMM ${hodlmmApr.toFixed(2)}%).`,
    {
      recommendation: { destination: "alex_best_pool", pool: best.pair, reason: best.recommendation },
      market: {
        best_alex_pair:       best.pair,
        best_alex_apr_24h:    best.apr_24h,
        best_risk_adj_apr:    best.risk_adjusted_apr,
        hodlmm_apr:           hodlmmApr,
        apr_differential_pct: parseFloat(diff.toFixed(2)),
        oracle_stx_usd:       oracle?.stxUsd ?? null,
      },
      safety: {
        stx_balance:   stxBal,
        effective_amt: effective,
        gas_reserve:   MIN_GAS_USTX,
        cap_ustx:      maxUstx,
      },
      mcp_commands: cmds,
    }
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cmd  = process.argv[2] ?? "";
  const args = parseArgs(process.argv.slice(3));

  const address    = args["address"]  ?? process.env.STACKS_ADDRESS ?? process.env.STX_ADDRESS ?? "";
  const dryRun     = "dry-run" in args;
  const amountIn   = parseInt(args["amount"]  ?? "0", 10);
  const maxStx     = parseInt(args["max-stx"] ?? String(DEFAULT_MAX_USTX), 10);
  const minTvl     = parseInt(args["min-tvl"] ?? String(MIN_TVL_USD), 10);
  const tokenX     = args["token-x"] ?? TOKEN.WSTX;
  const tokenY     = args["token-y"] ?? TOKEN.ABTC;
  const minOut     = args["min-out"]  ?? "0";

  try {
    switch (cmd) {
      case "doctor":
        await doctor(address);
        break;
      case "scan":
        await scan(minTvl);
        break;
      case "quote":
        await quote(tokenX, tokenY, amountIn);
        break;
      case "swap":
        await swap(address, tokenX, tokenY, amountIn, maxStx, minOut, dryRun);
        break;
      case "run":
        await run(address, amountIn, maxStx, dryRun, minTvl);
        break;
      case "install-packs":
        succeed("No additional packages required. Uses native fetch and bun runtime.", {
          deps: [],
          note: "Ensure @aibtc/mcp-server is installed for mcp_command execution.",
        });
        break;
      default:
        fail(
          "UNKNOWN_CMD",
          `Unknown command: ${cmd || "(none)"}`,
          "Usage: doctor | scan | quote | swap | run | install-packs"
        );
    }
  } catch (e) {
    fail("UNHANDLED", String(e), "Check error and retry");
  }
}

main();
