// The ports a built command needs (files, git, clock, machine identity, tool versions). main.ts passes the node
// implementation (node-deps.ts); unit tests pass fakes, so every exit code is testable without a real repo.
import type { StoreFs } from '@crafthall/optimize-engine';

/** git is missing or failed in a way the user must fix in the environment (exit code 4). */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/**
 * The comparison was interrupted: SIGINT or SIGTERM reached the CLI (Ctrl-C reaches the whole foreground
 * process group; `kill <pid>` only the CLI, which then ends the running child) or ended a child (claude, the success
 * command or git). The CLI, which holds the signal while a comparison runs (`trapInterrupts`), stops scheduling,
 * cleans up and writes an incomplete record (exit 5).
 */
export class InterruptedError extends Error {
  constructor(readonly signal: string) {
    super(`interrupted by ${signal}`);
    this.name = 'InterruptedError';
  }
}

export interface GitPort {
  /** Full commit id of a revision, or null when the revision is no commit of this repo. Throws EnvironmentError when git cannot run. */
  resolveCommit(repoRoot: string, rev: string): string | null;
  /** True when tracked files have uncommitted changes (staged or not); untracked files do not count. */
  isDirty(repoRoot: string): boolean;
  /** Identity strings of this repo that must never enter a record: git user name and e-mail, current branch. */
  identities(repoRoot: string): string[];
}

/** Outcome of one child process. */
export interface ProcessResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  /** The binary is not on PATH. */
  notFound: boolean;
}

/**
 * Runner port of `compare`: the user's own, unmodified `claude` from PATH and the fixture's success command.
 * Tests pass a stub that returns recorded `-p` JSON; nothing in a test calls the real `claude`.
 */
export interface RunnerPort {
  /** First line of `claude --version`, or null when `claude` is not on PATH or prints nothing. */
  claudeVersion(): string | null;
  /**
   * Runs `claude <args>` in `cwd` with the prompt on stdin (never in argv). Async in the node port, so a signal
   * to the CLI is handled while the child runs. A run past `timeoutMs` is killed and reported as `timedOut` (never as
   * an interrupt); an interrupt throws InterruptedError.
   */
  claude(args: readonly string[], opts: { cwd: string; input: string; timeoutMs: number }): ProcessResult | Promise<ProcessResult>;
  /** Runs the success command through the shell in `cwd`; its exit code, or null on timeout or a signal. */
  check(command: string, opts: { cwd: string; timeoutMs: number }): number | null | Promise<number | null>;
}

/** Fresh git worktrees for cold runs (validation §4.1): one per run, detached at the fixture's commit. */
export interface WorktreePort {
  /** Creates a detached worktree of `commit` in a new temporary directory and returns that directory. */
  add(repoRoot: string, commit: string): string;
  /** Applies a patch (git apply) in `dir`; `checkOnly` tests it without changing files. False when it does not apply. */
  apply(dir: string, patch: string, checkOnly?: boolean): boolean;
  /** Removes the worktree and its directory. */
  remove(repoRoot: string, dir: string): void;
}

export interface CliDeps {
  cwd: string;
  fs: StoreFs;
  git: GitPort;
  /** Nearest directory at or above `cwd` that holds `.git`; null outside a repo. */
  findRepoRoot(cwd: string): string | null;
  /** Text of a file by absolute path; undefined when it does not exist or is not a file. */
  readFile(path: string): string | undefined;
  now(): Date;
  /** Identity strings of this machine (user name, host name). */
  machineIdentities(): string[];
  /** Version of a tool from `<tool> --version`, run in `cwd`; null when it does not run or prints no version. */
  toolVersion(tool: string, cwd: string): string | null;
  /** 32 random bytes as 64 lower-case hex characters (the store salt). */
  randomHex(): string;
  runner: RunnerPort;
  worktrees: WorktreePort;
  /**
   * True when the environment variable is set and not empty. A presence check only (R0-12): the port never returns
   * a value, so no secret from the environment can reach a record, the output or a log. The child `claude` gets the
   * user's environment as it is (the runner does not pass or change `env`).
   */
  hasEnv(name: string): boolean;
  /**
   * Holds SIGINT and SIGTERM (no default exit) while a comparison runs, so a Ctrl-C ends only the running child and
   * the CLI can remove its worktrees and write an incomplete record. Returns the release. Absent in fakes.
   */
  trapInterrupts?(): () => void;
  /** The signal (SIGINT or SIGTERM) the CLI received while trapped, or null. Absent in fakes. */
  interrupted?(): string | null;
  /** Asks a yes/no question on the terminal; null when there is no terminal (non-interactive). */
  confirm(question: string): boolean | null;
  /** Asks a free-text question on the terminal (R0-10 billing mode); null or absent when there is no terminal. */
  ask?(question: string): string | null;
  /**
   * Text piped to stdin (`import-usage`); null when stdin is a terminal or nothing was piped. Optional so the
   * fakes of other commands need not implement it.
   */
  readStdin?(): string | null;
  /** The user's home directory, only to turn a pasted `~/…` path into a repo-relative one; never printed or stored. */
  homeDir?(): string | null;
}
