#!/usr/bin/env bun
/**
 * hodlmm-range-advisor
 * Computes optimal HODLMM bin range for new sBTC/STX deposits
 * using realized volatility from the live bin liquidity distribution.
 *
 * Commands: doctor | run [--pool-id <id>] [--tightness aggressive|moderate|conservative] | install-packs
 * Output: strict JSON to stdout
 * Author: Graphite Owl (YieldAgent) — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt
 */

const HODLMM_API = "https://bff.bitflowapis.finance";
const HIRO_API   = "https://api.mainnet.hiro.so";
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
  // Response is an array of pool objects
  return Array.isArray(j) ? j : (j?.pools ?? []);
}

async function fetchBins(poolId: string): Promise<any[]> {
  const r = await fetch(`${HODLMM_API}/api/quotes/v1/bins/${poolId}`);
  if (!r.ok) throw new Error(`HODLMM bins API (${poolId}): HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j?.bins ?? []);
}

async function fetchAppPool(poolId: string): Promise<any> {
  const r = await fetch(`${HODLMM_API}/api/app/v1/pools`);
  if (!r.ok) throw new Error(`Bitflow app pools API: HTTP ${r.status}`);
  const j = await r.json();
  // Response: { data: [...] } or array
  const pools: any[] = Array.isArray(j) ? j : (j?.data ?? []);
  const pool = pools.find((p) => (p.poolId ?? p.id ?? p.pool_id) === poolId);
  if (!pool) throw new Error(`Pool "${poolId}" not found in app pools API`);
  return pool;
}

async function fetchGas(): Promise<number> {
  const r = await fetch(`${HIRO_API}/v2/fees/transfer`);
  if (!r.ok) throw new Error(`Hiro fees API: HTTP ${r.status}`);
  const j = await r.json();
  // Response is either a number or { estimated_cost_scalar: number }
  return typeof j === "number" ? j : Number(j?.estimated_cost_scalar ?? 1);
}

// ── volatility computation ─────────────────────────────────────────────────────

function computeVolatilityRange(bins: any[], activeBin: number): {
  p10: number; p90: number; volWidth: number; liquidBins: number;
} | null {
  // Focus on ±100 bins around the active bin — this is the recent trading zone.
  // Bins far outside this window are old positions that don't reflect current vol.
  const nearby = bins.filter((b) => Math.abs(Number(b.bin_id ?? b.id ?? 0) - activeBin) <= 100);

  const liquidBinIds = nearby
    .filter((b) => {
      const liq = Number(
        b.liquidity ?? b.total_liquidity ?? b.reserve_x ?? b.amount_x ?? 0
      );
      return liq > 0;
    })
    .map((b) => Number(b.bin_id ?? b.id))
    .filter((id) => isFinite(id))
    .sort((a, b) => a - b);

  if (liquidBinIds.length < 5) return null;

  const p10 = liquidBinIds[Math.floor(liquidBinIds.length * 0.1)];
  const p90 = liquidBinIds[Math.floor(liquidBinIds.length * 0.9)];
  const volWidth = Math.max(p90 - p10, 2); // floor at 2 bins

  return { p10, p90, volWidth, liquidBins: liquidBinIds.length };
}

// ── commands ───────────────────────────────────────────────────────────────────

async function doctor() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const data = await fetchPoolList();
    const count = data?.pools?.length ?? (Array.isArray(data) ? data.length : 0);
    checks.hodlmm_pools = { ok: count > 0, detail: `${count} pools found` };
  } catch (e) {
    checks.hodlmm_pools = { ok: false, detail: String(e) };
  }

  try {
    const bins = await fetchBins(DEFAULT_POOL);
    checks.hodlmm_bins = { ok: bins.length > 0, detail: `${bins.length} bins for ${DEFAULT_POOL}` };
  } catch (e) {
    checks.hodlmm_bins = { ok: false, detail: String(e) };
  }

  try {
    const pool = await fetchAppPool(DEFAULT_POOL);
    const apr  = pool?.apr24h ?? pool?.apr_24h ?? pool?.apr ?? "?";
    const tvl  = pool?.tvlUsd ?? pool?.tvl ?? "?";
    checks.app_pool = { ok: true, detail: `${DEFAULT_POOL} TVL: $${tvl}, APR (24h): ${apr}%` };
  } catch (e) {
    checks.app_pool = { ok: false, detail: String(e) };
  }

  try {
    const gas = await fetchGas();
    checks.hiro_fees = { ok: true, detail: `${gas} µSTX/byte` };
  } catch (e) {
    checks.hiro_fees = { ok: false, detail: String(e) };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  out({
    status: allOk ? "success" : "error",
    action: allOk
      ? `All data sources reachable. Run: bun run hodlmm-range-advisor/hodlmm-range-advisor.ts run`
      : "Fix failing checks before running.",
    data: { checks },
    error: allOk ? null : { code: "DOCTOR_FAIL", message: "One or more checks failed", next: "Fix checks above" },
  });
}

async function run(poolId: string, tightness: string) {
  const mult = TIGHTNESS_MULT[tightness] ?? TIGHTNESS_MULT.moderate;

  // Fetch all data sources in parallel
  let poolList: any, bins: any[], appPool: any, gasFee: number;
  try {
    [poolList, bins, appPool, gasFee] = await Promise.all([
      fetchPoolList(),
      fetchBins(poolId),
      fetchAppPool(poolId),
      fetchGas(),
    ]);
  } catch (e) {
    fail("FETCH_FAIL", String(e), "re-run doctor to identify which source is down");
  }

  // Resolve active bin from pool list
  const poolArr: any[] = Array.isArray(poolList) ? poolList : (poolList?.pools ?? []);
  const pool = poolArr.find((p) => (p.pool_id ?? p.id) === poolId);
  const activeBin = Number(pool?.active_bin ?? pool?.active_bin_id ?? 0);
  if (!activeBin) {
    fail("NO_ACTIVE_BIN", `Could not determine active bin for pool "${poolId}"`, "verify pool-id with doctor");
  }

  // Compute volatility range from bin liquidity distribution
  const vol = computeVolatilityRange(bins, activeBin);
  if (!vol) {
    fail(
      "INSUFFICIENT_DATA",
      `Need ≥5 bins with liquidity to compute vol range — got ${bins.length} bins total`,
      "try again later or choose a different pool"
    );
  }

  // Recommend bin range
  const halfWidth     = Math.ceil((vol.volWidth / 2) * mult);
  const recMin        = activeBin - halfWidth;
  const recMax        = activeBin + halfWidth;
  const rangeWidth    = recMax - recMin;

  // Estimate in-range probability: range_width / vol_width, capped at 95%
  const rawInRange = (rangeWidth / vol.volWidth) * 0.85;
  const inRangePct = Math.min(95, Math.round(rawInRange * 100));

  // Project effective APR — app API uses apr24h / tvlUsd / volumeUsd1d
  const poolApr      = Number(appPool?.apr24h ?? appPool?.apr_24h ?? appPool?.apr ?? 0);
  const projectedApr = +(poolApr * (inRangePct / 100)).toFixed(2);

  // Gas estimate: 2-tx cycle (deposit + future rebalance), 500 bytes/tx, 3× contract multiplier, 1.2× buffer
  const gasEstStx = +(gasFee * 500 * 2 * 3 * 1.2 / 1e6).toFixed(4);

  // Low confidence warning
  const lowConfidence = vol.liquidBins < 10;

  const tightnessLabel = {
    aggressive:   `Tight range`,
    moderate:     `Balanced range`,
    conservative: `Wide range`,
  }[tightness] ?? "Balanced range";

  const action =
    `${tightnessLabel} ${recMin}–${recMax} (${rangeWidth} bins): ` +
    `~${inRangePct}% est. in-range probability, projected APR ${projectedApr}%.` +
    (tightness === "aggressive" ? " ⚠ High rebalance frequency expected." : "") +
    (lowConfidence ? " ⚠ Low bin count — treat estimate as approximate." : "");

  out({
    status: "success",
    action,
    data: {
      pool_id:       poolId,
      active_bin:    activeBin,
      recommended_range: { min: recMin, max: recMax, width: rangeWidth },
      tightness,
      vol_range: {
        p10:          vol.p10,
        p90:          vol.p90,
        width:        vol.volWidth,
        liquid_bins:  vol.liquidBins,
        low_confidence: lowConfidence,
      },
      estimated_in_range_pct: inRangePct,
      pool_apr_24h_pct:       poolApr,
      projected_apr_pct:      projectedApr,
      gas_estimated_stx:      gasEstStx,
      pool_tvl_usd:           appPool?.tvlUsd ?? appPool?.tvl ?? null,
      pool_vol_24h_usd:       appPool?.volumeUsd1d ?? appPool?.volume_24h ?? null,
      pool_fee_bps:           appPool?.baseFee != null ? Math.round(appPool.baseFee * 10000) : null,
    },
    error: null,
  });
}

async function installPacks() {
  out({
    status: "success",
    action: "No packs needed. Skill uses Bitflow and Hiro public HTTP APIs directly.",
    data: { deps: ["bun (runtime — https://bun.sh)"] },
    error: null,
  });
}

// ── entrypoint ─────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const cmd      = args[0];
const poolIdx  = args.indexOf("--pool-id");
const poolId   = poolIdx >= 0 ? (args[poolIdx + 1] ?? DEFAULT_POOL) : DEFAULT_POOL;
const tightIdx = args.indexOf("--tightness");
const rawTight = tightIdx >= 0 ? (args[tightIdx + 1] ?? "moderate") : "moderate";
const tightness = Object.keys(TIGHTNESS_MULT).includes(rawTight) ? rawTight : "moderate";

if      (cmd === "doctor")        await doctor();
else if (cmd === "run")           await run(poolId, tightness);
else if (cmd === "install-packs") await installPacks();
else fail(
  "UNKNOWN_CMD",
  `Unknown command: "${cmd ?? "(none)"}"`,
  "Usage: doctor | run [--pool-id <id>] [--tightness aggressive|moderate|conservative] | install-packs"
);
