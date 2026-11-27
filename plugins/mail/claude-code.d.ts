// The subset of Claude Code's engine-provided `claude-code` declarations that claude.ts uses, so
// the repository's tsc and type-aware lint can check it. Not shipped: the engine supplies the real
// module, and `claude plugin validate` checks the mod against it.
declare module "claude-code" {
  interface Events {
    "session.start": [{ isInteractive: boolean }, { cwd: string }];
    "turn.start": [{ agentId?: string }, unknown];
    "turn.complete": [
      { agentId?: string; reason: "answer" | "refusal" | "aborted" | "error" },
      unknown,
    ];
    "tool.call": [unknown, unknown];
  }

  type Hook<K extends keyof Events> = (
    $: EngineInterface,
    e: Events[K][0],
    next: (e: Events[K][0]) => Promise<Events[K][1]>,
  ) => Events[K][1] | Promise<Events[K][1]>;

  export type Register = (
    on: <K extends keyof Events>(event: K, hook: Hook<K>) => unknown,
  ) => unknown;

  export interface EngineInterface {
    plugin: { root: string };
    clock: {
      now(): Promise<number>;
      sleep(ms: number): Promise<void>;
      after(ms: number, fn: () => void): { cancel(): void };
    };
    process: {
      run(
        argv: readonly string[],
        init?: { stdin?: string; timeoutMs?: number },
      ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    prompt: { submit(input: { text: string }): Promise<{ drop?: string }> };
    session: { id(): Promise<string>; cwd(): Promise<string> };
    ui: { log(text: string): void };
  }
}
