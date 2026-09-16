// Static, chainId-keyed token tables for chains that no external index covers.
//
// Covered chains:
//   - Robinhood Chain (4663): KyberSwap has no token index and CoinGecko
//     rate-limits, so symbol resolution mostly fails and the dApp's curated
//     list (/api/tokens) would be native-only.
//   - Gnosis (100): KyberSwap ks-setting returns 0 tokens.
//   - Ink (57073): KyberSwap ks-setting returns 0 tokens.
//   - Arc (5042): ks-setting DOES index Arc, but its whitelist is mostly
//     memecoins and omits the majors (USYC, cirBTC) — and the chain's gas
//     token (USDC) needs a trusted 6-decimals entry, since Arc has no
//     sentinel-native row and at least one venue reports it as 18.
// This table is the canonical source for those tokens — consulted FIRST by
// src/tokens.ts (before the network resolvers) and merged into core.ts's
// tokenList.
//
// Refresh: `bun run scripts/refresh-robinhood-builtins.ts`
// Sourced from the official docs (https://docs.robinhood.com/chain/contracts/)
// but every symbol / decimals / name below was VERIFIED ON-CHAIN
// (symbol() / decimals() / name()). Decimals are safety-critical (they
// scale build calldata — a wrong value rescales the amount by 10^N), so
// they come from the chain, never the docs.
//
// The mechanism is generic per chainId: a future chain adds its own array to
// BUILTIN_TOKENS. Chains with no entry return [] and fall through to the
// existing KyberSwap / CoinGecko path with byte-for-byte identical behaviour.

export type BuiltinToken = {
  /** EIP-55 checksummed 20-byte address. */
  address: string;
  /** On-chain symbol() — trusted over the docs label when they diverge. */
  symbol: string;
  /** On-chain name(). */
  name: string;
  /** On-chain decimals(). */
  decimals: number;
  /**
   * Extra symbol-lookup labels (e.g. the docs label when it diverges from the
   * on-chain symbol) — resolution-only, never displayed.
   */
  aliases?: string[];
  /**
   * Token icon for the dApp picker. Sourced from the Uniswap interface
   * GraphQL (`token.project.logoUrl` — CoinGecko-hosted images), baked
   * statically so the deployed dApp never depends on that gateway at runtime.
   */
  logoURI?: string;
};

// Robinhood Chain (4663). WETH then USDG, then stocks by on-chain symbol.
// Aliases hold a docs ticker that differs from on-chain symbol(), including
// prior registry snapshots (CUSO → USO).
const ROBINHOOD_4663: BuiltinToken[] = [
  { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18, name: "WETH", logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
  { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, name: "Global Dollar", logoURI: "https://assets.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png?1730484111" },
  { address: "0x521Cf887E6531c6F667b5BC4D896E5d9bfE8EB2E", symbol: "AAOI", decimals: 18, name: "Applied Optoelectronics • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174149/large/0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e.png?1782444667" },
  { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18, name: "Apple • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174123/large/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9.png?1782444598" },
  { address: "0x3139D77Ace0cbAA5bDfD38bD1F1911a794AF0B0e", symbol: "ABCL", decimals: 18, name: "Abcellera Biologics • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175455/large/ABCL.png?1786367560" },
  { address: "0x232B8ed6377BE97813853B0Ac104c4Cda8378d1B", symbol: "ADBE", decimals: 18, name: "Adobe • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175287/large/ADBE.png?1786070056" },
  { address: "0x5F604fBA1162193A4388A5DFa56F556f3E133cC2", symbol: "AEHR", decimals: 18, name: "Aehr • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175365/large/AEHR.png?1786131696" },
  { address: "0xfAf9cb261B5FCC1f404Bb10CD39C5c6C1974E612", symbol: "AEIS", decimals: 18, name: "Advanced Energy • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175469/large/AEIS.png?1786375054" },
  { address: "0x748c32c3ca24eDf31ea597Db1F3d330a7a6DA3Dc", symbol: "ALAB", decimals: 18, name: "Astera Labs, Inc. • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175284/large/ALAB.png?1786069983" },
  { address: "0x36046893810a7E7fCE501229d57dc3FC8c8716d0", symbol: "AMAT", decimals: 18, name: "Applied Materials • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174172/large/0x36046893810a7e7fce501229d57dc3fc8c8716d0.png?1782444729" },
  { address: "0x99D9D8663545151603863C5AcbD6FC3218899009", symbol: "AMBA", decimals: 18, name: "Ambarella • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175456/large/AMBA.png?1786367575" },
  { address: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", symbol: "AMC", decimals: 18, name: "AMC Entertainment • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175476/large/AMC.png?1786375197" },
  { address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", symbol: "AMD", decimals: 18, name: "AMD • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174114/large/0x86923f96303d656e4aa86d9d42d1e57ad2023fdc.png?1782444575" },
  { address: "0xDd356AA38F40A7b7076755aC854B6FBb1F0D305B", symbol: "AMKR", decimals: 18, name: "Amkor Technology • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175358/large/AMKR.png?1786131555" },
  { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", symbol: "AMZN", decimals: 18, name: "Amazon • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174126/large/0x12f190a9f9d7d37a250758b26824b97ce941bf54.png?1782444606" },
  { address: "0x28bABD556b60E53663B8615036479a29c2CDd1Bf", symbol: "ANET", decimals: 18, name: "Arista • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175430/large/ANET.png?1786299408" },
  { address: "0xb8DBf92F9741c9ac1c32115E78581f23509916FD", symbol: "APLD", decimals: 18, name: "Applied Digital • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174167/large/0xb8dbf92f9741c9ac1c32115e78581f23509916fd.png?1782444716" },
  { address: "0xA249BAF1063Af884807C1E1400AEf7784836917E", symbol: "APP", decimals: 18, name: "AppLovin • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175411/large/APP.png?1786295429" },
  { address: "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA", symbol: "ASML", decimals: 18, name: "ASML Holding NV • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174168/large/0x47f93d52cbec7c6d2cfc080e154002370a60daea.png?1782444718" },
  { address: "0x1AF6446f07eb1d97c546AFC8c9544cBDF3AD5137", symbol: "ASTS", decimals: 18, name: "AST SpaceMobile • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174162/large/0x1af6446f07eb1d97c546afc8c9544cbdf3ad5137.png?1782444702" },
  { address: "0x373C06c4f7BDe527D7Dae4BA169E42b55E393CeD", symbol: "AUR", decimals: 18, name: "Aurora Innovation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175431/large/AUR.png?1786299466" },
  { address: "0xF6290b5e7C26502e2dA514C31509849718EA76A5", symbol: "AVAV", decimals: 18, name: "AeroVironment • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175286/large/AVAV.png?1786070011" },
  { address: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF", symbol: "AVGO", decimals: 18, name: "Broadcom • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174164/large/0x156e175dd063a8ce274c50654ef40e0032b3fbcf.png?1782444707" },
  { address: "0xC27dBD474aF5181c5A8777903690D8D262D12648", symbol: "AXON", decimals: 18, name: "Axon • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175347/large/AXON.png?1786120043" },
  { address: "0x141eEa040c2250eEc0314e336975e81f85f6585e", symbol: "AXTI", decimals: 18, name: "AXT • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175338/large/AXTI.png?1786119714" },
  { address: "0x4D21483a44Bf67a86b77E3dA301411880797D452", symbol: "BA", decimals: 18, name: "Boeing • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174190/large/0x4d21483a44bf67a86b77e3da301411880797d452.png?1782444776" },
  { address: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", symbol: "BABA", decimals: 18, name: "Alibaba • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174135/large/0xad25ac6c84d497db898fa1e8387bf6af3532a1c4.png?1782444629" },
  { address: "0x48E39E56aCdbA37b09020C0b734A613C9a2f100A", symbol: "BB", decimals: 18, name: "Blackberry • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175397/large/BB.png?1786287486" },
  { address: "0x822CC93fFD030293E9842c30BBD678F530701867", symbol: "BE", decimals: 18, name: "Bloom Energy • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174131/large/0x822cc93ffd030293e9842c30bbd678f530701867.png?1782444619" },
  { address: "0x2F62fC9fAbb470C690f141c28340eD832bB27020", symbol: "BND", decimals: 18, name: "Vanguard Total Bond Market ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175450/large/BND.png?1786367471" },
  { address: "0xceF9027c7d6985b85f0BA431125073529A947A68", symbol: "BULL", decimals: 18, name: "Webull • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175340/large/BULL.png?1786119809" },
  { address: "0x5c90450Bbb4273D7b2f17CF6917AEB237A569679", symbol: "CBRS", decimals: 18, name: "Cerebras Systems • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174134/large/0x5c90450bbb4273d7b2f17cf6917aeb237a569679.png?1782444627" },
  { address: "0x9651342CeA770aE9a2969Ba2A52611523146aef9", symbol: "CCL", decimals: 18, name: "Carnival Corporation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174200/large/0x9651342cea770ae9a2969ba2a52611523146aef9.png?1782444803" },
  { address: "0xaE517A2903E68bd929Dfd15be875F8369D53e94a", symbol: "CEG", decimals: 18, name: "Constellation Energy • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175413/large/CEG.png?1786295468" },
  { address: "0x8cF07C5A878945185d327aAa6e33FAa95F95e7bF", symbol: "CELH", decimals: 18, name: "Celsius • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174173/large/0x8cf07c5a878945185d327aaa6e33faa95f95e7bf.png?1782444732" },
  { address: "0x44f6D488021f8233B9416294d1FE9b1fEe28382d", symbol: "CIEN", decimals: 18, name: "Ciena • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175359/large/CIEN.png?1786131584" },
  { address: "0x62200915e7DEab1eC7f79fb246daDbB80eACdDd0", symbol: "CLOV", decimals: 18, name: "Clover Health Investments • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175472/large/CLOV.png?1786375116" },
  { address: "0xBf449977089c718C004a66C554B26B94ef3Ad4De", symbol: "CLS", decimals: 18, name: "Celestica • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175361/large/CLS.png?1786131616" },
  { address: "0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3", symbol: "CLSK", decimals: 18, name: "CleanSpark • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174156/large/0xcbb95bbf36099d34da091dc6fa6f49efa257cee3.png?1782444686" },
  { address: "0x92F9F459F1a9a5AD266b182BE7Bffd1C6c666894", symbol: "COHR", decimals: 18, name: "Coherent • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175344/large/COHR.png?1786119981" },
  { address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", symbol: "COIN", decimals: 18, name: "Coinbase • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174136/large/0x6330d8c3178a418788df01a47479c0ce7ccf450b.png?1782444632" },
  { address: "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2", symbol: "COST", decimals: 18, name: "Costco • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174152/large/0x4ea005168d7f09a7a0ba9d1def21a479950e44c2.png?1782444675" },
  { address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", symbol: "CRCL", decimals: 18, name: "Circle Internet Group • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174121/large/0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5.png?1782444593" },
  { address: "0x4D67253bc223e6b0e104F1084c1fb2b669dDC41b", symbol: "CRDO", decimals: 18, name: "Credo Technology Group • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175285/large/CRDO.png?1786069996" },
  { address: "0xd95B44124e475743a7589e68F3D74008A5536D44", symbol: "CRM", decimals: 18, name: "Salesforce • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175348/large/CRM.png?1786124241" },
  { address: "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931", symbol: "CRWD", decimals: 18, name: "CrowdStrike Holdings • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174169/large/0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931.png?1782444721" },
  { address: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", symbol: "CRWV", decimals: 18, name: "CoreWeave • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174127/large/0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3.png?1782444608" },
  { address: "0xF543967EEBB6f1917992eF0E68De63ab07a5a0dA", symbol: "CSCO", decimals: 18, name: "Cisco Systems • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175438/large/CSCO.png?1786301258" },
  { address: "0x63D5a3b6939a33f1e75d8Bcd85759858239600DB", symbol: "CTSH", decimals: 18, name: "Cognizant • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175434/large/CTSH.png?1786301179" },
  { address: "0xa4f319104089FE321dc8093C6E707d4fE190A988", symbol: "CVNA", decimals: 18, name: "Carvana • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175475/large/CVNA.png?1786375169" },
  { address: "0x27c99fBde9D0d2AA4f4Bfb4943f237843DdF6958", symbol: "DDOG", decimals: 18, name: "Datadog • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174188/large/0x27c99fbde9d0d2aa4f4bfb4943f237843ddf6958.png?1782444771" },
  { address: "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", symbol: "DELL", decimals: 18, name: "Dell • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174139/large/0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd.png?1782444640" },
  { address: "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516", symbol: "DJT", decimals: 18, name: "Trump Media & Technology Group • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175474/large/DJT.png?1786375153" },
  { address: "0xc02f12B9fe9E707079EC0d546f3050d3F6C1F8bD", symbol: "DOCN", decimals: 18, name: "DigitalOcean • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175442/large/DOCN.png?1786301513" },
  { address: "0x39EC44Bee4F6A116c6F9B8De566848a985C53C60", symbol: "ELF", decimals: 18, name: "e.l.f. Beauty • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174196/large/0x39ec44bee4f6a116c6f9b8de566848a985c53c60.png?1782444793" },
  { address: "0x1c690498150252222C275A5CEd69d3A6b1f52D5E", symbol: "EWT", decimals: 18, name: "iShares MSCI Taiwan Capped ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175477/large/EWT.png?1786375215" },
  { address: "0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc", symbol: "EWY", decimals: 18, name: "iShares MSCI South Korea fund • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174159/large/0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc.png?1782444694" },
  { address: "0x25C288E6D899b9BC30160965aD9644c67e73bE0C", symbol: "F", decimals: 18, name: "Ford Motor • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174185/large/0x25c288e6d899b9bc30160965ad9644c67e73be0c.png?1782444763" },
  { address: "0xa48F22A46C0F1C46CA7D111CB6c137c271987180", symbol: "FICO", decimals: 18, name: "Fair Isaac • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175356/large/FICO.png?1786124484" },
  { address: "0x41F4267525a8AFf329540eF24fD83d9044758B33", symbol: "FIG", decimals: 18, name: "Figma • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175289/large/FIG.png?1786070068" },
  { address: "0x9ECe29A4A2397C0a35fb5fA8EE2b9509130a98cc", symbol: "FISV", decimals: 18, name: "Fiserv • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175403/large/FISV.png?1786287590" },
  { address: "0x93Dbb1d2Dc5D63F4abACFF30485273f538Df68Ac", symbol: "FIX", decimals: 18, name: "Comfort Systems • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175425/large/FIX.png?1786299246" },
  { address: "0x282e87451E10fA6679BC7D76C69BE44cD3fC777C", symbol: "FLNC", decimals: 18, name: "Fluence Energy • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174194/large/0x282e87451e10fa6679bc7d76c69be44cd3fc777c.png?1782444787" },
  { address: "0x03BC731Ffb162cdd7B98D3C6542bFC291126075d", symbol: "FLY", decimals: 18, name: "Firefly Aerospace Inc. • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175350/large/FLY.png?1786124271" },
  { address: "0x3FB8976980d486084b2eb4a404BD12e72823958f", symbol: "FTNT", decimals: 18, name: "Fortinet • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175427/large/FTNT.png?1786299307" },
  { address: "0xeB30663bDFf0622Ef4e4E5cBb4E975F19f33f51D", symbol: "FUTU", decimals: 18, name: "Futu Holdings • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174192/large/0xeb30663bdff0622ef4e4e5cbb4e975f19f33f51d.png?1782444782" },
  { address: "0x63b814DDBd6BF339f25Fed8c36158a008D5B373e", symbol: "GE", decimals: 18, name: "General Electric • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175414/large/GE.png?1786295546" },
  { address: "0x94B8AAE43A1cCc08Aa64B7D1F29b4D920aF4a0C9", symbol: "GEV", decimals: 18, name: "GE Vernova • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175410/large/GEV.png?1786295410" },
  { address: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", symbol: "GLD", decimals: 18, name: "SPDR Gold Trust • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175452/large/GLD.png?1786367509" },
  { address: "0x7c04E6A3368F2A1DE3874f0e80d2e0A1a9915da6", symbol: "GLW", decimals: 18, name: "Corning • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174144/large/0x7c04e6a3368f2a1de3874f0e80d2e0a1a9915da6.png?1782444653" },
  { address: "0x2D427692E928fa156ec22acfaBaFA0447C5805B7", symbol: "GLXY", decimals: 18, name: "Galaxy Digital Inc. • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175402/large/GLXY.png?1786287575" },
  { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME", decimals: 18, name: "GameStop • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174150/large/0x1b0e319c6a659f002271b69db8a7df2f911c153e.png?1782444670" },
  { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL", decimals: 18, name: "Alphabet Class A • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174124/large/0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3.png?1782444601" },
  { address: "0xEB61c0Ed490A367d4E3631cCf8a74B3bfc7E775D", symbol: "HII", decimals: 18, name: "Huntington Ingalls • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175437/large/HII.png?1786301234" },
  { address: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", symbol: "HIMS", decimals: 18, name: "Hims & Hers Health • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175360/large/HIMS.png?1786131590" },
  { address: "0x59dd09d4900C2E4B5F75b7c0d4E6796fcc234Cb1", symbol: "HPE", decimals: 18, name: "HP Enterprise • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175416/large/HPE.png?1786295591" },
  { address: "0xAEa445c5F3DB1a462998ccC422A875A361ee5d99", symbol: "HWM", decimals: 18, name: "Howmet Aerospace • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175415/large/HWM.png?1786295580" },
  { address: "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619", symbol: "IBM", decimals: 18, name: "IBM • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175357/large/IBM.png?1786131546" },
  { address: "0x7c148F74ac7445D1F28366b7FcDC6792a9Fcd0Cf", symbol: "IBRX", decimals: 18, name: "ImmunityBio, • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175424/large/IBRX.png?1786299174" },
  { address: "0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6", symbol: "INDA", decimals: 18, name: "iShares MSCI India ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175449/large/INDA.png?1786367418" },
  { address: "0xB853bC83a753342a4f8320ea680b4B1E84118D21", symbol: "INFQ", decimals: 18, name: "Infleqtion • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175353/large/INFQ.png?1786124407" },
  { address: "0xf1953DAB6FaD537488d5A022361FfAa8B4c95eC6", symbol: "INOD", decimals: 18, name: "Innodata • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174189/large/0xf1953dab6fad537488d5a022361ffaa8b4c95ec6.png?1782444774" },
  { address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", symbol: "INTC", decimals: 18, name: "Intel • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174118/large/0xc72b96e0e48ecd4dc75e1e45396e26300bc39681.png?1782444585" },
  { address: "0x56d23beE5f41A7120170b0c603Dae30128e460e9", symbol: "INTU", decimals: 18, name: "Intuit • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174179/large/0x56d23bee5f41a7120170b0c603dae30128e460e9.png?1782444747" },
  { address: "0x558378E000D634A36593E338eBacdd6207640EfE", symbol: "IONQ", decimals: 18, name: "IonQ • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174166/large/0x558378e000d634a36593e338ebacdd6207640efe.png?1782444713" },
  { address: "0xF0AB0c93bE6F41369d302e55db1A96b3c430212D", symbol: "IREN", decimals: 18, name: "IREN Limited • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174151/large/0xf0ab0c93be6f41369d302e55db1a96b3c430212d.png?1782444672" },
  { address: "0xEAf2512dFC1bEAc608F8794B3793CD4E02894Aa6", symbol: "JBL", decimals: 18, name: "Jabil Inc. • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175479/large/JBL.png?1786401150" },
  { address: "0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80", symbol: "JNJ", decimals: 18, name: "Johnson & Johnson • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175443/large/JNJ.png?1786301555" },
  { address: "0xb334C5cE741B80B5B671F47F5C269Cb193fe8E24", symbol: "JOBY", decimals: 18, name: "Joby Aviation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175341/large/JOBY.png?1786119882" },
  { address: "0x96b933C74eCB4A0926b9210cef7b743EF46be2E9", symbol: "KLAC", decimals: 18, name: "KLA • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175291/large/KLAC.png?1786070082" },
  { address: "0x12e3c047bf9AeCAF9dDC98c05C31BFD1dd043993", symbol: "KSS", decimals: 18, name: "Kohls Corporation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175473/large/KSS.png?1786375136" },
  { address: "0x7FD06a4d81cCfA3F351394E144d5191874C31313", symbol: "KTOS", decimals: 18, name: "Kratos Defense & Security Solutions • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175345/large/KTOS.png?1786120005" },
  { address: "0x48d60243c66437c6ac3c2495Be94747aEd5Dfe25", symbol: "LHX", decimals: 18, name: "L3Harris • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175426/large/LHX.png?1786299267" },
  { address: "0x8eF20885F94e3D9bc7eB3080279188Bd5ED7c08C", symbol: "LITE", decimals: 18, name: "Lumentum • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174138/large/0x8ef20885f94e3d9bc7eb3080279188bd5ed7c08c.png?1782444637" },
  { address: "0x8005d266423c7ea827372c9c864491e5786600ea", symbol: "LLY", decimals: 18, name: "Eli Lilly • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174175/large/0x8005d266423c7ea827372c9c864491e5786600ea.png?1782444737" },
  { address: "0x329fcACEb9AD6F9580DD5F643fed0646900D043c", symbol: "LMT", decimals: 18, name: "Lockheed • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175412/large/LMT.png?1786295459" },
  { address: "0x57b0030166DB0C31690d1A5aA167e2e26e2C29a4", symbol: "LRCX", decimals: 18, name: "Lam Research Corp • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175343/large/LRCX.png?1786119951" },
  { address: "0x4e62068525Ab11FE768e29dfD00ef909B9803016", symbol: "LULU", decimals: 18, name: "Lululemon • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174187/large/0x4e62068525ab11fe768e29dfd00ef909b9803016.png?1782444768" },
  { address: "0xa5D4968421bA94814Be3B136b15cf422101aC1a3", symbol: "LUNR", decimals: 18, name: "Intuitive Machines • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174177/large/0xa5d4968421ba94814be3b136b15cf422101ac1a3.png?1782444742" },
  { address: "0xDdf2266b79abf0B48898959B0ed6E6adf512be74", symbol: "MDB", decimals: 18, name: "MongoDB • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174178/large/0xddf2266b79abf0b48898959b0ed6e6adf512be74.png?1782444745" },
  { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbol: "META", decimals: 18, name: "Meta Platforms • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174122/large/0xc0d6457c16cc70d6790dd43521c899c87ce02f35.png?1782444595" },
  { address: "0xc6Cbad1016b38B797610c25E1dc7D95988B1f362", symbol: "MOD", decimals: 18, name: "Modine • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175471/large/MOD.png?1786375100" },
  { address: "0x52D50D0280AD1054b43f052bD70a49a212A1b128", symbol: "MPWR", decimals: 18, name: "Monolithic Power Systems • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175404/large/MPWR.png?1786287606" },
  { address: "0x43B07D15cE533bEc5476d70C22a78a1B2B662155", symbol: "MRNA", decimals: 18, name: "Moderna • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175366/large/MRNA.png?1786131713" },
  { address: "0x62fd0668e10D8B72339BE2DCF7643001688ff13B", symbol: "MRVL", decimals: 18, name: "Marvell Technology • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174140/large/0x62fd0668e10d8b72339be2dcf7643001688ff13b.png?1782444643" },
  { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", symbol: "MSFT", decimals: 18, name: "Microsoft • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174116/large/0xe93237c50d904957cf27e7b1133b510c669c2e74.png?1782444580" },
  { address: "0xec262a75e413fAfD0dF80480274532C79D42da09", symbol: "MSTR", decimals: 18, name: "Strategy Inc. • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174143/large/0xec262a75e413fafd0df80480274532c79d42da09.png?1782444651" },
  { address: "0xC93f4d80e268AB922e871bd169156C3CC41894e6", symbol: "MTSI", decimals: 18, name: "MACOM • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175436/large/MTSI.png?1786301230" },
  { address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", symbol: "MU", decimals: 18, name: "Micron Technology • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174111/large/0xff080c8ce2e5feadaca0da81314ae59d232d4afd.png?1782444567" },
  { address: "0x48961813349333209994750ffA89b3c5C22eC969", symbol: "MXL", decimals: 18, name: "MaxLinear • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174193/large/0x48961813349333209994750ffa89b3c5c22ec969.png?1782444784" },
  { address: "0xf7181b63Fdb858558A74ba96BC42732684cd7965", symbol: "NAVN", decimals: 18, name: "Navan • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175423/large/NAVN.png?1786299132" },
  { address: "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931", symbol: "NBIS", decimals: 18, name: "Nebius Group • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174160/large/0x9d9c6684f596f66a64c030b93a886d51fd4d7931.png?1782444697" },
  { address: "0x116F00968269B7bfbaD4109cE591d6E74c0601d4", symbol: "NET", decimals: 18, name: "Cloudflare, Inc. Class A common stock • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175457/large/NET.png?1786367590" },
  { address: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8", symbol: "NFLX", decimals: 18, name: "Netflix • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174165/large/0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8.png?1782444710" },
  { address: "0xBEF75684C43c4ea7BD18Dd532a2244674Ee8b926", symbol: "NNE", decimals: 18, name: "Nano Nuclear Energy • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174203/large/0xbef75684c43c4ea7bd18dd532a2244674ee8b926.png?1782444811" },
  { address: "0x0C3260aF4B8f13a69c4c2dFb84fD667890CDFa14", symbol: "NOW", decimals: 18, name: "ServiceNow • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174161/large/0x0c3260af4b8f13a69c4c2dfb84fd667890cdfa14.png?1782444700" },
  { address: "0x408c14038a04f7bD235329E26d2bf569ee20e250", symbol: "NU", decimals: 18, name: "Nu • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174171/large/0x408c14038a04f7bd235329e26d2bf569ee20e250.png?1782444726" },
  { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18, name: "NVIDIA • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174110/large/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png?1782444565" },
  { address: "0xbE6702d7b70315376dC48a3293f24f0982F86386", symbol: "NVTS", decimals: 18, name: "Navitas Semiconductor • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174153/large/0xbe6702d7b70315376dc48a3293f24f0982f86386.png?1782444678" },
  { address: "0x8B2f88497f15A18E9D4FFa1a8fFB8538399aE774", symbol: "OKLO", decimals: 18, name: "Oklo • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175396/large/OKLO.png?1786287451" },
  { address: "0xbBD09F72b025360FeE5C928053Dca6248d35be54", symbol: "ON", decimals: 18, name: "ON Semiconductor • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175355/large/ON.png?1786124453" },
  { address: "0x8ff63eAeEe3fE54Ba450c4F5538064Ec5A893Aef", symbol: "ONTO", decimals: 18, name: "Onto Innovation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175429/large/ONTO.png?1786299373" },
  { address: "0xb0992820E760d836549ba69BC7598b4af75dEE03", symbol: "ORCL", decimals: 18, name: "Oracle • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174128/large/0xb0992820e760d836549ba69bc7598b4af75dee03.png?1782444611" },
  { address: "0x40E7a279850e443f582059ae5dC1c3b6563E6395", symbol: "OUST", decimals: 18, name: "Ouster • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175354/large/OUST.png?1786124438" },
  { address: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", symbol: "P", decimals: 18, name: "Everpure • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174199/large/0x1cdad396db64bda184d5182a97dd9b3c62100b7d.png?1782444800" },
  { address: "0xB039597eD45CBa7B6E2fb9E8BE51802969CEe5Be", symbol: "PANW", decimals: 18, name: "Palo Alto Networks • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175428/large/PANW.png?1786299348" },
  { address: "0xfb2664f07B6Aadd29ea7a59D8859b1AeB8645cDa", symbol: "PATH", decimals: 18, name: "UiPath • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175364/large/PATH.png?1786131669" },
  { address: "0x9b23573b156B52565012F5cE02CDF60AFBaa70Be", symbol: "PENG", decimals: 18, name: "Penguin Solutions • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174204/large/0x9b23573b156b52565012f5ce02cdf60afbaa70be.png?1782444814" },
  { address: "0x7066A64c24e4206CD62E83bf198c1E7EB361F51e", symbol: "PFE", decimals: 18, name: "Pfizer • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175439/large/PFE.png?1786301478" },
  { address: "0xAA4d64474c172010aB57719cb9951E6142a100d3", symbol: "PL", decimals: 18, name: "Planet Labs • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175292/large/PL.png?1786070084" },
  { address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", symbol: "PLTR", decimals: 18, name: "Palantir Technologies • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174117/large/0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a.png?1782444583" },
  { address: "0xcf6B2D875361be807EAfa57458c80f28521F9333", symbol: "POET", decimals: 18, name: "POET Technologies • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174142/large/0xcf6b2d875361be807eafa57458c80f28521f9333.png?1782444648" },
  { address: "0x237c16D66590F67B886d978ACD362EAeaD8B18c7", symbol: "POWL", decimals: 18, name: "Powell Industries • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175468/large/POWL.png?1786375029" },
  { address: "0x4189F0c66EBBB0bfeF1C31f763131361EF32f77C", symbol: "PR", decimals: 18, name: "Permian Resources • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174186/large/0x4189f0c66ebbb0bfef1c31f763131361ef32f77c.png?1782444766" },
  { address: "0x9Ab02Ead789b6903c3c44d0ED32F9c707CDF12FD", symbol: "PWR", decimals: 18, name: "Quanta • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175470/large/PWR.png?1786375078" },
  { address: "0xC583c60aeF9Dc401Da72cEC1B404743a93cea1Cc", symbol: "QBTS", decimals: 18, name: "D-Wave Quantum Inc. Common Stock • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174145/large/0xc583c60aef9dc401da72cec1b404743a93cea1cc.png?1782444656" },
  { address: "0x0f17206447090e464C277571124dD2688E48AEA9", symbol: "QCOM", decimals: 18, name: "Qualcomm • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174137/large/0x0f17206447090e464c277571124dd2688e48aea9.png?1782444635" },
  { address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", symbol: "QQQ", decimals: 18, name: "Invesco QQQ • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174119/large/0xd5f3879160bc7c32ebb4dc785f8a4f505888de68.png?1782444588" },
  { address: "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4", symbol: "QUBT", decimals: 18, name: "Quantum Computing • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174141/large/0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4.png?1782444645" },
  { address: "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8", symbol: "RBLX", decimals: 18, name: "Roblox • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174202/large/0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8.png?1782444808" },
  { address: "0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460", symbol: "RCAT", decimals: 18, name: "Red Cat • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175352/large/RCAT.png?1786124386" },
  { address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", symbol: "RDDT", decimals: 18, name: "Reddit • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174197/large/0x05b37fb53a299a1b874a619e1c4c404d52c36f4c.png?1782444795" },
  { address: "0x92Ef19E82bD8fF36661DE838D5eaE7e5CEF0EfFE", symbol: "RDW", decimals: 18, name: "Redwire • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174174/large/0x92ef19e82bd8ff36661de838d5eae7e5cef0effe.png?1782444734" },
  { address: "0x284358abc07F9359f19f4b5b4aC91901Be2597Ba", symbol: "RGTI", decimals: 18, name: "Rigetti Computing • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174146/large/0x284358abc07f9359f19f4b5b4ac91901be2597ba.png?1782444659" },
  { address: "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B", symbol: "RIVN", decimals: 18, name: "Rivian Automotive • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174195/large/0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b.png?1782444790" },
  { address: "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2", symbol: "RKLB", decimals: 18, name: "Rocket Lab Corporation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174133/large/0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2.png?1782444624" },
  { address: "0x756Bc80af765C82da966a788858d65aDF14f3793", symbol: "RUN", decimals: 18, name: "Sunrun • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175398/large/RUN.png?1786287505" },
  { address: "0x95052ddcd5DC25641657424A8Cf04834997E1730", symbol: "SATS", decimals: 18, name: "EchoStar • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174181/large/0x95052ddcd5dc25641657424a8cf04834997e1730.png?1782444753" },
  { address: "0xd63ABB2C13d7a8421a8017a712802053568e3C1D", symbol: "SCHD", decimals: 18, name: "Schwab US Dividend Equity ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175451/large/SCHD.png?1786367491" },
  { address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", symbol: "SGOV", decimals: 18, name: "iShares 0-3 Month Treasury Bond • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174130/large/0x92fd66527192e3e61d4ddd13322aa222de86f9b5.png?1782444616" },
  { address: "0xF53F66751B1Eff985311b693531E3290F600c410", symbol: "SHOP", decimals: 18, name: "Shopify • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174182/large/0xf53f66751b1eff985311b693531e3290f600c410.png?1782444755" },
  { address: "0xBE274710Bf3d9567e1B290eF6a5F9f90ca016FD8", symbol: "SHY", decimals: 18, name: "iShares 1-3 Year Treasury Bond ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175480/large/SHY.png?1786401178" },
  { address: "0x77E655E37F4d913fB9540e0d541D824171a60e81", symbol: "SIMO", decimals: 18, name: "Silicon Motion • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175441/large/SIMO.png?1786301503" },
  { address: "0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8", symbol: "SKHY", decimals: 18, name: "SK hynix Inc. American Depositary Shares • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175527/large/SKYHY.png?1786610155" },
  { address: "0x285b231728c7E4333799183DF1094d775246a535", symbol: "SLS", decimals: 18, name: "SELLAS Life Sciences • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175409/large/SLS.png?1786295383" },
  { address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", symbol: "SLV", decimals: 18, name: "iShares Silver Trust • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174120/large/0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f.png?1782444590" },
  { address: "0xc01aA1fECeC0605b13bc84874ff7256C0f5F562a", symbol: "SMCI", decimals: 18, name: "Super Micro Computer • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174158/large/0xc01aa1fecec0605b13bc84874ff7256c0f5f562a.png?1782444692" },
  { address: "0x072f979c2CAc8e1391B0162a87Fee094bF8744a0", symbol: "SMH", decimals: 18, name: "VanEck Semiconductor ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175454/large/SMH.png?1786367544" },
  { address: "0x1Eebee7F74517e0279dFb09d25B0407bEEc3FDd6", symbol: "SMR", decimals: 18, name: "NuScale Power • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175290/large/SMR.png?1786070080" },
  { address: "0xF6589F11Bc40b669e584073F428B05562F568733", symbol: "SNAP", decimals: 18, name: "Snap • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175399/large/SNAP.png?1786287522" },
  { address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", symbol: "SNDK", decimals: 18, name: "Sandisk Corporation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174113/large/0xb90a19ff0af67f7779aff50a882a9cff42446400.png?1782444573" },
  { address: "0xBa0CAB75495255d0cB58E22B648bFED4ECD1F47E", symbol: "SNOW", decimals: 18, name: "Snowflake • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175401/large/SNOW.png?1786287558" },
  { address: "0x98E75885157C80992A8D41b696D8c9C6Fb30A926", symbol: "SOFI", decimals: 18, name: "SoFi Technologies • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174163/large/0x98e75885157c80992a8d41b696d8c9c6fb30a926.png?1782444705" },
  { address: "0x6E3Dfd9f7e1649BaA14D25cac18C94d62dB10A54", symbol: "SOUN", decimals: 18, name: "SoundHound AI • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175363/large/SOUN.png?1786131658" },
  { address: "0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38", symbol: "SOXX", decimals: 18, name: "iShares Semiconductor ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174155/large/0x75742c18bc1f1c5c5f448f4c9d9c6f66dafaaa38.png?1782444683" },
  { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbol: "SPCX", decimals: 18, name: "Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174129/large/0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea.png?1782444614" },
  { address: "0xAd622320e520de39e72d41EF07438C3Fd3354875", symbol: "SPMO", decimals: 18, name: "Invesco S&P 500 Momentum ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174183/large/0xad622320e520de39e72d41ef07438c3fd3354875.png?1782444758" },
  { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY", decimals: 18, name: "SPDR S&P 500 ETF Trust • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174115/large/0x117cc2133c37b721f49de2a7a74833232b3b4c0c.png?1782444578" },
  { address: "0xb1969f6604CA1AE7a2cD3F1827876e914594CA2D", symbol: "TE", decimals: 18, name: "T1 Energy • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175339/large/TE.png?1786119787" },
  { address: "0x5B97476b922F3305131B8f0B9D333172E87f4aaE", symbol: "TEAM", decimals: 18, name: "Atlassian Corporation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175400/large/TEAM.png?1786287540" },
  { address: "0xB1CC0EC7Db69Cf43539119814df40071b9d61793", symbol: "TEM", decimals: 18, name: "Tempus AI • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175342/large/TEM.png?1786119908" },
  { address: "0x2778C5024D5cA2CdB0f8eAD671ffc69963AdCD9C", symbol: "TER", decimals: 18, name: "Teradyne • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175362/large/TER.png?1786131633" },
  { address: "0x89776d4Cd68193597A2fC132cfaC1fDe36CCeA8a", symbol: "TSEM", decimals: 18, name: "Tower Semiconductor • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174184/large/0x89776d4cd68193597a2fc132cfac1fde36ccea8a.png?1782444761" },
  { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA", decimals: 18, name: "Tesla • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174112/large/0x322f0929c4625ed5bad873c95208d54e1c003b2d.png?1782444570" },
  { address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", symbol: "TSM", decimals: 18, name: "Taiwan Semiconductor Manufacturing • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174148/large/0x58ffe4a942d3885baa22d7520691f611ef09e7aa.png?1782444664" },
  { address: "0x0b5fb4031cae9163db10B169Ee72685F0EdC8545", symbol: "TTD", decimals: 18, name: "Trade Desk • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175351/large/TTD.png?1786124328" },
  { address: "0x5e81213613b6B86EaB4c6c50d718d34359459786", symbol: "TTWO", decimals: 18, name: "Take-Two Interactive Software • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174176/large/0x5e81213613b6b86eab4c6c50d718d34359459786.png?1782444740" },
  { address: "0x0E6e67Ba88e7b5d9B67636A215c76779B948dE79", symbol: "UMC", decimals: 18, name: "United Microelectronics • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174147/large/0x0e6e67ba88e7b5d9b67636a215c76779b948de79.png?1782444661" },
  { address: "0xcF364ea52787e289De6F32077834056E3E70D6A8", symbol: "UNH", decimals: 18, name: "UnitedHealth • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175458/large/UNH.png?1786367605" },
  { address: "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2", symbol: "UPS", decimals: 18, name: "UPS • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174201/large/0xf23250dac154d05bb671cb0d0ebef3c635c79ce2.png?1782444806" },
  { address: "0xd917B029C761D264c6A312BBbcDA868658eF86a6", symbol: "USAR", decimals: 18, name: "USA Rare Earth • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174132/large/0xd917b029c761d264c6a312bbbcda868658ef86a6.png?1782444621" },
  { address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", symbol: "USO", decimals: 18, name: "United States Oil Fund • Robinhood Token", aliases: ["CUSO"], logoURI: "https://coin-images.coingecko.com/coins/images/102174125/large/0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344.png?1782444603" },
  { address: "0x6006ed4B2F94110851ff7509D97D034f0EeD9226", symbol: "VICR", decimals: 18, name: "Vicor • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175435/large/VICR.png?1786301195" },
  { address: "0xFA78C12E6488814A0262E4e802749a4a737d5fB7", symbol: "VRT", decimals: 18, name: "Vertiv • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175405/large/VRT.png?1786287621" },
  { address: "0x26dCbfb34FC83CAbD6990f449674efDc6097fF85", symbol: "VSAT", decimals: 18, name: "ViaSat • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175417/large/VSAT.png?1786295596" },
  { address: "0x561e2a49212b7cCF47f2744Ccb83e200722fADBc", symbol: "VST", decimals: 18, name: "Vistra • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175418/large/VST.png?1786295605" },
  { address: "0x0594134DF3f171a354D9C85eBD65b7A6148F6D09", symbol: "VTI", decimals: 18, name: "Vanguard Morningstar Total Stock Market ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175453/large/VTI.png?1786367524" },
  { address: "0x82DA4646242e1D962e96e932269Dc644c94a9CaA", symbol: "WDAY", decimals: 18, name: "Workday • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174198/large/0x82da4646242e1d962e96e932269dc644c94a9caa.png?1782444798" },
  { address: "0xF52597345A8Edf418bc4071b4a35112472277D3e", symbol: "WDC", decimals: 18, name: "Western Digital • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175283/large/WDC.png?1786069944" },
  { address: "0x348Be1A8663f15edDe5CDf8A96BB69078f7aB6Fd", symbol: "WULF", decimals: 18, name: "TeraWulf • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175288/large/WULF.png?1786070062" },
  { address: "0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E", symbol: "WYFI", decimals: 18, name: "WhiteFiber, Inc. • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102175349/large/WYFI.png?1786124263" },
  { address: "0x15Cd20759CE7F3285c29A319dE2D1A2e098c6f43", symbol: "XLK", decimals: 18, name: "State Street Technology Select Sector SPDR ETF • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174157/large/0x15cd20759ce7f3285c29a319de2d1a2e098c6f43.png?1782444689" },
  { address: "0xA8eB3BCcbf2017eE7CBfb652eB51CF2E1B153289", symbol: "XNDU", decimals: 18, name: "Xanadu Quantum • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174180/large/0xa8eb3bccbf2017ee7cbfb652eb51cf2e1b153289.png?1782444750" },
  { address: "0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5", symbol: "XOM", decimals: 18, name: "ExxonMobil Holdings Corporation • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174170/large/0xf9b46d3d1b22199d4d1025a9cedb540a33f1a2d5.png?1782444723" },
  { address: "0x44c4F142009036cF477eD2d09932051843137CF1", symbol: "ZM", decimals: 18, name: "Zoom • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174191/large/0x44c4f142009036cf477ed2d09932051843137cf1.png?1782444779" },
  { address: "0x7dc013eB55e436f30d7ED1AFE4E36d6e45e3c3f7", symbol: "ZS", decimals: 18, name: "Zscaler • Robinhood Token", logoURI: "https://coin-images.coingecko.com/coins/images/102174154/large/0x7dc013eb55e436f30d7ed1afe4e36d6e45e3c3f7.png?1782444680" },
];

// Gnosis (100). Wrapped native first, then stables / majors. USDC.e keeps a
// USDCE alias so typed input without the dot still resolves. logoURI only
// where the 1inch CDN misses (USDC.e); the rest fall through to tokens.1inch.io.
const GNOSIS_100: BuiltinToken[] = [
  { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI", decimals: 18, name: "Wrapped XDAI" },
  { address: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", symbol: "USDC.e", decimals: 6, name: "Bridged USDC (Gnosis)", aliases: ["USDCE"], logoURI: "https://coin-images.coingecko.com/coins/images/38775/large/USDC_Icon.webp?1718798033" },
  { address: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", symbol: "USDC", decimals: 6, name: "USD//C on xDai" },
  { address: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6", symbol: "USDT", decimals: 6, name: "Tether USD on xDai" },
  { address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", symbol: "WETH", decimals: 18, name: "Wrapped Ether on xDai" },
  { address: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", symbol: "GNO", decimals: 18, name: "Gnosis Token on xDai" },
  { address: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", symbol: "sDAI", decimals: 18, name: "Savings xDAI" },
  { address: "0xcB444e90D8198415266c6a2724b7900fb12FC56E", symbol: "EURe", decimals: 18, name: "Monerium EUR emoney" },
  { address: "0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252", symbol: "WBTC", decimals: 8, name: "Wrapped BTC on xDai" },
  { address: "0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6", symbol: "wstETH", decimals: 18, name: "Wrapped liquid staked Ether 2.0 from Mainnet" },
];

// Ink (57073). Wrapped native first, then stables / majors. On-chain USDT0
// symbol() is the non-ASCII "USD₮0"; we store ASCII USDT0 and alias both
// the on-chain glyph and USDT. USDC.e keeps a USDCE alias. logoURI from Ink
// Blockscout icon_url (USDT0 uses the official inkonchain.com SVG).
const INK_57073: BuiltinToken[] = [
  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, name: "Wrapped Ether", logoURI: "https://assets.coingecko.com/coins/images/39810/small/weth.png" },
  { address: "0x0200C29006150606B650577BBE7B6248F58470c1", symbol: "USDT0", decimals: 6, name: "USD₮0", aliases: ["USD₮0", "USDT"], logoURI: "https://inkonchain.com/icons/USDT0.svg" },
  { address: "0x2D270e6886d130D724215A266106e6832161EAEd", symbol: "USDC", decimals: 6, name: "USDC", logoURI: "https://assets.coingecko.com/coins/images/6319/small/USDC.png?1769615602" },
  { address: "0xF1815bd50389c46847f0Bda824eC8da914045D14", symbol: "USDC.e", decimals: 6, name: "Bridged USDC (Stargate)", aliases: ["USDCE"], logoURI: "https://assets.coingecko.com/coins/images/69316/small/usdc.jpg?1758186473" },
  { address: "0x73E0C0d45E048D25Fc26Fa3159b0aA04BfA4Db98", symbol: "kBTC", decimals: 8, name: "Kraken Wrapped Bitcoin", logoURI: "https://assets.coingecko.com/coins/images/50879/small/kBTC.png?1730321084" },
  { address: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", symbol: "USDG", decimals: 6, name: "Global Dollar", logoURI: "https://assets.coingecko.com/coins/images/51281/small/GDN_USDG_Token_200x200.png?1730484111" },
  { address: "0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73", symbol: "GHO", decimals: 18, name: "Gho Token", logoURI: "https://assets.coingecko.com/coins/images/30663/small/gho-token-logo.png?1720517092" },
  { address: "0xA3D68b74bF0528fdD07263c60d6488749044914b", symbol: "weETH", decimals: 18, name: "Wrapped eETH", logoURI: "https://assets.coingecko.com/coins/images/33033/small/weETH.png?1701438396" },
];

// Arc (5042). USDC FIRST and deliberately so: it is the chain's gas token
// (chains.ts `nativeErc20`), the curated list prepends no 0xeee… sentinel
// row there, so this entry is what leads the dApp picker. Its 6 decimals are
// the ERC20 view of a balance the EVM itself treats as 18-decimal — the
// on-chain decimals() below is the only value safe for calldata. WETH here is
// BRIDGED ETH, not a wrapper of the native asset (Arc has none).
const ARC_5042: BuiltinToken[] = [
  { address: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6, name: "USDC", logoURI: "https://coin-images.coingecko.com/coins/images/6319/small/USDC.png?1769615602" },
  { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", symbol: "EURC", decimals: 6, name: "EURC", logoURI: "https://coin-images.coingecko.com/coins/images/26045/small/EURC.png?1769615705" },
  { address: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490", symbol: "USYC", decimals: 6, name: "US Yield Coin" },
  { address: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB", symbol: "WETH", decimals: 18, name: "Wrapped Ether", logoURI: "https://assets.coingecko.com/coins/images/39810/small/weth.png" },
  { address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0", symbol: "cirBTC", decimals: 8, name: "Circle Wrapped Bitcoin" },
];

// chainId → builtin token list. Add a future chain's array here.
const BUILTIN_TOKENS: Record<number, BuiltinToken[]> = {
  4663: ROBINHOOD_4663,
  100: GNOSIS_100,
  57073: INK_57073,
  5042: ARC_5042,
};

/** Builtin tokens for a chain, or [] when the chain has no static table. */
export function builtinTokens(chainId: number): BuiltinToken[] {
  return BUILTIN_TOKENS[chainId] ?? [];
}

/** Exact-symbol match (case-insensitive, aliases included), or null. */
export function builtinBySymbol(chainId: number, symbol: string): BuiltinToken | null {
  const up = symbol.toUpperCase();
  return (
    builtinTokens(chainId).find(
      (t) =>
        t.symbol.toUpperCase() === up ||
        t.aliases?.some((a) => a.toUpperCase() === up),
    ) ?? null
  );
}

/** Exact-address match (case-insensitive), or null. */
export function builtinByAddress(chainId: number, address: string): BuiltinToken | null {
  const lc = address.toLowerCase();
  return builtinTokens(chainId).find((t) => t.address.toLowerCase() === lc) ?? null;
}

// Self-check: the smallest thing that fails if someone fat-fingers a table.
// Runs only when this file is executed directly (`bun run src/tokens_builtin.ts`),
// never on import. Validates unique symbols, checksummed 20-byte addresses, and
// decimals in [0, 36] for every chain's list.
if (import.meta.main) {
  const { toChecksumAddress } = await import("./checksum.ts");
  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.error(`✗ ${msg}`);
  };
  for (const [chainId, tokens] of Object.entries(BUILTIN_TOKENS)) {
    const symbols = new Set<string>();
    const addresses = new Set<string>();
    for (const t of tokens) {
      // Aliases live in the same lookup namespace as symbols — collisions
      // would make builtinBySymbol order-dependent.
      for (const label of [t.symbol, ...(t.aliases ?? [])]) {
        const up = label.toUpperCase();
        if (symbols.has(up)) fail(`chain ${chainId}: duplicate symbol/alias ${label}`);
        symbols.add(up);
      }
      const lc = t.address.toLowerCase();
      if (addresses.has(lc)) fail(`chain ${chainId}: duplicate address ${t.address}`);
      addresses.add(lc);
      if (!/^0x[0-9a-fA-F]{40}$/.test(t.address)) fail(`chain ${chainId}: ${t.symbol} address is not a 20-byte 0x address`);
      else if (toChecksumAddress(t.address) !== t.address) fail(`chain ${chainId}: ${t.symbol} address is not EIP-55 checksummed (${t.address})`);
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) fail(`chain ${chainId}: ${t.symbol} decimals ${t.decimals} out of [0,36]`);
      if (!t.symbol || !t.name) fail(`chain ${chainId}: ${t.address} missing symbol/name`);
    }
    console.error(`chain ${chainId}: ${tokens.length} tokens checked`);
  }
  if (failures > 0) {
    console.error(`\n${failures} problem(s) found`);
    process.exit(1);
  }
  console.error("✓ all builtin token tables valid");
}
