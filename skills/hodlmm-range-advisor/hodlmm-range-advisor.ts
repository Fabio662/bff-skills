#!/usr/bin/env bun
/**
 * hodlmm-range-advisor
 * Scans ALL active Bitflow HODLMM pools, computes optimal bin range per pool using
 * realized volatility from live bin liquidity distribution, then cross-references
 * against YieldAgentX402 gateway Stacks alternatives to rank risk-adjusted entry options.
 *
 * Commands: doctor | run [--pool-id <id>] [--tightness aggressive|moderate|conservative] | install-packs
 * Output: strict JSON to stdout
 * Author: Graphite Owl (YieldAgent) — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt
 * Gateway: api.yieldagentx402.app (YieldAgentX402 multi-chain adapter registry)
 */

const HODLMM_API  = "https://bff.bitflowapis.finance";
const HIRO_API    = "https://api.mainnet.hiro.so";
const GATEWAY_API = "https://api.yieldagentx402.app";
const DEFAULT_POOL = "dlmm_1";

// Range width = vol_width * multiplier
const TIGHTNESS_MULT: Record<string, number> = {
  aggressive:   0.75,
  moderate:     1.25,
  conservative: 2.0,
};

// ── helpers ────────────────────────────────────────────────────────────────────

function out(result: object): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit((result as any).status === "success" ? 0 : 1);
}

function fail(code: string, message: string, next: string, data: object = {}): never {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ── API fetchers ───────────────────────────────────────────────────────────────

async function fetchPoolList(): Promise<any[]> {
  const r = await fetch(`${HODLMM_API}/api/quotes/v1/pools`);
  if (!r.ok) throw new Error(`HODLMM pools API: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j?.pools ?? []);
}

async function fetchBins(poolId: string): Promise<any[]> {
  const r = await fetch(`${HODLMM_API}/api/quotes/v1/bins/${poolId}`);
  if (!r.ok) throw new Error(`HODLMM bins API (${poolId}): HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j?.bins ?? []);
}

async function fetchAppPools(): Promise<any[]> {
  const r = await fetch(`${HODLMM_API}/api/app/v1/pools`);
  if (!r.ok) throw new Error(`Bitflow app pools API: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j?.data ?? []);
}

async function fetchGas(): Promise<number> {
  const r = await fetch(`${HIRO_API}/v2/fees/transfer`);
  if (!r.ok) throw new Error(`Hiro fees API: HTTP ${r.status}`);
  const j = await r.json();
  return typeof j === "number" ? j : Number(j?.estimated_cost_scalar ?? 1);
}

async function fetchGatewayAlternatives(): Promise<any[]> {
  const r = await fetch(`${GATEWAY_API}/api/adapters/discover?chain=stacks`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Gateway API: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.adapters) ? j.adapters : [];
}

// ── volatility computation ─────────────────────────────────────────────────────

function computeVolatilityRange(bins: any[], activeBin: number): {
  p10: number; p90: number; volWidth: number; liquidBins: number;
} | null {
  // Focus on ±100 bins around the active bin — the recent trading zone.
  const nearby = bins.filter((b) => Math.abs(Number(b.bin_id ?? b.id ?? 0) - activeBin) <= 100);

  const liquidBinIds = nearby
    .filter((b) => Number(b.liquidity ?? b.total_liquidity ?? b.reserve_x ?? b.amount_x ?? 0) > 0)
    .map((b) => Number(b.bin_id ?? b.id))
    .filter((id) => isFinite(id))
    .sort((a, b) => a - b);

  if (liquidBinIds.length < 5) return null;

  const p10 = liquidBinIds[Math.floor(liquidBinIds.length * 0.1)];
  const p90 = liquidBinIds[Math.floor(liquidBinIds.length * 0.9)];
  const volWidth = Math.max(p90 - p10, 2);

  return { p10, p90, volWidth, liquidBins: liquidBinIds.length };
}

function scorePool(
  activeBin: number,
  bins: any[],
  appPool: any,
  tightness: string,
  gasFee: number,
): {
  recommended_range: { min: number; max: number; width: number };
  tightness: string;
  vol_range: { p10: number; p90: number; width: number; liquid_bins: number; low_confidence: boolean };
  estimated_in_range_pct: number;
  pool_apr_24h_pct: number;
  projected_apr_pct: number;
  gas_estimated_stx: number;
} | null {
  const vol = computeVolatilityRange(bins, activeBin);
  if (!vol) return null;

  const mult       = TIGHTNESS_MULT[tightness] ?? TIGHTNESS_MULT.moderate;
  const halfWidth  = Math.ceil((vol.volWidth / 2) * mult);
  const recMin     = activeBin - halfWidth;
  const recMax     = activeBin + halfWidth;
  const rangeWidth = recMax - recMin;

  const inRangePct  = Math.min(95, Math.round((rangeWidth / vol.volWidth) * 0.85 * 100));
  const poolApr     = Number(appPool?.apr24h ?? appPool?.apr_24h ?? appPool?.apr ?? 0);
  const projectedApr = +(poolApr * (inRangePct / 100)).toFixed(2);
  const gasEstStx   = +(gasFee * 500 * 2 * 3 * 1.2 / 1e6).toFixed(4);

  return {
    recommended_range: { min: recMin, max: recMax, width: rangeWidth },
    tightness,
    vol_range: { p10: vol.p10, p90: vol.p90, width: vol.volWidth, liquid_bins: vol.liquidBins, low_confidence: vol.liquidBins < 10 },
    estimated_in_range_pct: inRangePct,
    pool_apr_24h_pct: poolApr,
    projected_apr_pct: projectedApr,
    gas_estimated_stx: gasEstStx,
  };
}

// ── commands ───────────────────────────────────────────────────────────────────

async function doctor() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const pools = await fetchPoolList();
    checks.hodlmm_pools = { ok: pools.length > 0, detail: `${pools.length} active HODLMM pools` };
  } catch (e) { checks.hodlmm_pools = { ok: false, detail: String(e) }; }

  try {
    const bins = await fetchBins(DEFAULT_POOL);
    checks.hodlmm_bins = { ok: bins.length > 0, detail: `${bins.length} bins for ${DEFAULT_POOL}` };
  } catch (e) { checks.hodlmm_bins = { ok: false, detail: String(e) }; }

  try {
    const pools = await fetchAppPools();
    const p = pools.find((x) => (x.poolId ?? x.id) === DEFAULT_POOL);
    const apr = p?.apr24h ?? p?.apr ?? "?";
    const tvl = p?.tvlUsd ?? p?.tvl ?? "?";
    checks.app_pool = { ok: !!p, detail: `${DEFAULT_POOL} TVL: $${tvl}, APR (24h): ${apr}%` };
  } catch (e) { checks.app_pool = { ok: false, detail: String(e) }; }

  try {
    const gas = await fetchGas();
    checks.hiro_fees = { ok: true, detail: `${gas} µSTX/byte` };
  } catch (e) { checks.hiro_fees = { ok: false, detail: String(e) }; }

  try {
    const alts = await fetchGatewayAlternatives();
    checks.gateway = { ok: alts.length > 0, detail: `${alts.length} Stacks alternatives from YieldAgentX402 gateway` };
  } catch (e) { checks.gateway = { ok: false, detail: String(e) }; }

  const allOk = Object.values(checks).every((c) => c.ok);
  out({
    status: allOk ? "success" : "error",
    action: allOk
      ? "All 5 data sources reachable. Run: bun run hodlmm-range-advisor/hodlmm-range-advisor.ts run"
      : "Fix failing checks before running.",
    data: { checks },
    error: allOk ? null : { code: "DOCTOR_FAIL", message: "One or more checks failed", next: "Fix checks above" },
  });
}

async function run(targetPoolId: string, tightness: string) {
  // Fetch all data sources in parallel
  let poolList: any[], appPools: any[], gasFee: number, alternatives: any[];
  try {
    [poolList, appPools, gasFee, alternatives] = await Promise.all([
      fetchPoolList(),
      fetchAppPools(),
      fetchGas(),
      fetchGatewayAlternatives().catch(() => []), // gateway fails open
    ]);
  } catch (e) {
    fail("FETCH_FAIL", String(e), "re-run doctor to identify which source is down");
  }

  // Determine which pools to evaluate
  const poolsToScore = targetPoolId === "all"
    ? poolList.map((p: any) => p.pool_id ?? p.id).filter(Boolean)
    : [targetPoolId];

  // Score each pool — fetch bins in parallel
  const binsResults = await Promise.allSettled(
    poolsToScore.map((pid) => fetchBins(pid).then((bins) => ({ pid, bins })))
  );

  const scoredPools: any[] = [];

  for (const result of binsResults) {
    if (result.status !== "fulfilled") continue;
    const { pid, bins } = result.value;

    const poolMeta = poolList.find((p: any) => (p.pool_id ?? p.id) === pid);
    const appPool  = appPools.find((p: any) => (p.poolId ?? p.id) === pid);
    if (!poolMeta || !appPool) continue;

    const activeBin = Number(poolMeta.active_bin ?? poolMeta.active_bin_id ?? 0);
    if (!activeBin) continue;

    // Score at requested tightness (or all three if pool-id is "all")
    const tightnessLevels = targetPoolId === "all"
      ? ["aggressive", "moderate", "conservative"]
      : [tightness];

    for (const t of tightnessLevels) {
      const score = scorePool(activeBin, bins, appPool, t, gasFee);
      if (!score) continue;

      const tokenX = appPool?.tokens?.tokenX?.symbol ?? "?";
      const tokenY = appPool?.tokens?.tokenY?.symbol ?? "?";

      scoredPools.push({
        pool_id:        pid,
        pool_name:      `${tokenX}/${tokenY}`,
        active_bin:     activeBin,
        pool_tvl_usd:   appPool?.tvlUsd ?? null,
        pool_vol_24h_usd: appPool?.volumeUsd1d ?? null,
        pool_fee_bps:   appPool?.baseFee != null ? Math.round(appPool.baseFee * 10000) : null,
        ...score,
      });
    }
  }

  if (scoredPools.length === 0) {
    fail("NO_RESULTS", "Could not score any pools — check pool-id and try again", "re-run doctor");
  }

  // Rank by projected APR descending
  scoredPools.sort((a, b) => b.projected_apr_pct - a.projected_apr_pct);

  const best = scoredPools[0];

  // Format gateway alternatives summary
  const altSummary = alternatives.slice(0, 7).map((a: any) => ({
    protocol: a.name ?? a.key,
    category: a.category,
    apy_range: `${a.apyRangeMin ?? "?"}–${a.apyRangeMax ?? "?"}%`,
    apy_max: Number(a.apyRangeMax ?? 0),
  }));
  const bestAltApy = Math.max(...altSummary.map((a) => a.apy_max), 0);
  const hodlmmEdge = best ? +(best.projected_apr_pct - bestAltApy).toFixed(2) : 0;

  const action = best
    ? `Best entry: ${best.pool_name} ${best.tightness} bins ${best.recommended_range.min}–${best.recommended_range.max} → projected ${best.projected_apr_pct}% APR (~${best.estimated_in_range_pct}% in-range).` +
      (hodlmmEdge > 0
        ? ` HODLMM leads Stacks alternatives by ${hodlmmEdge}pp (best alt: ${bestAltApy}% APY max).`
        : ` Best Stacks alt: ${bestAltApy}% APY max — consider alternatives.`)
    : "No scoreable pools found.";

  out({
    status: "success",
    action,
    data: {
      best_entry:         best ?? null,
      all_pools_ranked:   scoredPools,
      stacks_alternatives: altSummary,
      hodlmm_vs_best_alt: {
        hodlmm_projected_apr: best?.projected_apr_pct ?? null,
        best_alt_apy_max:     bestAltApy,
        edge_pp:              hodlmmEdge,
        verdict:              hodlmmEdge > 0 ? "HODLMM leads" : "consider alternatives",
      },
      data_sources: ["bitflow-hodlmm-api", "bitflow-app-api", "hiro-fees-api", "yieldagentx402-gateway"],
    },
    error: null,
  });
}

async function installPacks() {
  out({
    status: "success",
    action: "No packs needed. Uses Bitflow, Hiro, and YieldAgentX402 gateway public APIs directly.",
    data: { deps: ["bun (runtime — https://bun.sh)"] },
    error: null,
  });
}

// ── entrypoint ─────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const cmd       = args[0];
const poolIdx   = args.indexOf("--pool-id");
const poolId    = poolIdx >= 0 ? (args[poolIdx + 1] ?? DEFAULT_POOL) : DEFAULT_POOL;
const tightIdx  = args.indexOf("--tightness");
const rawTight  = tightIdx >= 0 ? (args[tightIdx + 1] ?? "moderate") : "moderate";
const tightness = Object.keys(TIGHTNESS_MULT).includes(rawTight) ? rawTight : "moderate";

if      (cmd === "doctor")        await doctor();
else if (cmd === "run")           await run(poolId, tightness);
else if (cmd === "install-packs") await installPacks();
else fail(
  "UNKNOWN_CMD",
  `Unknown command: "${cmd ?? "(none)"}"`,
  "Usage: doctor | run [--pool-id <id|all>] [--tightness aggressive|moderate|conservative] | install-packs"
);
