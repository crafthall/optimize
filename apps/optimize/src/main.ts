// Entry of the bundled binary (dist/crafthall-optimize.mjs). An uncaught error is a bug: exit code 1 (cli.ts main).
import { main } from './cli';
import { nodeDeps, type NodeDepsOptions } from './node-deps';

/**
 * Test-only seam: an E2E preload (`node --import`) may put node-port options here, e.g. a 1 s git timeout.
 * Code inside this process is the only way to set it – no environment variable or flag a user could set by accident.
 */
const TEST_OPTIONS = Symbol.for('crafthall-optimize.test.node-deps-options');
const raw = (globalThis as Record<symbol, unknown>)[TEST_OPTIONS] as NodeDepsOptions | undefined;
const options: NodeDepsOptions = typeof raw?.gitTimeoutMs === 'number' && raw.gitTimeoutMs > 0 ? { gitTimeoutMs: raw.gitTimeoutMs } : {};

const io = { out: (l: string) => process.stdout.write(`${l}\n`), err: (l: string) => process.stderr.write(`${l}\n`) };
// `compare` is async; main never rejects (an uncaught error is mapped to exit 1).
void Promise.resolve(main(process.argv.slice(2), io, nodeDeps(process.cwd(), options))).then((code) => {
  process.exitCode = code;
});
