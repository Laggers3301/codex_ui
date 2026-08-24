import type { CodexBridge } from "./codexBridge.js";
import { CodexBridgeRegistry } from "./codexBridgeRegistry.js";
import type { ProjectStore } from "./db.js";

/**
 * Resolves an authenticated user to exactly one Codex execution service.
 *
 * The shared bridge remains the compatibility path for users that were never
 * assigned a dedicated service. Once a user has an explicit SSH target, the
 * persistent marker makes a missing target fail closed after a reload rather
 * than silently charging the shared service.
 */
export class CodexServiceRouter {
  constructor(
    private readonly sharedBridge: CodexBridge,
    private readonly dedicatedBridges: CodexBridgeRegistry,
    private readonly store: ProjectStore
  ) {
  }

  bridgeForUser(userId: string): CodexBridge {
    if (this.dedicatedBridges.hasTargetForUser(userId)) {
      // In this multi-user gateway a process-local bridge inherits one shared
      // authentication environment. Only an explicit SSH service can prove a
      // different user/account execution boundary.
      if (this.dedicatedBridges.getTargetKindForUser(userId) !== "ssh") {
        throw new Error("A dedicated Codex service must use an explicit SSH target.");
      }
      if (this.store.getCodexExecutionMode(userId) !== "dedicated") {
        this.store.setCodexExecutionMode(userId, "dedicated");
      }
      return this.dedicatedBridges.getBridgeForUser(userId);
    }

    if (this.store.getCodexExecutionMode(userId) === "dedicated") {
      throw new Error("The dedicated Codex service for this user is unavailable; the request was not sent to the shared service.");
    }
    return this.sharedBridge;
  }

  workingDirectoryForUser(userId: string, sharedProjectPath: string): string {
    // Resolve the bridge first so a user whose dedicated mapping disappeared
    // cannot receive a central filesystem path through a fallback route.
    this.bridgeForUser(userId);
    return this.dedicatedBridges.getWorkingDirectoryForUser(userId, sharedProjectPath);
  }

  stop(): void {
    this.sharedBridge.stop();
    this.dedicatedBridges.stopAll();
  }
}
