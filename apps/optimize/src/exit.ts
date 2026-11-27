// Exit codes (release r0 §4) and the output port shared by every command handler.
// 0 done, 1 internal error, 2 usage error, 3 refused by a guard, 4 environment error, 5 run cap reached or interrupted (Ctrl-C).
export const EXIT = { ok: 0, internal: 1, usage: 2, refused: 3, environment: 4, runCap: 5 } as const;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}
