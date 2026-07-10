import { describe, expect, it } from "vitest";
import {
  MAIN_SCOPE,
  branchScope,
  parseScope,
  currentBranch,
  trunkBranch,
  currentScope,
  type GitRunner,
} from "../../src/docs/branch-scope.js";

/** Build a git runner from a map of joined-args -> stdout (or null). */
function fakeGit(responses: Record<string, string | null>): GitRunner {
  return (args: string[]) => {
    const key = args.join(" ");
    return key in responses ? responses[key] : null;
  };
}

describe("branchScope / parseScope", () => {
  it("encodes and round-trips a branch overlay scope", () => {
    expect(branchScope("feature-x")).toBe("b:feature-x");
    expect(parseScope("b:feature-x")).toEqual({ kind: "branch", branch: "feature-x" });
  });

  it("parses main and unknown/empty as main", () => {
    expect(parseScope("main")).toEqual({ kind: "main" });
    expect(parseScope("")).toEqual({ kind: "main" });
    expect(parseScope(undefined)).toEqual({ kind: "main" });
  });

  it("preserves branch names that contain slashes", () => {
    expect(parseScope(branchScope("feat/auth/login"))).toEqual({ kind: "branch", branch: "feat/auth/login" });
  });
});

describe("currentBranch", () => {
  it("returns the branch name on a normal checkout", () => {
    expect(currentBranch(fakeGit({ "rev-parse --abbrev-ref HEAD": "feature-x\n" }))).toBe("feature-x");
  });

  it("returns null on a detached HEAD (no branch identity)", () => {
    expect(currentBranch(fakeGit({ "rev-parse --abbrev-ref HEAD": "HEAD" }))).toBeNull();
  });

  it("returns null when git fails (non-git dir)", () => {
    expect(currentBranch(fakeGit({}))).toBeNull();
  });
});

describe("trunkBranch", () => {
  it("reads the default branch from origin/HEAD", () => {
    expect(trunkBranch(fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master\n" }))).toBe("master");
  });

  it("falls back to main when origin/HEAD is unset (no remote)", () => {
    expect(trunkBranch(fakeGit({}))).toBe("main");
  });
});

describe("currentScope", () => {
  it("is main on the trunk branch", () => {
    const git = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main",
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
    });
    expect(currentScope(git)).toBe(MAIN_SCOPE);
  });

  it("is a branch overlay off the trunk", () => {
    const git = fakeGit({
      "rev-parse --abbrev-ref HEAD": "feature-x",
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
    });
    expect(currentScope(git)).toBe("b:feature-x");
  });

  it("treats the repo's real trunk (master) as main even when named differently", () => {
    const git = fakeGit({
      "rev-parse --abbrev-ref HEAD": "master",
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
    });
    expect(currentScope(git)).toBe(MAIN_SCOPE);
  });

  it("is main on a detached HEAD", () => {
    expect(currentScope(fakeGit({ "rev-parse --abbrev-ref HEAD": "HEAD" }))).toBe(MAIN_SCOPE);
  });

  it("accepts an explicit trunk to avoid a second git call", () => {
    const git = fakeGit({ "rev-parse --abbrev-ref HEAD": "dev" });
    expect(currentScope(git, "dev")).toBe(MAIN_SCOPE);
    expect(currentScope(git, "main")).toBe("b:dev");
  });
});
