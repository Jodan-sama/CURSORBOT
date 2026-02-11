/**
 * Main bot loop: B1/B2/B3 timing, spread checks, order placement (Kalshi + Polymarket), B3 blocking.
 * Entry logic is Kalshi-only (spread from Kalshi strike + Binance price). Polymarket mirrors those
 * entries: same side/window, Poly sizes from dashboard; we only place Poly when we have Kalshi ticker.
 */

import type { Asset } from '../kalshi/ticker.js';
import {
  minutesLeftInWindow,
  isB1Window,
  isB2Window,
  isB3Window,
  isB1LimitOrderWindow,
  isB1MarketOrderWindow,
  getCurrentPolySlug,
  isBlackoutWindow,
} from '../clock.js';
import { getCurrentKalshiTicker, getKalshiMarket } from '../kalshi/market.js';
import { parseKalshiTicker, isReasonableStrike, strikeMatchesPrice } from '../kalshi/ticker.js';
import { createKalshiOrder } from '../kalshi/orders.js';
import { fetchAllPricesOnce, strikeSpreadPctSigned, isOutsideSpreadThreshold } from '../kalshi/spread.js';
import { kalshiYesBidAsPercent } from '../kalshi/market.js';
import { getPolyMarketBySlug } from '../polymarket/gamma.js';
import {
  createPolyClobClient,
  getPolyClobConfigFromEnv,
  getOrCreateDerivedPolyClient,
  createAndPostPolyOrder,
  orderParamsFromParsedMarket,
} from '../polymarket/clob.js';
import {
  isEmergencyOff,
  getPositionSize,
  getSpreadThresholds,
  getBotDelays,
  logPosition,
  setAssetBlock,
  isAssetBlocked,
  logError,
  logPolySkip,
} from '../db/supabase.js';

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

/** When false or unset, only trade on Kalshi (skip Polymarket). Set ENABLE_POLYMARKET=true to enable Poly. */
function isPolymarketEnabled(): boolean {
  const v = process.env.ENABLE_POLYMARKET?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

const B1_CHECK_INTERVAL_MS = 5_000;
const B2_CHECK_INTERVAL_MS = 30_000;
const B3_CHECK_INTERVAL_MS = 60_000;

/** Failsafe: never enter if |spread| > this (e.g. bad data). Also never enter when spread is 0. */
const MAX_SPREAD_PCT = 2;

/** In-memory: already placed an order this window for (bot, asset). Cleared when window changes. */
const enteredThisWindow = new Set<string>();

/** In-memory: timestamp (ms) when B2 last saw spread > threshold for each asset. B1 skips for b2HighSpreadBlockMin. */
const lastB2HighSpreadByAsset = new Map<Asset, number>();

function windowKey(bot: string, asset: Asset, windowEndMs: number): string {
  return `${windowEndMs}-${bot}-${asset}`;
}

function getCurrentWindowEndMs(): number {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const remainder = now % WINDOW_MS;
  return now - remainder + WINDOW_MS;
}

/** Side from signed spread: positive → Yes, negative → No. We only place when |spread| > threshold. */
function sideFromSignedSpread(signedSpreadPct: number): 'yes' | 'no' {
  return signedSpreadPct >= 0 ? 'yes' : 'no';
}

/** Extract readable reason from Poly error for skip log (use longer limit so dashboard shows actual API error). */
function polyErrorReason(polyError: unknown, maxLen = 400): string {
  const msg = polyError instanceof Error ? polyError.message : String(polyError);
  return msg.length > maxLen ? `${msg.slice(0, maxLen)}…` : msg;
}

/** Extract Kalshi error body from "Kalshi POST ...: 400 {...}" for richer context. */
function kalshiErrorContext(err: unknown): Record<string, unknown> {
  const msg = err instanceof Error ? err.message : String(err);
  const jsonMatch = msg.match(/: 4\d\d\s+(\{.+\})$/);
  if (!jsonMatch) return {};
  try {
    const body = JSON.parse(jsonMatch[1]) as { error?: { code?: string; message?: string } };
    if (body.error) return { kalshi_code: body.error.code, kalshi_msg: body.error.message };
  } catch {
    /* ignore parse errors */
  }
  return {};
}

/** Extract Polymarket request/response from Error for richer error logging. */
function polyErrorContext(err: unknown): Record<string, unknown> {
  const e = err as Error & { polyRequest?: unknown; polyResponse?: unknown };
  const out: Record<string, unknown> = {};
  if (e?.polyRequest != null) out.polyRequest = e.polyRequest;
  if (e?.polyResponse != null) out.polyResponse = e.polyResponse;
  return out;
}

async function tryPlaceKalshi(
  ticker: string,
  asset: Asset,
  bot: 'B1' | 'B2' | 'B3',
  isMarket: boolean,
  limitPercent: number,
  size: number,
  side: 'yes' | 'no'
): Promise<{ orderId?: string; filled?: boolean }> {
  const type = isMarket ? 'market' : 'limit';
  const priceCents = isMarket ? undefined : Math.round(limitPercent);
  const res = await createKalshiOrder({
    ticker,
    side,
    action: 'buy',
    count: Math.max(1, Math.floor(size)),
    type: type as 'limit' | 'market',
    yes_price: side === 'yes' ? priceCents ?? 50 : undefined,
    no_price: side === 'no' ? priceCents ?? 50 : undefined,
  });
  const orderId = res.order?.order_id;
  return { orderId, filled: res.order?.status === 'filled' };
}

/** Run fn with proxy set for CLOB/Polymarket. CLOB client uses axios (not fetch), so we set axios.defaults.httpsAgent; undici is for any fetch. */
async function withPolyProxy<T>(fn: () => Promise<T>): Promise<T> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!proxy) return fn();
  const axios = (await import('axios')).default;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const prevUndici = (await import('undici')).getGlobalDispatcher();
  const { setGlobalDispatcher, ProxyAgent } = await import('undici');
  const prevAxiosAgent = axios.defaults.httpsAgent;
  const prevAxiosProxy = axios.defaults.proxy;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    axios.defaults.httpsAgent = new HttpsProxyAgent(proxy);
    axios.defaults.proxy = false;
    return await fn();
  } finally {
    setGlobalDispatcher(prevUndici);
    axios.defaults.httpsAgent = prevAxiosAgent;
    axios.defaults.proxy = prevAxiosProxy;
  }
}

/** All Polymarket HTTP (Gamma + CLOB) runs through proxy when set. Polygon RPC (signing) uses Alchemy via POLYGON_RPC_URL in createPolyClobClient. */
async function tryPlacePolymarket(
  slug: string,
  asset: Asset,
  price: number,
  size: number,
  side: 'yes' | 'no'
): Promise<{ orderId?: string; skipReason?: string }> {
  return withPolyProxy(async () => {
    const parsed = await getPolyMarketBySlug(slug);
    const config = getPolyClobConfigFromEnv();
    const client = config
      ? createPolyClobClient(config)
      : await getOrCreateDerivedPolyClient();
    const params = orderParamsFromParsedMarket(parsed, price, size, side);
    const r = await createAndPostPolyOrder(client, params);
    return { orderId: r.orderID };
  });
}

export async function runOneTick(now: Date, tickCount: number = 0): Promise<void> {
  if (await isEmergencyOff()) return;
  if (isBlackoutWindow(now)) {
    if (tickCount % 12 === 0) console.log('[tick] blackout 08:00–08:15 MST (Utah) Mon–Fri; no trades');
    return;
  }

  const minutesLeft = minutesLeftInWindow(now);
  const windowEndMs = getCurrentWindowEndMs();
  const [spreadThresholds, delays] = await Promise.all([getSpreadThresholds(), getBotDelays()]);
  const b2HighSpreadBlockMs = delays.b2HighSpreadBlockMin * 60 * 1000;
  const b3BlockMs = delays.b3BlockMin * 60 * 1000;

  const ASSET_DELAY_MS = 400; // Space out Kalshi+Poly calls across assets to reduce burst rate limits

  let prices: Record<Asset, number>;
  try {
    prices = await fetchAllPricesOnce();
  } catch (e) {
    await logError(e, { stage: 'market_data' });
    return;
  }

  for (const asset of ASSETS) {
    if (asset !== ASSETS[0]) await new Promise((r) => setTimeout(r, ASSET_DELAY_MS));
    if (await isAssetBlocked(asset)) {
      if (tickCount % 12 === 0) console.log(`[tick] ${asset} skipped (B3 cooldown, blocked 1h)`);
      continue;
    }

    let kalshiTicker: string | null = null;
    let kalshiStrike: number | null = null;
    let kalshiBid: number | null = null;
    let polySlug: string | null = null;
    const currentPrice = prices[asset];
    /** Signed spread % from Kalshi strike + price. One spread for both Kalshi and Poly (Poly mirrors Kalshi). */
    let signedSpreadPct: number | null = null;

    try {
      kalshiTicker = await getCurrentKalshiTicker(asset, undefined, now);
      polySlug = getCurrentPolySlug(asset, now);

      if (kalshiTicker) {
        const km = await getKalshiMarket(kalshiTicker);
        const parsed = parseKalshiTicker(kalshiTicker);
        const tickerStrike = parsed?.strikeFromTicker;
        const floorStrike = km.floor_strike ?? null;
        // Ticker is exact for the contract; floor_strike can be wrong (e.g. 15 for SOL). Prefer ticker when reasonable, else floor_strike. Same API load (we already fetch market for yes_bid).
        const useTickerStrike =
          tickerStrike != null &&
          isReasonableStrike(asset, tickerStrike) &&
          (!Number.isNaN(currentPrice) && currentPrice > 0 ? strikeMatchesPrice(tickerStrike, currentPrice) : true);
        const validFloor =
          floorStrike != null &&
          floorStrike !== 0 &&
          isReasonableStrike(asset, floorStrike) &&
          (!Number.isNaN(currentPrice) && currentPrice > 0 ? strikeMatchesPrice(floorStrike, currentPrice) : true);
        kalshiStrike = (useTickerStrike ? tickerStrike : null) ?? (validFloor ? floorStrike : null);
        kalshiBid = km.yes_bid ?? null;
        if (kalshiStrike != null && !Number.isNaN(currentPrice) && currentPrice > 0) {
          signedSpreadPct = strikeSpreadPctSigned(currentPrice, kalshiStrike);
        }
      }
    } catch (e) {
      await logError(e, { asset, stage: 'market_data' });
      continue;
    }

    if (signedSpreadPct == null) continue;
    const spreadMagnitude = Math.abs(signedSpreadPct);
    // Failsafe: never enter on 0 spread or |spread| > 2% (bad/stale data).
    if (spreadMagnitude === 0) {
      if (tickCount % 12 === 0) console.log(`[tick] ${asset} skip: spread is 0 (failsafe)`);
      continue;
    }
    if (spreadMagnitude > MAX_SPREAD_PCT) {
      if (tickCount % 12 === 0) console.log(`[tick] ${asset} skip: |spread| ${spreadMagnitude.toFixed(2)}% > ${MAX_SPREAD_PCT}% (failsafe)`);
      continue;
    }
    const side = sideFromSignedSpread(signedSpreadPct);

    const sizeKalshiB1 = await getPositionSize('kalshi', 'B1', asset);
    const sizePolyB1 = await getPositionSize('polymarket', 'B1', asset);
    const sizeKalshiB2 = await getPositionSize('kalshi', 'B2', asset);
    const sizePolyB2 = await getPositionSize('polymarket', 'B2', asset);
    const sizeKalshiB3 = await getPositionSize('kalshi', 'B3', asset);
    const sizePolyB3 = await getPositionSize('polymarket', 'B3', asset);

    // --- B1: last 2.5 min. First 1.5 min: bid ≥90% → 96 limit. Final 1 min: bid 90–96% → market (only if no limit placed yet). ---
    if (isB1Window(minutesLeft)) {
      const key = windowKey('B1', asset, windowEndMs);
      const tHigh = lastB2HighSpreadByAsset.get(asset);
      if (tHigh != null && now.getTime() - tHigh < b2HighSpreadBlockMs) {
        if (tickCount % 6 === 0) {
          const minLeft = Math.ceil((b2HighSpreadBlockMs - (now.getTime() - tHigh)) / 60000);
          console.log(`[tick] B1 ${asset} skip: ${delays.b2HighSpreadBlockMin} min delay after B2 saw spread >${delays.b2HighSpreadThresholdPct}% (${minLeft} min left)`);
        }
        continue;
      }
      const outsideB1 = isOutsideSpreadThreshold('B1', asset, spreadMagnitude, spreadThresholds);
      const bidPct = kalshiBid != null ? kalshiYesBidAsPercent(kalshiBid) : 0;
      const inLimitWindow = isB1LimitOrderWindow(minutesLeft);
      const inMarketWindow = isB1MarketOrderWindow(minutesLeft);
      const bidOk =
        inLimitWindow
          ? bidPct >= 90
          : inMarketWindow
            ? bidPct >= 90 && bidPct <= 96
            : false;
      if (enteredThisWindow.has(key)) continue;
      if (!outsideB1) {
        if (tickCount % 6 === 0) console.log(`[tick] B1 ${asset} skip: spread ${signedSpreadPct.toFixed(2)}% inside threshold`);
        continue;
      }
      if (!bidOk) {
        if (tickCount % 6 === 0) {
          const want = inLimitWindow ? 'bid ≥90%' : 'bid 90–96%';
          console.log(`[tick] B1 ${asset} skip: bid ${bidPct}% (${want})`);
        }
        continue;
      }

      const useMarket = inMarketWindow;
      // Poly mirrors Kalshi: 99% limit in last 1 min (matches Kalshi market), 96% otherwise. Fire both in parallel when both have size.
      const priceB1 = useMarket ? 0.99 : 0.96;

      const placeB1Kalshi = async () => {
        if (!kalshiTicker || sizeKalshiB1 <= 0) return { orderId: undefined as string | undefined };
        const r = await tryPlaceKalshi(kalshiTicker, asset, 'B1', useMarket, 96, sizeKalshiB1, side);
        return { orderId: r.orderId };
      };
      const placeB1Poly = async () => {
        if (!kalshiTicker || !polySlug || sizePolyB1 <= 0 || !isPolymarketEnabled()) return { orderId: undefined as string | undefined };
        // $5 min notional applies only to Polymarket; Kalshi uses sizeKalshiB1 as-is.
        const minNotionalSize = Math.ceil(5 / priceB1);
        const sizeB1 = sizePolyB1 * priceB1 >= 5 ? sizePolyB1 : Math.max(sizePolyB1, minNotionalSize);
        if (sizeB1 !== sizePolyB1) console.log(`B1 Poly ${asset} size ${sizePolyB1} → ${sizeB1} (min $5 notional)`);
        const r = await tryPlacePolymarket(polySlug, asset, priceB1, sizeB1, side);
        return { orderId: r.orderId, skipReason: r.skipReason };
      };

      // Run Kalshi first, then Poly. Poly's withPolyProxy sets global undici/axios—running in parallel would proxy Kalshi's fetch and can break it.
      const kalshiResult = await placeB1Kalshi().catch(async (e) => {
        await logError(e, { bot: 'B1', asset, venue: 'kalshi', ...kalshiErrorContext(e) });
        return { orderId: undefined as string | undefined };
      });
      const polyResult = await placeB1Poly().catch(async (e) => {
        console.error(`B1 Poly ${asset} failed:`, e);
        await logError(e, { bot: 'B1', asset, venue: 'polymarket', slug: polySlug ?? undefined, ...polyErrorContext(e) });
        return { orderId: undefined as string | undefined, skipReason: undefined as string | undefined, polyError: e };
      });

      if (kalshiResult.orderId) {
        enteredThisWindow.add(key);
        await logPosition({
          bot: 'B1',
          asset,
          venue: 'kalshi',
          strike_spread_pct: signedSpreadPct,
          position_size: sizeKalshiB1,
          ticker_or_slug: kalshiTicker ?? undefined,
          order_id: kalshiResult.orderId,
        });
        console.log(`B1 Kalshi ${asset} ${side} ${useMarket ? 'market' : '96% limit'} orderId=${kalshiResult.orderId}`);
      }
      if (polyResult.orderId) {
        enteredThisWindow.add(key);
        const sizeB1 = sizePolyB1 * priceB1 >= 5 ? sizePolyB1 : Math.max(sizePolyB1, Math.ceil(5 / priceB1));
        await logPosition({
          bot: 'B1',
          asset,
          venue: 'polymarket',
          strike_spread_pct: signedSpreadPct,
          position_size: sizeB1,
          ticker_or_slug: polySlug ?? '',
          order_id: polyResult.orderId,
        });
        console.log(`B1 Poly ${asset} ${priceB1 * 100}% orderId=${polyResult.orderId}`);
      }
      if (!polyResult.orderId && kalshiTicker) {
        const reason =
          sizePolyB1 === 0
            ? 'position size 0 (set Poly size in dashboard)'
            : !polySlug
              ? 'no poly slug'
              : !isPolymarketEnabled()
                ? 'ENABLE_POLYMARKET not true'
                : polyResult.skipReason
                  ? polyResult.skipReason
                  : 'polyError' in polyResult && polyResult.polyError != null
                    ? polyErrorReason(polyResult.polyError)
                    : 'no orderId or error (check Recent errors)';
        await logPolySkip({ bot: 'B1', asset, reason, kalshiPlaced: !!kalshiResult.orderId });
        console.log(`B1 Poly ${asset} skip: ${reason}`);
      }
    }

    // --- B2: last 5 min, check every 30s, place 97% limit. Fire Kalshi + Poly in parallel like B1. ---
    // B2 having already placed must NOT prevent B3 from running (B3 needs >1% spread). We skip B2 placement
    // but fall through so B3 can still place.
    if (isB2Window(minutesLeft)) {
      if (spreadMagnitude > delays.b2HighSpreadThresholdPct) lastB2HighSpreadByAsset.set(asset, now.getTime());
      const keyB2 = windowKey('B2', asset, windowEndMs);
      const outsideB2 = isOutsideSpreadThreshold('B2', asset, spreadMagnitude, spreadThresholds);
      if (!enteredThisWindow.has(keyB2) && outsideB2) {
        const priceB2 = 0.97;
      const placeB2Kalshi = async () => {
        if (!kalshiTicker || sizeKalshiB2 <= 0) return { orderId: undefined as string | undefined };
        const r = await tryPlaceKalshi(kalshiTicker, asset, 'B2', false, 97, sizeKalshiB2, side);
        return { orderId: r.orderId };
      };
      const placeB2Poly = async () => {
        if (!kalshiTicker || !polySlug || sizePolyB2 <= 0 || !isPolymarketEnabled()) return { orderId: undefined as string | undefined };
        const minNotionalSize = Math.ceil(5 / priceB2);
        const sizeB2 = sizePolyB2 * priceB2 >= 5 ? sizePolyB2 : Math.max(sizePolyB2, minNotionalSize);
        if (sizeB2 !== sizePolyB2) console.log(`B2 Poly ${asset} size ${sizePolyB2} → ${sizeB2} (min $5 notional)`);
        const r = await tryPlacePolymarket(polySlug, asset, priceB2, sizeB2, side);
        return { orderId: r.orderId, skipReason: r.skipReason };
      };

      // Run Kalshi first, then Poly—avoid Poly proxy affecting Kalshi's fetch (see B1 comment).
      const kalshiResult = await placeB2Kalshi().catch(async (e) => {
        await logError(e, { bot: 'B2', asset, venue: 'kalshi', ...kalshiErrorContext(e) });
        return { orderId: undefined as string | undefined };
      });
      const polyResult = await placeB2Poly().catch(async (e) => {
        console.error(`B2 Poly ${asset} failed:`, e);
        await logError(e, { bot: 'B2', asset, venue: 'polymarket', slug: polySlug ?? undefined, ...polyErrorContext(e) });
        return { orderId: undefined as string | undefined, skipReason: undefined as string | undefined, polyError: e };
      });

      if (kalshiResult.orderId) {
        enteredThisWindow.add(keyB2);
        await logPosition({
          bot: 'B2',
          asset,
          venue: 'kalshi',
          strike_spread_pct: signedSpreadPct,
          position_size: sizeKalshiB2,
          ticker_or_slug: kalshiTicker ?? undefined,
          order_id: kalshiResult.orderId,
        });
        console.log(`B2 Kalshi ${asset} ${side} 97% orderId=${kalshiResult.orderId}`);
      }
      if (polyResult.orderId) {
        enteredThisWindow.add(keyB2);
        const minNotionalSize = Math.ceil(5 / priceB2);
        const sizeB2 = sizePolyB2 * priceB2 >= 5 ? sizePolyB2 : Math.max(sizePolyB2, minNotionalSize);
        await logPosition({
          bot: 'B2',
          asset,
          venue: 'polymarket',
          strike_spread_pct: signedSpreadPct,
          position_size: sizeB2,
          ticker_or_slug: polySlug ?? undefined,
          order_id: polyResult.orderId,
        });
        console.log(`B2 Poly ${asset} orderId=${polyResult.orderId}`);
      }
      if (!polyResult.orderId && kalshiTicker) {
        const reason =
          sizePolyB2 === 0
            ? 'position size 0 (set Poly size in dashboard)'
            : !polySlug
              ? 'no poly slug'
              : !isPolymarketEnabled()
                ? 'ENABLE_POLYMARKET not true'
                : polyResult.skipReason
                  ? polyResult.skipReason
                  : 'polyError' in polyResult && polyResult.polyError != null
                    ? polyErrorReason(polyResult.polyError)
                    : 'no orderId or error (check Recent errors)';
        await logPolySkip({ bot: 'B2', asset, reason, kalshiPlaced: !!kalshiResult.orderId });
        console.log(`B2 Poly ${asset} skip: ${reason}`);
      }
      } else if (!outsideB2 && tickCount % 6 === 0) {
        console.log(`[tick] B2 ${asset} skip: spread ${signedSpreadPct.toFixed(2)}% inside threshold`);
      }
    }

    // --- B3: last 8 min, check every 1 min, place 97% limit. Fire Kalshi + Poly in parallel like B1/B2. ---
    if (isB3Window(minutesLeft)) {
      const key = windowKey('B3', asset, windowEndMs);
      const outsideB3 = isOutsideSpreadThreshold('B3', asset, spreadMagnitude, spreadThresholds);
      if (enteredThisWindow.has(key)) continue;
      if (!outsideB3) {
        if (tickCount % 12 === 0) console.log(`[tick] B3 ${asset} skip: spread ${signedSpreadPct.toFixed(2)}% inside threshold`);
        continue;
      }

      const priceB3 = 0.97;
      const placeB3Kalshi = async () => {
        if (!kalshiTicker || sizeKalshiB3 <= 0) return { orderId: undefined as string | undefined };
        const r = await tryPlaceKalshi(kalshiTicker, asset, 'B3', false, 97, sizeKalshiB3, side);
        return { orderId: r.orderId };
      };
      const placeB3Poly = async () => {
        if (!kalshiTicker || !polySlug || sizePolyB3 <= 0 || !isPolymarketEnabled()) return { orderId: undefined as string | undefined };
        const minNotionalSize = Math.ceil(5 / priceB3);
        const sizeB3 = sizePolyB3 * priceB3 >= 5 ? sizePolyB3 : Math.max(sizePolyB3, minNotionalSize);
        if (sizeB3 !== sizePolyB3) console.log(`B3 Poly ${asset} size ${sizePolyB3} → ${sizeB3} (min $5 notional)`);
        const r = await tryPlacePolymarket(polySlug, asset, priceB3, sizeB3, side);
        return { orderId: r.orderId, skipReason: r.skipReason };
      };

      // Run Kalshi first, then Poly—avoid Poly proxy affecting Kalshi's fetch (see B1 comment).
      const kalshiResult = await placeB3Kalshi().catch(async (e) => {
        await logError(e, { bot: 'B3', asset, venue: 'kalshi', ...kalshiErrorContext(e) });
        return { orderId: undefined as string | undefined };
      });
      const polyResult = await placeB3Poly().catch(async (e) => {
        console.error(`B3 Poly ${asset} failed:`, e);
        await logError(e, { bot: 'B3', asset, venue: 'polymarket', slug: polySlug ?? undefined, ...polyErrorContext(e) });
        return { orderId: undefined as string | undefined, skipReason: undefined as string | undefined, polyError: e };
      });

      const placed = !!(kalshiResult.orderId || polyResult.orderId);

      if (kalshiResult.orderId) {
        enteredThisWindow.add(key);
        await logPosition({
          bot: 'B3',
          asset,
          venue: 'kalshi',
          strike_spread_pct: signedSpreadPct,
          position_size: sizeKalshiB3,
          ticker_or_slug: kalshiTicker ?? undefined,
          order_id: kalshiResult.orderId,
        });
        console.log(`B3 Kalshi ${asset} ${side} 97% orderId=${kalshiResult.orderId}`);
      }
      if (polyResult.orderId) {
        enteredThisWindow.add(key);
        const minNotionalSize = Math.ceil(5 / priceB3);
        const sizeB3 = sizePolyB3 * priceB3 >= 5 ? sizePolyB3 : Math.max(sizePolyB3, minNotionalSize);
        await logPosition({
          bot: 'B3',
          asset,
          venue: 'polymarket',
          strike_spread_pct: signedSpreadPct,
          position_size: sizeB3,
          ticker_or_slug: polySlug ?? undefined,
          order_id: polyResult.orderId,
        });
        console.log(`B3 Poly ${asset} orderId=${polyResult.orderId}`);
      }
      if (!polyResult.orderId && kalshiTicker) {
        const reason =
          sizePolyB3 === 0
            ? 'position size 0 (set Poly size in dashboard)'
            : !polySlug
              ? 'no poly slug'
              : !isPolymarketEnabled()
                ? 'ENABLE_POLYMARKET not true'
                : polyResult.skipReason
                  ? polyResult.skipReason
                  : 'polyError' in polyResult && polyResult.polyError != null
                    ? polyErrorReason(polyResult.polyError)
                    : 'no orderId or error (check Recent errors)';
        await logPolySkip({ bot: 'B3', asset, reason, kalshiPlaced: !!kalshiResult.orderId });
        console.log(`B3 Poly ${asset} skip: ${reason}`);
      }
      if (placed) {
        const blockUntil = new Date(now.getTime() + b3BlockMs);
        await setAssetBlock(asset, blockUntil);
        console.log(`B3 placed for ${asset}: block B1/B2 ${delays.b3BlockMin}min until ${blockUntil.toISOString()}`);
      }
    }
  }

  // Prune old window keys (older than current window)
  const cutoff = windowEndMs - 15 * 60 * 1000;
  for (const k of enteredThisWindow) {
    const ms = parseInt(k.split('-')[0], 10);
    if (ms < cutoff) enteredThisWindow.delete(k);
  }
}

/** Run loop: B1 every 5s, B2 every 30s, B3 every 30s (so we check in the first minute of the 8-min window). */
export function startBotLoop(): void {
  let tickCount = 0;
  const interval = setInterval(async () => {
    tickCount += 1;
    const now = new Date();
    // Heartbeat every 60s so logs show the process is alive
    if (tickCount % 12 === 0) {
      const venue = isPolymarketEnabled() ? 'Kalshi + Polymarket' : 'Kalshi only';
      console.log(`[cursorbot] alive | UTC ${now.toISOString()} | ${venue}`);
    }
    const shouldB1 = true;
    const shouldB2 = tickCount % 6 === 0;
    const shouldB3 = tickCount % 6 === 0; // every 30s so B3 checks during full 8 min (incl. 8-min-left)
    if (shouldB1 || shouldB2 || shouldB3) {
      try {
        await runOneTick(now, tickCount);
      } catch (e) {
        await logError(e, { stage: 'runOneTick' });
      }
    }
  }, B1_CHECK_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
