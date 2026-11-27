// The brand module of Crafthall Optimize for the CLI (R1-01). The values live in @crafthall/optimize-engine/brand
// since R1-10, so the website can read them without importing an app; this file re-exports the same values and
// stays the one place the CLI's sources import an id from. test/brand.test.ts pins the values, checks package.json
// against them and checks that no other CLI source spells an id itself.
export {
  BIN_NAME,
  CLI_VERSION,
  COMMAND_PREFIX,
  DISPLAY_VERSION,
  HOMEPAGE,
  INSTALL,
  NPM_NAME,
  PLUGIN_ID,
  PRODUCT_NAME,
  PUBLIC_IDS,
  RELEASE_ASSET,
  RELEASE_ASSET_LATEST_URL,
  RELEASE_LABEL,
  RELEASES_URL,
  releaseAssetUrl,
  REPO_URL,
  SUPPORT_ADDRESS_STATUS,
  SUPPORT_URL,
} from '@crafthall/optimize-engine/brand';
