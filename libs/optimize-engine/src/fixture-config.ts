// Untrusted fixture config (R0-13; legal note §3 item 3). Without `--bare`, a `claude -p` session runs the
// repository's hooks and MCP servers "even in a folder you've never trusted", with no trust dialog. A fixture repo can
// be someone else's code, so `fixture add` lists what it would run and `compare --auth subscription` (the only mode
// without `--bare`) refuses unless the user passes --trust-fixture-config. Pure: config texts come in as values.

/** Repo-relative files Claude Code reads hooks from (project and local settings). */
export const HOOK_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;
/** Repo-relative file of project-scoped MCP servers. */
export const MCP_FILE = '.mcp.json';
/** Every file `findFixtureConfigRisks` reads, for the caller. */
export const FIXTURE_CONFIG_FILES: readonly string[] = [...HOOK_SETTINGS_FILES, MCP_FILE];

export interface FixtureConfigRisks {
  /** Hook events with the number of hook commands each, per settings file, e.g. `{ file, event: 'PreToolUse', count: 2 }`. */
  hooks: { file: string; event: string; count: number }[];
  /** MCP server names declared in `.mcp.json` (and `mcpServers` of a settings file). */
  mcpServers: { file: string; name: string }[];
  /** Files that exist but are not valid JSON: treated as a risk (they cannot be checked). */
  unreadable: string[];
}

const SAFE_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
/** Names are printed; anything that is not a short plain identifier is shown as `<unnamed>`. */
const shown = (name: string): string => (SAFE_NAME.test(name) ? name : '<unnamed>');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Number of hook commands under one event: an array of matcher groups, each with a `hooks` array. */
function hookCount(groups: unknown): number {
  if (!Array.isArray(groups)) return isObject(groups) ? 1 : 0;
  return groups.reduce<number>((n, g) => n + (isObject(g) && Array.isArray(g['hooks']) ? g['hooks'].length : isObject(g) ? 1 : 0), 0);
}

/**
 * Hooks and MCP servers that a non-bare `claude -p` would run in this repo. `read` returns the text of a repo-relative
 * file or undefined when it does not exist.
 */
export function findFixtureConfigRisks(read: (repoRelative: string) => string | undefined): FixtureConfigRisks {
  const out: FixtureConfigRisks = { hooks: [], mcpServers: [], unreadable: [] };
  const parse = (file: string): Record<string, unknown> | null => {
    const text = read(file);
    if (text === undefined) return null;
    try {
      const v = JSON.parse(text) as unknown;
      return isObject(v) ? v : null;
    } catch {
      out.unreadable.push(file);
      return null;
    }
  };
  for (const file of HOOK_SETTINGS_FILES) {
    const s = parse(file);
    if (!s) continue;
    if (isObject(s['hooks']))
      for (const [event, groups] of Object.entries(s['hooks'])) {
        const count = hookCount(groups);
        if (count > 0) out.hooks.push({ file, event: shown(event), count });
      }
    if (isObject(s['mcpServers'])) for (const name of Object.keys(s['mcpServers'])) out.mcpServers.push({ file, name: shown(name) });
  }
  const mcp = parse(MCP_FILE);
  if (mcp && isObject(mcp['mcpServers'])) for (const name of Object.keys(mcp['mcpServers'])) out.mcpServers.push({ file: MCP_FILE, name: shown(name) });
  return out;
}

export const hasFixtureConfigRisks = (r: FixtureConfigRisks): boolean => r.hooks.length > 0 || r.mcpServers.length > 0 || r.unreadable.length > 0;

/** One line per finding, e.g. `hook PreToolUse ×2 (.claude/settings.json)`, `MCP server github (.mcp.json)`. */
export function describeFixtureConfigRisks(r: FixtureConfigRisks): string[] {
  return [
    ...r.hooks.map((h) => `hook ${h.event} ×${h.count} (${h.file})`),
    ...r.mcpServers.map((m) => `MCP server ${m.name} (${m.file})`),
    ...r.unreadable.map((f) => `${f} is not valid JSON and could not be checked`),
  ];
}

/**
 * that anything is safe, the user decides.
 */
export function fixtureConfigWarning(r: FixtureConfigRisks, bin: string): string[] {
  return [
    'Security note: this repository configures hooks or MCP servers that Claude Code starts on its own (only these were checked):',
    ...describeFixtureConfigRisks(r).map((l) => `  - ${l}`),
    "Without --bare, a `claude -p` run starts these hooks and connects these MCP servers with no trust dialog, so commands from this repository run on your machine. Its settings `env` block and helper commands such as apiKeyHelper also apply and were not checked.",
    `\`${bin} compare\` runs with --bare by default (--auth api-key), which does not start them; --bare is not a sandbox, and the fixture's check command still runs this repository's code. With --auth subscription it refuses this fixture unless you pass --trust-fixture-config.`,
    'Add fixtures only from repositories whose code you trust.',
  ];
}
