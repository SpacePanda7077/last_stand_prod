import type { DeploymentInput } from "@chain-protocol/casino-sdk";

export default {
  kind: "casino",
  contract: { source: "src/mycontract.sol", name: "MexicanStandoff" },
} satisfies DeploymentInput;
