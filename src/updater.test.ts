import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
// vi.mock's factory is hoisted above ordinary top-level declarations, so a
// plain `class FakeChannel {}` referenced inside it would hit a
// before-initialization error the way `invoke`'s bare `vi.fn()` doesn't;
// vi.hoisted lifts the class declaration itself above that hoist point.
const { FakeChannel } = vi.hoisted(() => ({
  FakeChannel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => (invoke as (...a: unknown[]) => unknown)(...args),
  Channel: FakeChannel,
}));

const confirmDialog = vi.fn();
const messageDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => (confirmDialog as (...a: unknown[]) => unknown)(...args),
  message: (...args: unknown[]) => (messageDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// @tauri-apps/api/core and @tauri-apps/plugin-dialog are already mocked by
// the time ./updater is evaluated — same pattern as streamconvert.test.ts.
import { checkForUpdatesAndPrompt, type UpdaterDeps } from "./updater";

const update = {
  rid: 7,
  currentVersion: "0.7.0",
  version: "0.8.0",
  rawJson: {},
};

function makeDeps(): { deps: UpdaterDeps; flushForExit: ReturnType<typeof vi.fn> } {
  const flushForExit = vi.fn().mockResolvedValue(true);
  return { deps: { flushForExit }, flushForExit };
}

beforeEach(() => {
  // Every dialog call in the real flow is followed by `.catch(() => {})`;
  // give both mocks a resolvable default so a test only needs to override
  // `confirmDialog`'s return value when the flow's branch actually depends
  // on it.
  messageDialog.mockResolvedValue(undefined);
  confirmDialog.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  confirmDialog.mockReset();
  messageDialog.mockReset();
});

describe("checkForUpdatesAndPrompt — no update available", () => {
  it("silent: true shows no dialog", async () => {
    invoke.mockResolvedValueOnce(null); // plugin:updater|check
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: true });
    expect(invoke).toHaveBeenCalledWith("plugin:updater|check", {});
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("silent: false tells the user they're up to date", async () => {
    invoke.mockResolvedValueOnce(null);
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledTimes(1);
  });
});

describe("checkForUpdatesAndPrompt — check() fails", () => {
  it("silent: true logs but shows no dialog", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("offline"));
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: true });
    expect(consoleError).toHaveBeenCalled();
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("silent: false shows a check-failed dialog", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("offline"));
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledTimes(1);
  });
});

const bytesRid = 42;

/** Default invoke stub for the "update available" describe block: `check`
 *  resolves the update, `download` resolves a bytes resource id, `install`
 *  and `restart` resolve to nothing — matching the real plugin commands'
 *  return shapes (verified against tauri-apps/plugins-workspace v2
 *  plugins/updater/src/commands.rs: `download` returns `ResourceId`,
 *  `install` returns `()`). Tests override specific commands with
 *  `mockImplementationOnce`/rejects as needed. */
function stubInvokeHappyPath(calledCommands: string[]): void {
  invoke.mockImplementation(async (cmd: string) => {
    calledCommands.push(cmd);
    if (cmd === "plugin:updater|check") return update;
    if (cmd === "plugin:updater|download") return bytesRid;
    return undefined;
  });
}

describe("checkForUpdatesAndPrompt — update available", () => {
  it("declining (Later) never downloads, flushes, installs, or relaunches", async () => {
    invoke.mockResolvedValueOnce(update); // plugin:updater|check
    confirmDialog.mockResolvedValueOnce(false);
    const { deps, flushForExit } = makeDeps();

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1); // only the initial check
    expect(flushForExit).not.toHaveBeenCalled();
  });

  it("accepting downloads, flushes unsaved work, installs, then relaunches — in that order", async () => {
    confirmDialog.mockResolvedValueOnce(true);
    const { deps, flushForExit } = makeDeps();

    const order: string[] = [];
    flushForExit.mockImplementation(async () => {
      order.push("flush");
      return true;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:updater|check") return update;
      if (cmd === "plugin:updater|download") {
        order.push("download");
        return bytesRid;
      }
      if (cmd === "plugin:updater|install") {
        order.push("install");
        return undefined;
      }
      if (cmd === "plugin:process|restart") {
        order.push("relaunch");
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(invoke).toHaveBeenCalledWith(
      "plugin:updater|download",
      expect.objectContaining({ rid: update.rid, onEvent: expect.any(FakeChannel) }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "plugin:updater|install",
      expect.objectContaining({
        updateRid: update.rid,
        bytesRid,
        restartAfterInstall: false,
      }),
    );
    // flush happens strictly between download and install — see
    // UpdaterDeps.flushForExit's doc comment for why (install never
    // returns on Windows).
    expect(order).toEqual(["download", "flush", "install", "relaunch"]);
  });

  it("a failed download shows an error dialog and never flushes, installs, or relaunches", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true);
    const { deps, flushForExit } = makeDeps();
    const calledCommands: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calledCommands.push(cmd);
      if (cmd === "plugin:updater|check") return update;
      if (cmd === "plugin:updater|download") throw new Error("network error");
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(consoleError).toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(flushForExit).not.toHaveBeenCalled();
    expect(calledCommands).toEqual(["plugin:updater|check", "plugin:updater|download"]);
  });

  it("when the hot-exit flush fails, defaults to NOT installing (Cancel) — nothing on disk changes, and the user is asked again next check", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true); // "Download and Restart"
    confirmDialog.mockResolvedValueOnce(false); // flush-failed dialog, default Cancel
    const { deps, flushForExit } = makeDeps();
    flushForExit.mockResolvedValueOnce(false);
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands).toEqual(["plugin:updater|check", "plugin:updater|download"]);
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(confirmDialog).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ title: "Backup Failed" }),
    );
  });

  it("a rejected flush is treated the same as a resolved-false one (also defaults to Cancel)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true);
    confirmDialog.mockResolvedValueOnce(false);
    const { deps, flushForExit } = makeDeps();
    flushForExit.mockRejectedValueOnce(new Error("disk full"));
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands).not.toContain("plugin:updater|install");
    expect(calledCommands).not.toContain("plugin:process|restart");
  });

  it("when the hot-exit flush fails, still installs and relaunches if the user explicitly opts in (Install Anyway)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true); // "Download and Restart"
    confirmDialog.mockResolvedValueOnce(true); // flush-failed dialog: Install Anyway
    const { deps, flushForExit } = makeDeps();
    flushForExit.mockResolvedValueOnce(false);
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands).toEqual([
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "plugin:process|restart",
    ]);
  });

  it("a failed install shows an error dialog and never relaunches", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true);
    const { deps } = makeDeps();
    const calledCommands: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calledCommands.push(cmd);
      if (cmd === "plugin:updater|check") return update;
      if (cmd === "plugin:updater|download") return bytesRid;
      if (cmd === "plugin:updater|install") throw new Error("installer failed");
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(consoleError).toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(calledCommands).not.toContain("plugin:process|restart");
  });

  it("on the macOS/Linux path where install actually returns, relaunch is called after it", async () => {
    confirmDialog.mockResolvedValueOnce(true);
    const { deps } = makeDeps();
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands.indexOf("plugin:updater|install")).toBeLessThan(
      calledCommands.indexOf("plugin:process|restart"),
    );
  });
});
