// node implementation of the CLI ports (deps.ts): git and tool versions through child processes (no shell), files
// through node:fs, identities from node:os and git config. Makes no network call.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { parseToolVersion } from '@crafthall/optimize-engine';
import { BIN_NAME } from './brand';
import { EnvironmentError, InterruptedError, type CliDeps, type GitPort, type RunnerPort, type WorktreePort } from './deps';
import { findRepoRoot, nodeStoreFs } from './node-store';

/** Branch names that are no identity (blocking them would refuse every `npm test -- main.test.ts`). */
const COMMON_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'HEAD']);

/** Branch-type prefixes that name no person, ticket or customer. */
const BRANCH_PREFIXES = new Set(['feature', 'feat', 'fix', 'bugfix', 'hotfix', 'release', 'chore', 'docs', 'refactor', 'test', 'tests', 'users', 'user']);

/**
 * Identity strings of a branch name: the whole name and each `/`-segment that is not a branch-type prefix, so
 * `feature/acme-ticket-42` blocks both the full name and `acme-ticket-42`. Common trunk names block nothing.
 */
export function branchIdentities(branch: string): string[] {
  if (!branch || COMMON_BRANCHES.has(branch)) return [];
  const segments = branch.split('/').filter((s) => s && !BRANCH_PREFIXES.has(s.toLowerCase()) && !COMMON_BRANCHES.has(s));
  return [...new Set([branch, ...segments])];
}

/** Signals that mean the user interrupted the comparison (Ctrl-C reaches the child too). */
const INTERRUPTS = new Set(['SIGINT', 'SIGTERM']);
const errorCode = (r: { error?: Error }): string | undefined => (r.error as NodeJS.ErrnoException | undefined)?.code;
const throwIfInterrupted = (r: { signal: NodeJS.Signals | null; error?: Error }): void => {
  // A spawnSync timeout kills the child with SIGTERM too: that is a timeout, not the user's Ctrl-C.
  if (errorCode(r) === 'ETIMEDOUT') return;
  if (r.signal && INTERRUPTS.has(r.signal)) throw new InterruptedError(r.signal);
};

/**
 * Time limit of one git call. 15 s was too short on a busy machine (load ~314 in the T1 run of 2026-11-26):
 * a timed-out `git worktree add` ended the comparison. Tests pass a shorter limit through `nodeDeps(cwd, options)`.
 */
export const GIT_TIMEOUT_MS = 120_000;

/** Options of the node ports; only tests set them (never read from the environment). */
export interface NodeDepsOptions {
  /** Time limit of one git call in ms (default GIT_TIMEOUT_MS). */
  gitTimeoutMs?: number;
}

/** git ran past its time limit: the machine is busy, git is installed. Exit code 4 like every EnvironmentError. */
export class GitTimeoutError extends EnvironmentError {
  constructor(timeoutMs: number) {
    super(`git timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} s (machine busy?)`);
    this.name = 'GitTimeoutError';
  }
}

type GitResult = { status: number | null; stdout: string; signal: NodeJS.Signals | null };
type GitCall = (cwd: string, args: string[], input?: string) => GitResult;

const gitWith =
  (timeoutMs: number): GitCall =>
  (cwd, args, input) => {
    const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (errorCode(r) === 'ETIMEDOUT') throw new GitTimeoutError(timeoutMs);
    if (r.error) throw new EnvironmentError(`git could not run (${errorCode(r) ?? r.error.name}); install git and retry`);
    return { status: r.status, stdout: r.stdout, signal: r.signal };
  };

export const createNodeGit = (timeoutMs = GIT_TIMEOUT_MS): GitPort => {
  const git = gitWith(timeoutMs);
  return {
    resolveCommit: (repoRoot, rev) => {
      if (rev.startsWith('-')) return null;
      const r = git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
      const id = r.stdout.trim();
      return r.status === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : null;
    },
    isDirty: (repoRoot) => {
      const r = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
      if (r.status !== 0) throw new EnvironmentError('git status failed in this repository');
      return r.stdout.trim() !== '';
    },
    identities: (repoRoot) => {
      const value = (args: string[]): string => {
        const r = git(repoRoot, args);
        return r.status === 0 ? r.stdout.trim() : '';
      };
      const branch = value(['rev-parse', '--abbrev-ref', 'HEAD']);
      return [value(['config', 'user.name']), value(['config', 'user.email']), ...branchIdentities(branch)].filter(Boolean);
    },
  };
};

export const nodeGit: GitPort = createNodeGit();

/**
 * Interrupt state of one CLI process: the signal the CLI received while a comparison runs, and the children
 * running at that moment. A SIGINT or SIGTERM sent to the CLI alone (`kill <pid>`) ends every running child with the
 * same signal, so the comparison stops at once instead of when the run loop ends.
 */
export interface InterruptControl {
  signal: NodeJS.Signals | null;
  readonly children: Set<ChildProcess>;
  /** Installs the handlers (no default exit) and returns the release. */
  trap(): () => void;
}

export const KILL_GRACE_MS = 5_000;

export function createInterruptControl(): InterruptControl {
  const control: InterruptControl = {
    signal: null,
    children: new Set(),
    trap: () => {
      const hold = (signal: NodeJS.Signals): void => {
        control.signal ??= signal;
        for (const child of control.children) stopChild(child, signal);
      };
      process.on('SIGINT', hold);
      process.on('SIGTERM', hold);
      return () => {
        process.off('SIGINT', hold);
        process.off('SIGTERM', hold);
      };
    },
  };
  return control;
}

function stopChild(child: ChildProcess, signal: NodeJS.Signals): void {
  child.kill(signal);
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

interface ChildOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  timedOut: boolean;
  /** Spawn error code (ENOENT: not on PATH), or ENOBUFS when stdout passed `maxBuffer`. */
  errorCode: string | undefined;
}

/**
 * Runs one child asynchronously: stdin gets `input`, stdout is collected up to `maxBuffer` (past it the child
 * is ended, ENOBUFS, like spawnSync), stderr is ignored. Past `timeoutMs` the child is ended with SIGTERM and the
 * outcome is `timedOut` – a timeout, never an interrupt. The child is tracked in `control` while it runs.
 */
function runChild(
  control: InterruptControl,
  file: string,
  args: readonly string[],
  opts: { cwd: string; input?: string; timeoutMs: number; shell?: boolean; maxBuffer?: number },
): Promise<ChildOutcome> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], { cwd: opts.cwd, shell: opts.shell ?? false, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    } catch (e) {
      done({ status: null, signal: null, stdout: '', timedOut: false, errorCode: (e as NodeJS.ErrnoException).code ?? 'EINVAL' });
      return;
    }
    control.children.add(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let errorCode: string | undefined;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child, 'SIGTERM');
    }, opts.timeoutMs);
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      control.children.delete(child);
      done({ status, signal, stdout: Buffer.concat(chunks).toString('utf8'), timedOut, errorCode });
    };
    // A signal that arrived before this child was tracked still ends it.
    if (control.signal) stopChild(child, control.signal);
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length;
      if (opts.maxBuffer !== undefined && size > opts.maxBuffer) {
        errorCode ??= 'ENOBUFS';
        stopChild(child, 'SIGTERM');
        return;
      }
      chunks.push(b);
    });
    if (child.stdin) {
      child.stdin.on('error', () => undefined); // the child may end before it reads its stdin (EPIPE)
      child.stdin.end(opts.input);
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      errorCode ??= e.code ?? 'EINVAL';
      finish(null, null);
    });
    child.on('close', (status, signal) => finish(status, signal));
    // A grandchild may keep stdout open after the child ended; wait for it at most a second.
    child.on('exit', (status, signal) => {
      drain = setTimeout(() => finish(status, signal), 1_000);
    });
  });
}

/** Throws InterruptedError when the CLI was interrupted or the child ended by SIGINT/SIGTERM – unless it timed out. */
const throwIfChildInterrupted = (control: InterruptControl, r: ChildOutcome): void => {
  if (r.timedOut) return; // the timeout's own SIGTERM is a timeout, not the user's Ctrl-C
  if (control.signal) throw new InterruptedError(control.signal);
  if (r.signal && INTERRUPTS.has(r.signal)) throw new InterruptedError(r.signal);
};

/** Options of the node runner; only tests set them. */
export interface NodeRunnerOptions {
  /** Absolute path of the `claude` to run instead of `claude` from PATH (tests: a stub written by writeStubClaude). */
  claudeBin?: string;
}

/**
 * The user's own `claude` from PATH (never a bundled or modified copy) and the fixture's success command. No `env`
 * option: the child inherits the user's environment untouched, and Optimize itself never reads auth values (R0-12).
 * `claude` and the success command run asynchronously, so a signal to the CLI ends them at once.
 */
export const createNodeRunner = (control: InterruptControl, options: NodeRunnerOptions = {}): RunnerPort => {
  const bin = options.claudeBin ?? 'claude';
  return {
    claudeVersion: () => {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
      throwIfInterrupted(r);
      if (r.error || r.status !== 0) return null;
      return r.stdout.split('\n')[0]!.trim() || null;
    },
    claude: async (args, { cwd, input, timeoutMs }) => {
      if (control.signal) throw new InterruptedError(control.signal);
      const r = await runChild(control, bin, args, { cwd, input, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      throwIfChildInterrupted(control, r);
      return { status: r.status, stdout: r.errorCode === 'ENOBUFS' ? '' : r.stdout, timedOut: r.timedOut, notFound: r.errorCode === 'ENOENT' };
    },
    check: async (command, { cwd, timeoutMs }) => {
      if (control.signal) throw new InterruptedError(control.signal);
      const r = await runChild(control, command, [], { cwd, timeoutMs, shell: true });
      throwIfChildInterrupted(control, r);
      return r.errorCode || r.timedOut || r.status === null ? null : r.status;
    },
  };
};

/** Best effort: drops worktree entries whose directory is gone; a failure leaves a stale entry git prunes later. */
const pruneQuietly = (git: GitCall, repoRoot: string): void => {
  try {
    git(repoRoot, ['worktree', 'prune']);
  } catch {
    // git busy or missing: the directory is already removed
  }
};

/**
 * Detached worktrees in fresh temporary directories, removed after each run. Every path removes its own temporary
 * directory, also when git fails or times out (: a timed-out `worktree add` left its directory behind).
 */
export const createNodeWorktrees = (timeoutMs = GIT_TIMEOUT_MS): WorktreePort => {
  const git = gitWith(timeoutMs);
  const discard = (repoRoot: string, dir: string): void => {
    rmSync(dir, { recursive: true, force: true });
    pruneQuietly(git, repoRoot);
  };
  return {
    add: (repoRoot, commit) => {
      const dir = mkdtempSync(join(tmpdir(), `${BIN_NAME}-run-`));
      let r: GitResult;
      try {
        r = git(repoRoot, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
      } catch (e) {
        discard(repoRoot, dir);
        throw e;
      }
      if (r.signal && INTERRUPTS.has(r.signal)) {
        // A half-made worktree is removed before the interrupt is reported.
        try {
          git(repoRoot, ['worktree', 'remove', '--force', dir]);
        } catch {
          // removed with the directory below
        }
        discard(repoRoot, dir);
        throw new InterruptedError(r.signal);
      }
      if (r.status !== 0) {
        discard(repoRoot, dir);
        throw new EnvironmentError(`git worktree add failed for commit ${commit.slice(0, 12)}`);
      }
      return dir;
    },
    apply: (dir, patch, checkOnly = false) => {
      const r = git(dir, ['apply', ...(checkOnly ? ['--check'] : []), '-'], patch);
      throwIfInterrupted(r);
      return r.status === 0;
    },
    remove: (repoRoot, dir) => {
      // A timed-out removal is retried once; after that (or any other git failure) the directory is deleted and the
      // worktree list pruned, so a busy git never leaves a run directory behind. Never throws for git.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          git(repoRoot, ['worktree', 'remove', '--force', dir]);
          break;
        } catch (e) {
          if (!(e instanceof GitTimeoutError)) break;
        }
      }
      discard(repoRoot, dir);
    },
  };
};

export const nodeWorktrees: WorktreePort = createNodeWorktrees();

/** y/N on the terminal; null when stdin is no terminal. */
export function terminalConfirm(question: string): boolean | null {
  const answer = terminalAsk(question);
  return answer === null ? null : /^\s*y(es)?\s*$/i.test(answer);
}

/** One line of free text from the terminal; null when stdin is no terminal. */
export function terminalAsk(question: string): string | null {
  if (!process.stdin.isTTY) return null;
  process.stderr.write(question);
  const buf = Buffer.alloc(256);
  let fd: number | null = null;
  try {
    fd = openSync('/dev/tty', 'r');
    const n = readSync(fd, buf, 0, buf.length, null);
    return buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export const nodeDeps = (cwd: string = process.cwd(), options: NodeDepsOptions = {}): CliDeps => {
  // One interrupt state per CLI process: the trap records the signal and ends the running children.
  const interrupts = createInterruptControl();
  return {
    cwd,
    fs: nodeStoreFs,
    git: options.gitTimeoutMs === undefined ? nodeGit : createNodeGit(options.gitTimeoutMs),
    findRepoRoot,
    readFile: (p) => {
      try {
        return statSync(p).isFile() ? readFileSync(p, 'utf8') : undefined;
      } catch {
        return undefined;
      }
    },
    now: () => new Date(),
    machineIdentities: () => {
      const host = hostname();
      let user = '';
      try {
        user = userInfo().username;
      } catch {
        // no passwd entry (some containers): nothing to add
      }
      return [user, host, host.split('.')[0] ?? ''].filter(Boolean);
    },
    toolVersion: (tool, dir) => {
      const r = spawnSync(tool, ['--version'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
      return r.error || r.status !== 0 ? null : parseToolVersion(`${r.stdout}\n${r.stderr}`);
    },
    randomHex: () => randomBytes(32).toString('hex'),
    hasEnv: (name) => (process.env[name] ?? '') !== '',
    runner: createNodeRunner(interrupts),
    worktrees: options.gitTimeoutMs === undefined ? nodeWorktrees : createNodeWorktrees(options.gitTimeoutMs),
    confirm: terminalConfirm,
    ask: terminalAsk,
    trapInterrupts: () => interrupts.trap(),
    interrupted: () => interrupts.signal,
    readStdin: () => {
      if (process.stdin.isTTY) return null;
      try {
        return readFileSync(0, 'utf8');
      } catch {
        return null;
      }
    },
    homeDir: () => {
      try {
        return homedir() || null;
      } catch {
        return null;
      }
    },
  };
};
