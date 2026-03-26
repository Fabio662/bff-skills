#!/usr/bin/env bun
/**
 * bitcoin-yield-signal
 * Commands: doctor | run [--confirm] | install-packs
 * Output: strict JSON to stdout
 * Author: Graphite Owl — bc1q6qj3pua5mmntanszatmn8u75frxkdxde69lggt
 * On-chain proof: signal df326182-2396-49b0-a54e-74bfea93dd8e (2026-03-26T04:44Z)
 */

const AIBTC_BASE = "https://aibtc.com";
const NEWS_BASE = "https://aibtc.news";
const BEAT_SLUG = "bitcoin-yield";
const MAX_SIGNALS = 6;
const DISCLOSURE = "bun-runtime, bitcoin-yield-signal skill v1, JingSwap prices API, aibtc.news signals API, Pyth oracle via JingSwap";

const BTC_ADDRESS = process.env.AIBTC_BTC_ADDRESS || "";
const AIBTC_API_KEY = process.env.AIBTC_API_KEY || "";

function out(result: object): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit((result as any).status === "success" ? 0 : 1);
}

function blocked(action: string, data = {}): never {
  out({ status: "blocked", action, data, error: null });
}

function fail(code: string, message: string, next: string, data = {}): never {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

async function getPrices() {
  const r = await fetch(`${AIBTC_BASE}/api/jingswap/prices`);
  if (!r.ok) throw new Error(`JingSwap ${r.status}`);
  const j = await r.json();
  const xyk = j?.pools?.find((p: any) => p.type === "xyk");
  const dlmm = j?.pools?.find((p: any) => p.type === "dlmm");
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

async function getPeg() {
  const r = await fetch(`${AIBTC_BASE}/api/sbtc/peg-info`);
  if (!r.ok) throw new Error(`Peg ${r.status}`);
  const j = await r.json();
  return { supplyBtc: Math.round(Number(j?.totalSupply?.sats || 0) / 1e8), ratio: String(j?.pegRatio || "1:1") };
}

async function getBlock() {
  const r = await fetch(`${AIBTC_BASE}/api/network/status`);
  if (!r.ok) throw new Error(`Network ${r.status}`);
  const j = await r.json();
  return Number(j?.chainTip?.block_height || 0);
}

async function getStatus() {
  const r = await fetch(`${NEWS_BASE}/api/status/${BTC_ADDRESS}`);
  if (!r.ok) throw new Error(`Status ${r.status}`);
  const j = await r.json();
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
  let status: any = null;
  try { status = await getStatus(); checks.news = { ok: status.can, detail: status.can ? `ready, ${status.today}/${MAX_SIGNALS} today` : `blocked, wait ${status.wait}min` }; }
  catch (e) { checks.news = { ok: false, detail: String(e) }; }
  const allOk = Object.values(checks).every(c => c.ok);
  out({ status: allOk ? "success" : "error", action: allOk ? "Run: bun run skills/bitcoin-yield-signal/bitcoin-yield-signal.ts run" : "Fix failing checks", data: { checks }, error: allOk ? null : { code: "DOCTOR_FAIL", message: "checks failed", next: "fix checks above" } });
}

async function run() {
  if (!BTC_ADDRESS) fail("NO_WALLET", "AIBTC_BTC_ADDRESS not set", "Run: npx @aibtc/mcp-server@latest --install");

  let status: any;
  try { status = await getStatus(); } catch(e) { fail("STATUS_FAIL", String(e), "re-run doctor"); }
  if (!status.can) blocked(status.wait ? `Cooldown — wait ${status.wait}min` : `Beat not claimed — claim bitcoin-yield at aibtc.news first`, { waitMinutes: status.wait, signalsToday: status.today });
  if (status.today >= MAX_SIGNALS) blocked(`Daily limit: ${status.today}/${MAX_SIGNALS}`, { signalsToday: status.today });

  let p: any, peg: any, block: number;
  try { [p, peg, block] = await Promise.all([getPrices(), getPeg(), getBlock()]); }
  catch(e) { fail("FETCH_FAIL", String(e), "re-run doctor"); }

  const spreadPct = ((p.dlmmRate - p.xykRate) / p.xykRate * 100);
  const xykUsd = Math.round(p.xykRate * p.stxUsd);
  const dlmmUsd = Math.round(p.dlmmRate * p.stxUsd);
  const spreadUsd = dlmmUsd - xykUsd;

  const headline = `JingSwap sBTC/STX DLMM Prices Bitcoin ${spreadPct.toFixed(2)}% Above XYK Pool at Stacks Block ${block.toLocaleString()}`;
  const body = `JingSwap's two sBTC/STX markets on Stacks mainnet show a ${spreadPct.toFixed(2)}% price spread as of Stacks block ${block.toLocaleString()} (Pyth publish time ${p.pythTs}): the XYK pool trades at ${p.xykRate.toLocaleString()} STX per BTC while the DLMM pool shows ${p.dlmmRate.toLocaleString()} STX per BTC. At Pyth's live STX/USD feed of $${p.stxUsd.toFixed(4)}, those imply sBTC at $${xykUsd.toLocaleString()} (XYK) and $${dlmmUsd.toLocaleString()} (DLMM) respectively, against Pyth's BTC/USD oracle at $${p.btcUsd.toLocaleString()}. The XYK pool holds ${(p.sbtcReserve/1e8).toFixed(2)} sBTC against ${Math.round(p.stxReserve/1e6).toLocaleString()}M STX in reserve. The $${spreadUsd.toLocaleString()}-per-BTC DLMM premium is a cross-pool routing signal correspondents on the bitcoin-yield beat should track. sBTC circulating supply: ${peg.supplyBtc.toLocaleString()} BTC, ${peg.ratio} peg confirmed.`;
  const sources = [
    { url: "https://jingswap.com", title: `JingSwap sBTC/STX — XYK ${p.xykRate.toLocaleString()} STX/BTC, DLMM ${p.dlmmRate.toLocaleString()} STX/BTC (Pyth ts ${p.pythTs})` },
    { url: "https://pyth.network", title: `Pyth BTC/USD $${p.btcUsd.toLocaleString()}, STX/USD $${p.stxUsd.toFixed(4)}, ts ${p.pythTs}` },
    { url: `https://explorer.hiro.so/block/stacks:${block}?chain=mainnet`, title: `Stacks block ${block.toLocaleString()} — Hiro Explorer` },
  ];

  const metrics = { spreadPct: +spreadPct.toFixed(2), xykRate: p.xykRate, dlmmRate: p.dlmmRate, pythBtcUsd: p.btcUsd, pythStxUsd: p.stxUsd, sbtcSupplyBtc: peg.supplyBtc, blockHeight: block, pythTimestamp: p.pythTs };

  if (!process.argv.includes("--confirm")) {
    out({ status: "blocked", action: "Review draft and re-run with --confirm to file", data: { draft: { headline, body: body.slice(0, 120) + "...", sources, disclosure: DISCLOSURE }, metrics, confirmRequired: true }, error: null });
  }

  if (!AIBTC_API_KEY) fail("NO_KEY", "AIBTC_API_KEY not set", "set env var from @aibtc/mcp-server");
  const res = await fetch(`${NEWS_BASE}/api/signals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AIBTC_API_KEY}` },
    body: JSON.stringify({ beat_slug: BEAT_SLUG, headline, body, sources, disclosure: DISCLOSURE, tags: ["sbtc","jingswap","stacks","bitcoin-yield","defi"] }),
  });
  if (!res.ok) fail("FILE_FAIL", await res.text(), "check API key and beat status");
  const filed = await res.json();
  const signalId = String(filed?.signal?.id || filed?.id || "unknown");
  out({ status: "success", action: `Filed — verify at ${NEWS_BASE}/api/signals/${signalId}`, data: { signalId, headline, ...metrics }, error: null });
}

async function installPacks() {
  out({ status: "success", action: "No packs needed. Ensure @aibtc/mcp-server is installed.", data: { deps: ["@aibtc/mcp-server (external)", "bun (runtime)"] }, error: null });
}

const cmd = process.argv[2];
if (cmd === "doctor") await doctor();
else if (cmd === "run") await run();
else if (cmd === "install-packs") await installPacks();
else fail("UNKNOWN_CMD", `Unknown: ${cmd ?? "(none)"}`, "Usage: doctor | run | run --confirm | install-packs");
