import { describe, expect, test } from "bun:test";
import { buildForVenue } from "../src/core.ts";
import { resolveChain } from "../src/chains.ts";
import { NATIVE_SENTINEL, type Token } from "../src/tokens.ts";
import type { NormalizedQuote } from "../src/venues/index.ts";

// The dApp's Send tab keeps a tokenOut selected, so `venue="send"` reaches
// buildForVenue with an arbitrary pair — including native↔wrapped. Wrap
// detection used to run first and turned the transfer into deposit()/
// withdraw(). These two assert send always wins.

const eth = resolveChain("eth");
const SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const AMOUNT = 10n ** 18n;

const tok = (address: string, symbol: string): Token => ({
  address, symbol, name: symbol, decimals: 18, chainId: 1, source: "test",
});
const NATIVE = tok(NATIVE_SENTINEL, "ETH");
const WETH = tok(eth.wrappedNative, "WETH");

const send = (tokenIn: Token, tokenOut: Token) =>
  buildForVenue({
    chain: eth, tokenIn, tokenOut, amountIn: AMOUNT, sender: SENDER,
    slippageBps: 50, quote: {} as NormalizedQuote, venue: "send",
    recipient: RECIPIENT,
  });

describe("venue=send beats wrap detection", () => {
  test("native in / wrapped out → plain value transfer, not deposit()", async () => {
    const tx = await send(NATIVE, WETH);
    expect(tx.kind).toBe("tx");
    expect((tx as { to: string }).to.toLowerCase()).toBe(RECIPIENT);
    expect((tx as { data: string }).data).toBe("0x");
    expect(BigInt((tx as { value: string }).value)).toBe(AMOUNT);
  });

  test("wrapped in / native out → transfer(), not withdraw()", async () => {
    const tx = await send(WETH, NATIVE);
    expect((tx as { to: string }).to.toLowerCase()).toBe(eth.wrappedNative.toLowerCase());
    expect((tx as { data: string }).data.slice(0, 10)).toBe("0xa9059cbb");
    expect((tx as { data: string }).data).toContain(RECIPIENT.slice(2));
  });
});
