import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverConfig } from "./config.js";

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export function resolveProjectPath(
  inputPath: string,
  allowedRoot = serverConfig.projectRoot,
  options: { allowOutsideRoot?: boolean } = {}
): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new PathPolicyError("Project path is required.");
  }

  const resolved = path.resolve(inputPath);
  if (options.allowOutsideRoot) {
    return resolved;
  }

  const root = path.resolve(allowedRoot);
  const relative = path.relative(root, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new PathPolicyError(`Project path must stay under ${root}.`);
}

export function ensureProjectDirectory(
  inputPath: string,
  options: { create?: boolean; allowedRoot?: string; allowOutsideRoot?: boolean } = {}
): string {
  const rootPath = resolveProjectPath(inputPath, options.allowedRoot, { allowOutsideRoot: options.allowOutsideRoot });

  if (!fs.existsSync(rootPath)) {
    if (!options.create) {
      throw new PathPolicyError("Project directory does not exist.");
    }
    fs.mkdirSync(rootPath, { recursive: true });
  }

  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) {
    throw new PathPolicyError("Project path must be a directory.");
  }

  return rootPath;
}

export interface ProjectFilePath {
  filePath: string;
  relativePath: string;
  line: number | null;
}

function isInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeLocalFileInput(inputPath: string): { target: string; line: number | null } {
  let target = inputPath.trim();
  let line: number | null = null;

  const hashLine = target.match(/#L(\d+)(?:-L?\d+)?$/i);
  if (hashLine) {
    line = Number(hashLine[1]);
    target = target.slice(0, -hashLine[0].length);
  }

  if (/^file:\/\//i.test(target)) {
    target = fileURLToPath(target);
  } else if (/^https?:\/\//i.test(target)) {
    const parsed = new URL(target);
    target = safeDecodeURIComponent(parsed.pathname);
  } else {
    target = safeDecodeURIComponent(target);
  }

  const colonLine = target.match(/:(\d+)$/);
  if (colonLine && !fs.existsSync(target)) {
    line ??= Number(colonLine[1]);
    target = target.slice(0, -colonLine[0].length);
  }

  return { target, line };
}

export function resolveProjectFilePath(
  projectRoot: string,
  inputPath: string,
  options: { mustExist?: boolean; allowedRoot?: string; allowOutsideRoot?: boolean } = {}
): ProjectFilePath {
  const mustExist = options.mustExist ?? true;
  const rootPath = fs.realpathSync(
    ensureProjectDirectory(projectRoot, { allowedRoot: options.allowedRoot, allowOutsideRoot: options.allowOutsideRoot })
  );
  const { target, line } = decodeLocalFileInput(inputPath);
  if (!target) {
    throw new PathPolicyError("File path is required.");
  }

  const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootPath, target);
  if (mustExist && !fs.existsSync(candidate)) {
    throw new PathPolicyError("File does not exist.");
  }

  const filePath = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  const insideRoot = isInsideRoot(filePath, rootPath);
  if (!insideRoot) {
    throw new PathPolicyError("File path must stay inside the selected project.");
  }

  return {
    filePath,
    relativePath: path.relative(rootPath, filePath),
    line
  };
}
