export const product = Object.freeze({
  name: "Relay QA Hub",
  appVersion: __APP_VERSION__,
  contractVersion: __CONTRACT_VERSION__,
  mobileBaselineCssPixels: 360,
  sourceOfTruth: "QA Hub",
  relayRole: "optional-executor",
} as const);
