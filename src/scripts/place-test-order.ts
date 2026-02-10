/**
 * One-off: place a $1 (1 contract) Yes order on the current BTC 15m market to verify Kalshi is configured.
 * Run from repo root with .env loaded (e.g. node dist/scripts/place-test-order.js after npm run build).
 */
import 'dotenv/config';
import { getCurrentKalshiTicker } from '../kalshi/market.js';
import { getKalshiMarket } from '../kalshi/market.js';
import { createKalshiOrder } from '../kalshi/orders.js';

async function main() {
  const ticker = await getCurrentKalshiTicker('BTC');
  if (!ticker) {
    console.error('No current BTC 15m market ticker found.');
    process.exit(1);
  }
  const market = await getKalshiMarket(ticker);
  console.log('Current BTC 15m market:', ticker);
  console.log('Strike:', market.floor_strike, '| Yes bid:', market.yes_bid, '| Yes ask:', market.yes_ask);

  // Place 1 contract Yes at 96¢ limit (winning side = Yes for "price up")
  const res = await createKalshiOrder({
    ticker,
    side: 'yes',
    action: 'buy',
    count: 1,
    type: 'limit',
    yes_price: 96,
    no_price: 4,
  });
  const order = res.order;
  if (!order) {
    console.error('Order response:', res);
    process.exit(1);
  }
  console.log('Test order placed: order_id=', order.order_id, '| status=', order.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
