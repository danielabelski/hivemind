import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { spawn as nodeSpawn, ChildProcess } from "node:child_process";
import { spawnGraphPullWorker } from "../../../src/graph/spawn-pull-worker.js";

describe("spawnGraphPullWorker", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HIVEMIND_GRAPH_PULL;
    delete process.env.HIVEMIND_GRAPH_PULL;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HIVEMIND_GRAPH_PULL;
    else process.env.HIVEMIND_GRAPH_PULL = prev;
  });

  /**
   * Test seam: spawn is injected. We never run a real child process —
   * we capture argv/options and assert on them. This keeps the OS
   * boundary test-stable across CI environments that might not have
   * `nohup` or node on a predictable path.
   */
  function fakeSpawn(): { calls: { cmd: string; args: string[]; opts: unknown }[]; spy: typeof nodeSpawn } {
    const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
    const impl = (cmd: string, args: readonly string[], opts: unknown) => {
      calls.push({ cmd, args: [...args], opts });
      // The real spawn returns a ChildProcess; only .unref() is touched
      // by our code path, so a minimal stand-in is enough.
      return { unref: vi.fn() } as unknown as ChildProcess;
    };
    const spy = impl as unknown as typeof nodeSpawn;
    return { calls, spy };
  }

  it("spawns `nohup node <bundleDir>/graph-pull-worker.js --cwd <cwd>` detached", () => {
    const { calls, spy } = fakeSpawn();
    spawnGraphPullWorker("/some/project", "/bundle/dir", { spawn: spy });

    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd).toBe("nohup");
    expect(args).toEqual([
      "node",
      "/bundle/dir/graph-pull-worker.js",
      "--cwd",
      "/some/project",
    ]);
    // `detached: true` and stdio fully ignored are non-negotiable —
    // without either, the worker can't outlive the parent SessionStart.
    expect(opts).toMatchObject({
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  });

  it("calls .unref() on the returned child (parent can exit without waiting)", () => {
    const unref = vi.fn();
    const impl = () => ({ unref }) as unknown as ChildProcess;
    const spy = impl as unknown as typeof nodeSpawn;
    spawnGraphPullWorker("/cwd", "/bundle", { spawn: spy });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("HIVEMIND_GRAPH_PULL=0 → does NOT spawn (avoids wasted process for env-disabled state)", () => {
    process.env.HIVEMIND_GRAPH_PULL = "0";
    const { calls, spy } = fakeSpawn();
    spawnGraphPullWorker("/cwd", "/bundle", { spawn: spy });
    // `calls.length === 0` IS the "never invoked" assertion — our fake
    // spawn captures every invocation, so empty list = no spawn happened.
    expect(calls).toHaveLength(0);
  });

  it("spawn throwing does NOT propagate (best-effort guarantee — must not crash the hook)", () => {
    const impl = () => { throw new Error("spawn ENOENT nohup"); };
    const spy = impl as unknown as typeof nodeSpawn;
    expect(() => spawnGraphPullWorker("/cwd", "/bundle", { spawn: spy })).not.toThrow();
  });

  it("worker path is composed via join — survives trailing slashes in bundleDir", () => {
    const { calls, spy } = fakeSpawn();
    spawnGraphPullWorker("/cwd", "/bundle/dir/", { spawn: spy });
    // join() normalizes the trailing slash; the worker path is well-formed.
    expect(calls[0]!.args[1]).toBe("/bundle/dir/graph-pull-worker.js");
  });
});
