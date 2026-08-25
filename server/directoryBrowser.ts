import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "./config.js";
import { ensureProjectDirectory, PathPolicyError, resolveProjectPath } from "./pathPolicy.js";

export interface DirectoryEntry {
  name: string;
  path: string;
  relativePath: string;
}

export interface DirectoryListResponse {
  rootPath: string;
  currentPath: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

function isInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveBrowsePath(
  inputPath: string | undefined,
  startPath: string,
  allowedRoot: string,
  allowOutsideRoot: boolean
): string {
  const requested = inputPath?.trim();
  const candidate = requested ? (path.isAbsolute(requested) ? requested : path.join(startPath, requested)) : startPath;
  return resolveProjectPath(candidate, allowedRoot, { allowOutsideRoot });
}

export function listBrowsableDirectories(
  inputPath: string | undefined,
  rootPath = serverConfig.projectRoot,
  options: { allowOutsideRoot?: boolean } = {}
): DirectoryListResponse {
  const allowOutsideRoot = options.allowOutsideRoot ?? serverConfig.allowOutsideProjectRoot;
  const configuredRoot = fs.realpathSync(ensureProjectDirectory(rootPath, { allowedRoot: rootPath, allowOutsideRoot: true }));
  const browseRoot = allowOutsideRoot ? path.parse(configuredRoot).root : configuredRoot;
  const root = fs.realpathSync(ensureProjectDirectory(browseRoot, { allowedRoot: browseRoot, allowOutsideRoot: true }));
  const requested = resolveBrowsePath(inputPath, configuredRoot, root, allowOutsideRoot);
  const currentPath = fs.realpathSync(ensureProjectDirectory(requested, { allowedRoot: root, allowOutsideRoot }));

  if (!isInsideRoot(currentPath, root)) {
    throw new PathPolicyError(`Directory path must stay under ${root}.`);
  }

  const directories = fs
    .readdirSync(currentPath, { withFileTypes: true })
    .flatMap((entry): DirectoryEntry[] => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        return [];
      }

      try {
        const entryPath = fs.realpathSync(path.join(currentPath, entry.name));
        if (!isInsideRoot(entryPath, root) || !fs.statSync(entryPath).isDirectory()) {
          return [];
        }
        return [
          {
            name: entry.name,
            path: entryPath,
            relativePath: path.relative(root, entryPath)
          }
        ];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const parent = path.dirname(currentPath);
  return {
    rootPath: root,
    currentPath,
    parentPath: currentPath === root || !isInsideRoot(parent, root) ? null : parent,
    directories
  };
}
