/**
 * B5 edge engine: Binance 1m candles for BTC + ETH, EMA + momentum, estimate prob per market.
 */

export interface Candle1m {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  takerBuyVolume: number;
}

const BINANCE_ENDPOINTS = [
  'https://api.binance.com/api/v3/klines',
  'https://api.binance.us/api/v3/klines',
  'https://api1.binance.com/api/v3/klines',
];

const ENDPOINT_CACHE: Record<string, string | null> = {};

function parseKline(k: unknown[]): Candle1m {
  return {
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
    takerBuyVolume: parseFloat(k[9] as string),
  };
}

export async function fetchBinance1m(symbol: string, limit = 120): Promise<Candle1m[]> {
  const cacheKey = symbol;
  const endpoints = ENDPOINT_CACHE[cacheKey]
    ? [ENDPOINT_CACHE[cacheKey]!, ...BINANCE_ENDPOINTS.filter((e) => e !== ENDPOINT_CACHE[cacheKey])]
    : BINANCE_ENDPOINTS;
  for (const base of endpoints) {
    const url = `${base}?symbol=${symbol}&interval=1m&limit=${limit}`;
    try {
      const res = await fetch(url);
      if (res.status === 451 || res.status === 403) continue;
      if (!res.ok) continue;
      const raw = (await res.json()) as unknown[][];
      ENDPOINT_CACHE[cacheKey] = base;
      return raw.map(parseKline);
    } catch {
      continue;
    }
  }
  throw new Error(`Binance 1m failed for ${symbol}`);
}

function ema(series: number[], span: number): number[] {
  const out: number[] = [];
  let prev = series[0];
  out.push(prev);
  const k = 2 / (span + 1);
  for (let i = 1; i < series.length; i++) {
    prev = series[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Estimate probability that the market goes "up" (or "yes" for up) based on question text. */
export function estimateProb(
  question: string,
  btcCandles: Candle1m[],
  ethCandles: Candle1m[] | null,
  symbol: 'BTC' | 'ETH'
): number {
  const candles = symbol === 'BTC' ? btcCandles : ethCandles ?? btcCandles;
  if (!candles || candles.length < 26) return 0.5;

  const closes = candles.map((c) => c.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const recentMom = closes.length >= 20
    ? (closes[closes.length - 1] - closes[closes.length - 20]) / closes[closes.length - 20]
    : 0;
  const emaCross = ema12[ema12.length - 1] > ema26[ema26.length - 1] ? 1 : -1;

  const q = question.toLowerCase();
  let base: number;
  if (/up|higher|above/.test(q)) {
    base = 0.5 + recentMom * 8 + emaCross * 0.08;
  } else if (/down|lower|below/.test(q)) {
    base = 0.5 - recentMom * 8 - emaCross * 0.08;
  } else {
    base = 0.5;
  }

  if (/5\s*min|5 minute/.test(q)) base *= 0.97;
  else if (/15\s*min|15 minute/.test(q)) base *= 1.03;

  return Math.max(0.15, Math.min(0.85, base));
}
