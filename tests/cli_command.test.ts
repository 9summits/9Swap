// Unit tests for the dApp's copied `swap …` command (web/src/dapp/cliCommand.ts).
// Pure function, no network — asserts Copy-CLI extras (--json / -d / --simu)
// and that Odos-era flags are gone from the builder.
import { describe, expect, test } from "bun:test";
import { buildCliCommand, type CliCommandInput } from "../web/src/dapp/cliCommand.ts";

const chain = {
  alias: "eth" as const,
  chainId: 1,
  name: "Ethereum",
  explorer: "",
  nativeSymbol: "ETH",
  wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
};

const weth = {
  address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  symbol: "WETH",
  name: "WETH",
  decimals: 18,
};

const steth = {
  address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
  symbol: "stETH",
  name: "stETH",
  decimals: 18,
};

function input(over: Partial<CliCommandInput> = {}): CliCommandInput {
  return {
    chain,
    tokenIn: weth,
    tokenOut: steth,
    amount: "1",
    editSide: "pay",
    mode: "swap",
    isSend: false,
    recipient: "",
    slippageBps: 10,
    allowAsync: false,
    enabledVenues: [],
    allVenueNames: ["kyber", "uniswap"],
    ...over,
  };
}

describe("buildCliCommand copy flags", () => {
  test("default data=true emits -d", () => {
    const cmd = buildCliCommand(input());
    expect(cmd).toBe("swap 1 WETH stETH --slippage 0.1 -d");
  });

  test("json=true emits --json", () => {
    const cmd = buildCliCommand(input({ json: true }));
    expect(cmd).toContain("--json");
    expect(cmd).toBe("swap 1 WETH stETH --slippage 0.1 --json -d");
  });

  test("simu=true emits --simu and -d", () => {
    const cmd = buildCliCommand(input({ simu: true, data: false }));
    expect(cmd).toContain("--simu");
    expect(cmd).toMatch(/(?:^|\s)-d(?:\s|$)/);
    expect(cmd).toBe("swap 1 WETH stETH --slippage 0.1 -d --simu");
  });

  test("data=false and simu=false does not emit -d", () => {
    const cmd = buildCliCommand(input({ data: false, simu: false }));
    expect(cmd).not.toMatch(/(?:^|\s)-d(?:\s|$)/);
    expect(cmd).toBe("swap 1 WETH stETH --slippage 0.1");
  });

  test("no --odosnotcompact / --disableodosrfq fields required", () => {
    // CliCommandInput no longer has those fields; constructing without them
    // (and the emitted line) must not mention the old Odos flags.
    const cmd = buildCliCommand(input());
    expect(cmd).not.toContain("--odosnotcompact");
    expect(cmd).not.toContain("--disableodosrfq");
  });
});
