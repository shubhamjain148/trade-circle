import assert from "node:assert/strict";
import { test } from "node:test";
import { netWorthDigest, normalizeHoldings, toolPayload } from "./normalize.js";

// ⚠️ Every fixture below is a GUESS at INDmoney's response shape. No authenticated
// call has ever been made. They exist to prove the adapter survives plausible
// variation, not to assert the wire format. Replace them from the captured
// tool_catalog after the first real connect.

const textResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        holdings: [
          { ind_key: "INDS00577", symbol: "DABUR", name: "Dabur India Ltd", qty: 40, avg_cost: 512.5, mkt_value: 21928 },
          { ind_key: "INDS01417", symbol: "TCS", name: "Tata Consultancy", qty: 5, avg_cost: 3400, mkt_value: 18250 },
        ],
      }),
    },
  ],
};

const structuredResult = {
  content: [{ type: "text", text: "ignored when structuredContent is present" }],
  structuredContent: {
    data: {
      positions: [
        { instrument_id: "INDS01960", ticker: "EMMBI", company_name: "Emmbi Industries", quantity: "120", average_price: "88.00", ltp: 94.75 },
      ],
    },
  },
};

const bareArrayResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify([
        { isin: "INE123A01011", trading_symbol: "INFY", units: 10, buy_avg: 1400, current_value: 15600 },
      ]),
    },
  ],
};

test("unwraps a text content block", () => {
  const payload = toolPayload(textResult) as { holdings: unknown[] };
  assert.equal(payload.holdings.length, 2);
});

test("prefers structuredContent over text", () => {
  assert.ok((toolPayload(structuredResult) as { data: unknown }).data);
});

test("normalizes the snake_case holdings shape", () => {
  const positions = normalizeHoldings(textResult);
  assert.deepEqual(positions[0], {
    instrumentId: "INDS00577",
    symbol: "DABUR",
    name: "Dabur India Ltd",
    qty: 40,
    avgCost: 512.5,
    mktValue: 21928,
  });
  assert.equal(positions.length, 2);
});

test("derives market value from qty x ltp and parses numeric strings", () => {
  const [position] = normalizeHoldings(structuredResult);
  assert.equal(position.instrumentId, "INDS01960");
  assert.equal(position.qty, 120);
  assert.equal(position.avgCost, 88);
  assert.equal(position.mktValue, 120 * 94.75);
});

test("handles a bare array with alternate key names", () => {
  const [position] = normalizeHoldings(bareArrayResult);
  assert.equal(position.instrumentId, "INE123A01011");
  assert.equal(position.symbol, "INFY");
  assert.equal(position.mktValue, 15600);
});

test("drops rows that cannot be valued rather than inventing zeros", () => {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          holdings: [
            { ind_key: "A", qty: 0, mkt_value: 0 },
            { ind_key: "B", qty: 3 },
            { qty: 4, mkt_value: 10 },
            { ind_key: "D", qty: 2, mkt_value: 50 },
          ],
        }),
      },
    ],
  };
  assert.deepEqual(
    normalizeHoldings(result).map((p) => p.instrumentId),
    ["D"],
  );
});

test("an unrecognisable payload yields no positions", () => {
  assert.deepEqual(normalizeHoldings({ content: [{ type: "text", text: "hello" }] }), []);
});

test("netWorthDigest is stable across key order and moves with value", () => {
  const a = { content: [{ type: "text", text: JSON.stringify({ total: 100, currency: "INR" }) }] };
  const b = { content: [{ type: "text", text: JSON.stringify({ currency: "INR", total: 100 }) }] };
  const c = { content: [{ type: "text", text: JSON.stringify({ currency: "INR", total: 101 }) }] };
  assert.equal(netWorthDigest(a), netWorthDigest(b));
  assert.notEqual(netWorthDigest(a), netWorthDigest(c));
});

test("real INDmoney networth_holdings shape normalizes (captured 2026-08-06, fake numbers)", () => {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          holdings: [
            {
              investment_code: "120723",
              investment: "Amazon.com, Inc. Common Stock",
              asset_type: "US_STOCK",
              assetclass_l2: "Global Equity",
              invested_amount: 10000,
              market_value: 15000,
              holding_percent: 7.5,
              total_pnl: 5000,
              pnl_per: 50,
              xirr: 0,
              total_units: 2.5,
              unit_price: 6000,
              broker: "2",
              market_cap: "Mega Cap",
            },
            {
              investment_code: "INDS19182",
              investment: "Some ETF",
              asset_type: "STOCK",
              invested_amount: "unknown",
              market_value: 2000,
              total_units: 8,
              unit_price: 250,
            },
          ],
        }),
      },
    ],
  };
  const positions = normalizeHoldings(result);
  assert.equal(positions.length, 2);
  assert.deepEqual(positions[0], {
    instrumentId: "120723",
    symbol: "120723",
    name: "Amazon.com, Inc. Common Stock",
    qty: 2.5,
    avgCost: 4000,
    mktValue: 15000,
  });
  // invested_amount "unknown" degrades to a zero cost basis, not a dropped row.
  assert.equal(positions[1].avgCost, 0);
  assert.equal(positions[1].mktValue, 2000);
});

test("FastMCP structuredContent {result: '<json string>'} unwraps (live shape)", () => {
  const inner = JSON.stringify({
    holdings: [
      {
        investment_code: "116689",
        investment: "Invesco NASDAQ 100 ETF",
        total_units: 4,
        unit_price: 100,
        market_value: 400,
        invested_amount: 300,
      },
    ],
  });
  const result = {
    content: [{ type: "text", text: inner }],
    structuredContent: { result: inner },
    isError: false,
  };
  const positions = normalizeHoldings(result);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].instrumentId, "116689");
  assert.equal(positions[0].avgCost, 75);
});
