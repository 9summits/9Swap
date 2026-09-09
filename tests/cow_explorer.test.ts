import { expect, test } from "bun:test";
import {
  orderExplorerCtaLabel,
  orderExplorerUrl,
} from "../web/src/cowExplorer.ts";

const UID =
  "0xa8af59bd495d84d365c5cd091c2a2daadf32228169a3488a5289662c17268e22b853ceb4d30ebfc30924db42d90111d51662bb8a672bdb20";

function expectOrderUrl(got: string | null, expected: string) {
  expect(got).toBe(expected);
  expect(got).not.toContain("/tx/");
  expect(got).not.toMatch(/etherscan/i);
}

test("mainnet cow order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 1, orderId: UID }),
    `https://explorer.cow.fi/orders/${UID}`,
  );
});

test("gnosis cow order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 100, orderId: UID }),
    `https://explorer.cow.fi/gc/orders/${UID}`,
  );
});

test("base cow order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 8453, orderId: UID }),
    `https://explorer.cow.fi/base/orders/${UID}`,
  );
});

test("arbitrum cow order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 42161, orderId: UID }),
    `https://explorer.cow.fi/arb1/orders/${UID}`,
  );
});

test("unknown cow chain uses search url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 999, orderId: UID }),
    `https://explorer.cow.fi/search/${UID}`,
  );
});

test("cow on ophis-operated chain uses search, not opt", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 10, orderId: UID }),
    `https://explorer.cow.fi/search/${UID}`,
  );
});

test("mainnet ophis order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "ophis", chainId: 1, orderId: UID }),
    `https://explorer.ophis.fi/orders/${UID}`,
  );
});

test("base ophis order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "ophis", chainId: 8453, orderId: UID }),
    `https://explorer.ophis.fi/base/orders/${UID}`,
  );
});

test("optimism ophis uses opt alias", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "ophis", chainId: 10, orderId: UID }),
    `https://explorer.ophis.fi/opt/orders/${UID}`,
  );
});

test("unichain ophis order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "ophis", chainId: 130, orderId: UID }),
    `https://explorer.ophis.fi/unichain/orders/${UID}`,
  );
});

test("robinhood ophis order url", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "ophis", chainId: 4663, orderId: UID }),
    `https://explorer.ophis.fi/robinhood/orders/${UID}`,
  );
});

test("uniswapx has no cow-like explorer url", () => {
  expect(
    orderExplorerUrl({ venue: "uniswapx", chainId: 1, orderId: UID }),
  ).toBeNull();
});

test("fusion has no order explorer url", () => {
  expect(
    orderExplorerUrl({ venue: "fusion", chainId: 1, orderId: UID }),
  ).toBeNull();
});

test("delta velora explorer url", () => {
  const id = "0771518e-6584-4d82-8077-439c4c5cb5a1";
  expectOrderUrl(
    orderExplorerUrl({ venue: "delta", chainId: 1, orderId: id }),
    `https://www.velora.xyz/explorer/order/${id}/transactions`,
  );
});

test("delta explorer url ignores chain", () => {
  const id = "0771518e-6584-4d82-8077-439c4c5cb5a1";
  expect(
    orderExplorerUrl({ venue: "delta", chainId: 8453, orderId: id }),
  ).toBe(
    orderExplorerUrl({ venue: "delta", chainId: 1, orderId: id }),
  );
});

test("empty orderId is null", () => {
  expect(orderExplorerUrl({ venue: "cow", chainId: 1, orderId: "" })).toBeNull();
  expect(
    orderExplorerUrl({ venue: "ophis", chainId: 1, orderId: "   " }),
  ).toBeNull();
  expect(
    orderExplorerUrl({ venue: "delta", chainId: 1, orderId: "" }),
  ).toBeNull();
});

test("trims orderId", () => {
  expectOrderUrl(
    orderExplorerUrl({ venue: "cow", chainId: 1, orderId: `  ${UID}  ` }),
    `https://explorer.cow.fi/orders/${UID}`,
  );
});

test("cta labels follow the explorer host", () => {
  expect(
    orderExplorerCtaLabel(`https://explorer.cow.fi/orders/${UID}`),
  ).toBe("View on CoW Explorer");
  expect(
    orderExplorerCtaLabel(`https://explorer.ophis.fi/opt/orders/${UID}`),
  ).toBe("View on Ophis Explorer");
  expect(
    orderExplorerCtaLabel(
      "https://www.velora.xyz/explorer/order/0771518e-6584-4d82-8077-439c4c5cb5a1/transactions",
    ),
  ).toBe("View on Velora Explorer");
  expect(orderExplorerCtaLabel("https://example.com/orders/0x1")).toBe(
    "View order",
  );
});
