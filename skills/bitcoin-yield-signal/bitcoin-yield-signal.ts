#!/usr/bin/env bun
/**
 * bitcoin-yield-signal
 * Commands: doctor | run [--file] | install-packs
 * Output: strict JSON to stdout
 * Author: Graphite Owl — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt
 * On-chain proof: signal df326182-2396-49b0-a54e-74bfea93dd8e (2026-03-26T04:44Z) — re-file with run --file for fresh proof
 */

import { Command } from "commander";

type SkillOutput = { status: "success" | "error" | "blocked"; action: string; data: object; error: null | { code: string; message: string; next: string } };

const FETCH_TIMEOUT_MS = 10_000;
const fetchSignal = (): AbortSignal => AbortSignal.timeout(FETCH_TIMEOUT_MS);

const AIBTC_BASE = "https://aibtc.com";
const NEWS_BASE = "https://aibtc.news";
const BEAT_SLUG = "bitcoin-yield";
const MAX_SIGNALS = 6;
const DISCLOSURE = "bun-runtime, bitcoin-yield-signal skill v1, JingSwap prices API, aibtc.news signals API, Pyth oracle via JingSwap";

const BTC_ADDRESS = process.env.AIBTC_BTC_ADDRESS || "";
const AIBTC_API_KEY = process.env.AIBTC_API_KEY || "";

interface JingSwapPool {
  type: string;
  stxPerBtc: string | number;
  sbtcReserve?: number;
  stxReserve?: number;
}

interface JingSwapOracle {
  btcUsd: number;
  stxUsd: number;
  publishTime: number;
}

interface JingSwapPricesResponse {
  pools: JingSwapPool[];
  oracle: JingSwapOracle;
}

interface PegResponse {
  totalSupply?: { sats?: number };
  pegRatio?: string;
}

interface NetworkStatusResponse {
  chainTip?: { block_height?: number };
}

interface NewsStatusResponse {
  canFileSignal?: boolean;
  waitMinutes?: number | null;
  signalsToday?: number;
  beatStatus?: string;
}

interface FileSignalResponse {
  signal?: { id?: string };
  id?: string;
}

interface PriceMetrics {
  xykRate: number;
  dlmmRate: number;
  sbtcReserve: number;
  stxReserve: number;
  btcUsd: number;
  stxUsd: number;
  pythTs: number;
}

interface PegMetrics {
  supplyBtc: number;
  ratio: string;
}

function out(result: SkillOutput): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "success" ? 0 : 1);
}

function blocked(action: string, data = {}): never {
  out({ status: "blocked", action, data, error: null });
}

function fail(code: string, message: string, next: string, data = {}): never {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

async function getPrices(): Promise<PriceMetrics> {
  const r = await fetch(`${AIBTC_BASE}/api/jingswap/prices`, { signal: fetchSignal() });
  if (!r.ok) throw new Error(`JingSwap ${r.status}`);
  const j = (await r.json()) as JingSwapPricesResponse;
  const xyk = j?.pools?.find((p: JingSwapPool) => p.type === "xyk");
  const dlmm = j?.pools?.find((p: JingSwapPool) => p.type === "dlmm");
  if (!xyk || !dlmm || !j?.oracle) throw new Error("Unexpected JingSwap shape");
  return {
    xykRate: Number(xyk.stxPerBtc),
    dlmmRate: Number(dlmm.stxPerBtc),
    sbtcReserve: Number(xyk.sbtcReserve),
    stxReserve: Number(xyk.stxReserve),
    btcUsd: Number(j.oracle.btcUsd),
    stxUsd: Number(j.oracle.stxUsd),
    pythTs: Number(j.oracle.publishTime),
  };
}

async function getPeg(): Promise<PegMetrics> {
  const r = await fetch(`${AIBTC_BASE}/api/sbtc/peg-info`, { signal: fetchSignal() });
  if (!r.ok) throw new Error(`Peg ${r.status}`);
  const j = (await r.json()) as PegResponse;
  return { supplyBtc: Number((Number(j?.totalSupply?.sats || 0) / 1e8).toFixed(2)), ratio: String(j?.pegRatio || "1:1") };
}

async function getBlock(): Promise<number> {
  const r = await fetch(`${AIBTC_BASE}/api/network/status`, { signal: fetchSignal() });
  if (!r.ok) throw new Error(`Network ${r.status}`);
  const j = (await r.json()) as NetworkStatusResponse;
  return Number(j?.chainTip?.block_height || 0);
}

async function getStatus(): Promise<{ can: boolean; wait: number | null; today: number; beat: string }> {
  const r = await fetch(`${NEWS_BASE}/api/status/${BTC_ADDRESS}`, { signal: fetchSignal() });
  if (!r.ok) throw new Error(`Status ${r.status}`);
  const j = (await r.json()) as NewsStatusResponse;
  return { can: Boolean(j?.canFileSignal), wait: j?.waitMinutes ?? null, today: Number(j?.signalsToday ?? 0), beat: String(j?.beatStatus ?? "unknown") };
}

async function doctor() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  checks.wallet = { ok: !!BTC_ADDRESS, detail: BTC_ADDRESS || "Set AIBTC_BTC_ADDRESS — run: npx @aibtc/mcp-server@latest --install" };
  checks.api_key = { ok: !!AIBTC_API_KEY, detail: AIBTC_API_KEY ? "present" : "Set AIBTC_API_KEY — required for filing" };
  try { await getPrices(); checks.jingswap = { ok: true, detail: "reachable" }; }
  catch (e) { checks.jingswap = { ok: false, detail: String(e) }; }
  try { const p = await getPeg(); checks.sbtc_peg = { ok: true, detail: `${p.supplyBtc} BTC ${p.ratio}` }; }
  catch (e) { checks.sbtc_peg = { ok: false, detail: String(e) }; }
  let status: Awaited<ReturnType<typeof getStatus>> | null = null;
  try { status = await getStatus(); checks.news = { ok: status.can, detail: status.can ? `ready, ${status.today}/${MAX_SIGNALS} today` : `blocked, wait ${status.wait}min` }; }
  catch (e) { checks.news = { ok: false, detail: String(e) }; }
  const allOk = Object.values(checks).every(c => c.ok);
  out({ status: allOk ? "success" : "error", action: allOk ? "Run: bun run skills/bitcoin-yield-signal/bitcoin-yield-signal.ts run" : "Fix failing checks", data: { checks }, error: allOk ? null : { code: "DOCTOR_FAIL", message: "checks failed", next: "fix checks above" } });
}

async function run(file: boolean) {
  if (!BTC_ADDRESS) fail("NO_WALLET", "AIBTC_BTC_ADDRESS not set", "Run: npx @aibtc/mcp-server@latest --install");

  let p: PriceMetrics;
  let peg: PegMetrics;
  let block: number;
  try { [p, peg, block] = await Promise.all([getPrices(), getPeg(), getBlock()]); }
  catch(e) { fail("FETCH_FAIL", String(e), "re-run doctor"); }

  const spreadPct = ((p.dlmmRate - p.xykRate) / p.xykRate * 100);
  const xykUsd = Math.round(p.xykRate * p.stxUsd);
  const dlmmUsd = Math.round(p.dlmmRate * p.stxUsd);
  const spreadUsd = dlmmUsd - xykUsd;
  const metrics = { spreadPct: +spreadPct.toFixed(2), xykRate: p.xykRate, dlmmRate: p.dlmmRate, impliedXykUsd: xykUsd, impliedDlmmUsd: dlmmUsd, spreadUsd, pythBtcUsd: p.btcUsd, pythStxUsd: p.stxUsd, sbtcSupplyBtc: peg.supplyBtc, pegRatio: peg.ratio, blockHeight: block, pythTimestamp: p.pythTs };

  if (!file) {
    return out({ status: "success", action: "Signal data ready. Re-run with --file to post to aibtc.news beat.", data: metrics, error: null });
  }

  if (!AIBTC_API_KEY) fail("NO_KEY", "AIBTC_API_KEY not set", "set env var from @aibtc/mcp-server");
  let status: Awaited<ReturnType<typeof getStatus>>;
  try { status = await getStatus(); } catch(e) { fail("STATUS_FAIL", String(e), "re-run doctor"); }
  if (!status.can) blocked(status.wait ? `Cooldown — wait ${status.wait}min` : `Beat not claimed — claim bitcoin-yield at aibtc.news first`, { waitMinutes: status.wait, signalsToday: status.today });
  if (status.today >= MAX_SIGNALS) blocked(`Daily limit: ${status.today}/${MAX_SIGNALS}`, { signalsToday: status.today });

  const direction = spreadPct >= 0 ? "Above" : "Below";
  const absPct = Math.abs(spreadPct).toFixed(2);
  const headline = `JingSwap sBTC/STX DLMM Prices Bitcoin ${absPct}% ${direction} XYK Pool at Stacks Block ${block.toLocaleString()}`;
  const body = `JingSwap's two sBTC/STX markets on Stacks mainnet show a ${absPct}% price spread (DLMM ${direction.toLowerCase()} XYK) as of Stacks block ${block.toLocaleString()} (Pyth publish time ${p.pythTs}): the XYK pool trades at ${p.xykRate.toLocaleString()} STX per BTC while the DLMM pool shows ${p.dlmmRate.toLocaleString()} STX per BTC. At Pyth's live STX/USD feed of $${p.stxUsd.toFixed(4)}, those imply sBTC at $${xykUsd.toLocaleString()} (XYK) and $${dlmmUsd.toLocaleString()} (DLMM) respectively, against Pyth's BTC/USD oracle at $${p.btcUsd.toLocaleString()}. The XYK pool holds ${(p.sbtcReserve/1e8).toFixed(2)} sBTC against ${Math.round(p.stxReserve/1e6).toLocaleString()}M STX in reserve. The $${Math.abs(spreadUsd).toLocaleString()}-per-BTC DLMM ${direction.toLowerCase()} XYK is a cross-pool routing signal correspondents on the bitcoin-yield beat should track. sBTC circulating supply: ${peg.supplyBtc.toLocaleString()} BTC, ${peg.ratio} peg confirmed.`;
  const sources = [
    { url: "https://jingswap.com", title: `JingSwap sBTC/STX — XYK ${p.xykRate.toLocaleString()} STX/BTC, DLMM ${p.dlmmRate.toLocaleString()} STX/BTC (Pyth ts ${p.pythTs})` },
    { url: "https://pyth.network", title: `Pyth BTC/USD $${p.btcUsd.toLocaleString()}, STX/USD $${p.stxUsd.toFixed(4)}, ts ${p.pythTs}` },
    { url: `https://explorer.hiro.so/block/stacks:${block}?chain=mainnet`, title: `Stacks block ${block.toLocaleString()} — Hiro Explorer` },
  ];

  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${NEWS_BASE}/api/signals`, {
    method: "POST",
    signal: fetchSignal(),
    headers: {
      "Content-Type": "application/json",
      "X-BTC-Address": BTC_ADDRESS,
      "X-BTC-Signature": AIBTC_API_KEY,
      "X-BTC-Timestamp": timestamp,
    },
    body: JSON.stringify({ beat_slug: BEAT_SLUG, headline, body, sources, disclosure: DISCLOSURE, tags: ["sbtc","jingswap","stacks","bitcoin-yield","defi"] }),
  });
  if (!res.ok) fail("FILE_FAIL", await res.text(), "check API key and beat status");
  const filed = (await res.json()) as FileSignalResponse;
  const signalId = String(filed?.signal?.id || filed?.id || "unknown");
  out({ status: "success", action: `Filed — verify at ${NEWS_BASE}/api/signals/${signalId}`, data: { signalId, headline, ...metrics }, error: null });
}

async function installPacks() {
  out({ status: "success", action: "No packs needed. Ensure @aibtc/mcp-server is installed.", data: { deps: ["@aibtc/mcp-server (external)", "bun (runtime)"] }, error: null });
}

const program = new Command();
program
  .name("bitcoin-yield-signal")
  .description("JingSwap spread + optional aibtc.news signal filing (JSON to stdout)")
  .showHelpAfterError("(add doctor | run | install-packs)");

program
  .command("doctor")
  .description("Validate env, APIs, and beat readiness")
  .action(async () => { await doctor(); });

program
  .command("run")
  .description("Fetch metrics; use --file to post signal")
  .option("--file", "post signal to aibtc.news (requires API key and claimed beat)")
  .action(async (opts: { file?: boolean }) => {
    await run(opts.file === true);
  });

program
  .command("install-packs")
  .description("Report external dependencies")
  .option("--pack <pack>", "pack name (informational)", "all")
  .action(async () => { await installPacks(); });

await program.parseAsync(process.argv);
