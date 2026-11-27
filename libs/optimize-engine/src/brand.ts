// The one brand module of Crafthall Optimize (R1-01; moved here from apps/optimize/src/brand.ts for R1-10,
// prefix, npm name, binary, version and release label – the package links and the install commands. apps/optimize
// re-exports everything from src/brand.ts; its test/brand.test.ts checks package.json against these values, that no
// other source spells an id itself, and that no id contains "claude" or "anthropic" (legal note §3: no Claude, Claude
// Code or Anthropic in any name). A rename or a version bump touches this file and apps/optimize/package.json only.
// Not ids, so not here: the JSON format kinds (`crafthall-optimize/plan`, `/hypotheses`, `/token-usage`) are part of
// the record contract (R0-02) and keep their value across a rename.

/** Product name shown to users. */
export const PRODUCT_NAME = 'Crafthall Optimize';
/** Claude Code plugin id (R1-02 manifest `name`). */
export const PLUGIN_ID = 'crafthall-optimize';
/** Prefix of the plugin's slash commands, e.g. `/crafthall-optimize:compare`. */
export const COMMAND_PREFIX = `/${PLUGIN_ID}:`;
/**
 * npm package name (R1-04); `npm view` returned 404 on 2026-11-27. Reserved for a later channel: release 1
 * ships without npm (owner, chat 2026-11-27: "can we work on GitHub only for now?"), so no user-facing text names it.
 */
export const NPM_NAME = '@crafthall/optimize';
/** The binary (`bin` in package.json). */
export const BIN_NAME = 'crafthall-optimize';
/** The package version; equals package.json `version`. */
export const CLI_VERSION = '0.1.0';
/** Release label printed after the version while the product is in beta (as Crafthall HQ's 0.1.0 Beta). */
export const RELEASE_LABEL = 'beta';
/** The version as users see it: `0.1.0 beta`. */
export const DISPLAY_VERSION = RELEASE_LABEL ? `${CLI_VERSION} ${RELEASE_LABEL}` : CLI_VERSION;
/**
 * Public source repository (owner, chat 2026-11-27). The repository is created and the code pushed only with the
 * owner's publication go (R1-16); until then the URL does not resolve.
 */
export const REPO_URL = 'https://github.com/crafthall/optimize';
/** package.json `homepage`. */
export const HOMEPAGE = 'https://crafthall.dev';
/**
 * Support channel (R1-14; owner, chat 2026-11-27: "for now no e-mail needed – let them file tickets on GitHub"):
 * the public issue tracker of the source repository, package.json `bugs.url`. There is no support e-mail; the
 * privacy contact on the website stays separate. The tracker is a public channel, so every text that names it tells
 * users not to post prompt text, secrets or unredacted records. It needs no account step, so its status is
 * 'confirmed'; it opens to users when the repository goes public, which is part of the publication go (R1-16).
 */
export const SUPPORT_URL = `${REPO_URL}/issues`;
export const SUPPORT_ADDRESS_STATUS = 'confirmed' as const;

/** Every public id, by the name the release plan (r1.md R1-01) uses for it. */
export const PUBLIC_IDS = {
  productName: PRODUCT_NAME,
  pluginId: PLUGIN_ID,
  commandPrefix: COMMAND_PREFIX,
  npmName: NPM_NAME,
  binName: BIN_NAME,
  version: CLI_VERSION,
  releaseLabel: RELEASE_LABEL,
} as const;

/**
 * The standalone CLI of release 1 (owner, chat 2026-11-27): the zero-dependency bundle, attached under this file name
 * to every GitHub Release of REPO_URL (tag `v<version>`). Users run it with Node.js 20+ (`node <asset> …`, or make it
 * executable and put it on PATH). `npm run optimize:release-asset` builds the file and prints its SHA-256.
 */
export const RELEASE_ASSET = `${BIN_NAME}.mjs`;
/** The project's GitHub Releases page. */
export const RELEASES_URL = `${REPO_URL}/releases`;
/** Download URL of the asset of the newest release (GitHub's `releases/latest/download/<asset>` redirect). */
export const RELEASE_ASSET_LATEST_URL = `${RELEASES_URL}/latest/download/${RELEASE_ASSET}`;
/** Download URL of the asset of one release, tag `v<version>`. */
export const releaseAssetUrl = (version: string = CLI_VERSION): string => `${RELEASES_URL}/download/v${version}/${RELEASE_ASSET}`;

/** The public plugin marketplace of the Crafthall family (shared with Crafthall HQ, owner 2026-11-25). */
export const MARKETPLACE = 'crafthall';
/** What `--marketplace` / `marketplace add` gets: the GitHub repository that hosts the marketplace. */
export const MARKETPLACE_SOURCE = 'crafthall/plugins';
/**
 * First Claude Code version with the one-command install `claude plugin install <plugin> --marketplace <source>`
 * ([S4]; the same fact as Crafthall HQ's ONE_COMMAND_SINCE, pinned equal by the website's tests).
 */
export const ONE_COMMAND_SINCE = '2.1.292';

/** The install and first-run commands, in the order the user types them (README "Install", "Quick start"). */
export const INSTALL = {
  /** One command (Claude Code ONE_COMMAND_SINCE+): adds the marketplace when needed, then installs the plugin. */
  one: `claude plugin install ${PLUGIN_ID} --marketplace ${MARKETPLACE_SOURCE}`,
  /** Older Claude Code: the two README commands. */
  fallback: [`claude plugin marketplace add ${MARKETPLACE_SOURCE}`, `claude plugin install ${PLUGIN_ID}@${MARKETPLACE}`],
  /** Inside a running Claude Code session. */
  inSession: [`/plugin install ${PLUGIN_ID} --marketplace ${MARKETPLACE_SOURCE}`, '/reload-plugins'],
  /** Removes the plugin again (`claude plugin uninstall <plugin>@<marketplace>`, as Crafthall HQ's uninstallCommand). */
  uninstall: `claude plugin uninstall ${PLUGIN_ID}@${MARKETPLACE}`,
  /** The first command to run in Claude Code after the install. */
  firstRun: `${COMMAND_PREFIX}usage`,
  /** Without the plugin: download the standalone CLI from the newest GitHub Release (release 1 has no npm package). */
  cliDownload: `curl -fsSLO ${RELEASE_ASSET_LATEST_URL}`,
  cliHelp: `node ${RELEASE_ASSET} --help`,
  cliUsage: `node ${RELEASE_ASSET} usage`,
  /** Optional: the downloaded file as the `crafthall-optimize` command (the quick start's spelling). */
  cliOnPath: [`chmod +x ${RELEASE_ASSET}`, `mv ${RELEASE_ASSET} ~/.local/bin/${BIN_NAME}`],
  /** The README quick start (about 5 minutes, nothing spent), with the binary name. */
  quickStart: [
    `${BIN_NAME} config set billing subscription`,
    `${BIN_NAME} usage`,
    `${BIN_NAME} fixture add fix-login --prompt tasks/fix-login.md --check "npm test"`,
    'git diff > trim-claude-md.patch',
    `${BIN_NAME} compare --change trim-claude-md.patch --plan-only`,
  ],
} as const;
