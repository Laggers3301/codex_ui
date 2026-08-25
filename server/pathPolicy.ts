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

function normalizeLegacyUploadRoot(root: string): string | null {
  if (!root || !path.isAbsolute(root)) {
    return null;
  }
  if (!fs.existsSync(root)) {
    return null;
  }
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function isAllowedLegacyUploadPath(filePath: string, legacyRoots: string[] = []): boolean {
  const normalized = path.resolve(filePath);
  const normalizedRoots = legacyRoots
    .map(normalizeLegacyUploadRoot)
    .filter((value): value is string => Boolean(value));

  return normalizedRoots.some((root) => {
    const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return normalized === root || normalized.startsWith(withSep);
  });
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

function normalizeLegacyUploadRoots(legacyRoots: string[] = []): string[] {
  const normalized = legacyRoots
    .map(normalizeLegacyUploadRoot)
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(normalized));
}

function legacyPathCandidatesFromMissingPath(missingAbsolutePath: string, legacyRoots: string[]): string[] {
  const candidates = new Set<string>();
  const absoluteTarget = path.resolve(missingAbsolutePath);
  for (const root of legacyRoots) {
    const relative = path.relative(root, absoluteTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length <= 1) {
      candidates.add(absoluteTarget);
      continue;
    }

    for (let start = 1; start < parts.length; start += 1) {
      const candidate = path.join(root, ...parts.slice(start));
      candidates.add(candidate);
    }
  }
  return Array.from(candidates);
}

function collectNamedFileCandidates(root: string, fileName: string, maxDepth = 6): string[] {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();
  const results: string[] = [];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    const normalizedDir = path.resolve(dir);
    if (visited.has(normalizedDir) || depth > maxDepth) {
      continue;
    }
    visited.add(normalizedDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(normalizedDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const child = path.join(normalizedDir, entry.name);
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ dir: child, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        results.push(child);
      }
    }
  }

  return results;
}

const legacyFileResolveCache = new Map<string, string | null>();
function cacheKeyForLegacyFile(
  missingAbsolutePath: string,
  legacyRoots: string[]
): string {
  const normalizedMissing = path.resolve(missingAbsolutePath);
  return `${normalizedMissing}::${legacyRoots.join("|")}`;
}

function resolveByLegacyUploadRoots(
  missingAbsolutePath: string,
  legacyRoots: string[] = []
): string | null {
  const normalizedLegacyRoots = normalizeLegacyUploadRoots(legacyRoots);
  if (!normalizedLegacyRoots.length) {
    return null;
  }

  const cacheKey = cacheKeyForLegacyFile(missingAbsolutePath, normalizedLegacyRoots);
  const cached = legacyFileResolveCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const basename = path.basename(missingAbsolutePath);
  const migratedCandidates = legacyPathCandidatesFromMissingPath(missingAbsolutePath, normalizedLegacyRoots).map((candidate) => path.resolve(candidate));
  for (const candidate of migratedCandidates) {
    if (fs.existsSync(candidate)) {
      legacyFileResolveCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  for (const root of normalizedLegacyRoots) {
    const candidate = path.join(root, basename);
    if (fs.existsSync(candidate)) {
      legacyFileResolveCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  const candidateSets = normalizedLegacyRoots.flatMap((root) =>
    collectNamedFileCandidates(root, basename).map((candidate) => ({
      candidate,
      stat: fs.statSync(candidate)
    }))
  );

  const best = candidateSets
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
  const resolved = best?.candidate ?? null;
  legacyFileResolveCache.set(cacheKey, resolved);
  return resolved;
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
  options: { mustExist?: boolean; allowedRoot?: string; allowOutsideRoot?: boolean; allowLegacyUploadRoots?: string[] } = {}
): ProjectFilePath {
  const mustExist = options.mustExist ?? true;
  const rootPath = fs.realpathSync(
    ensureProjectDirectory(projectRoot, { allowedRoot: options.allowedRoot, allowOutsideRoot: options.allowOutsideRoot })
  );
  const { target, line } = decodeLocalFileInput(inputPath);
  if (!target) {
    throw new PathPolicyError("File path is required.");
  }

  let candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootPath, target);
  if (mustExist && !fs.existsSync(candidate)) {
    const fallback = resolveByLegacyUploadRoots(candidate, options.allowLegacyUploadRoots);
    if (!fallback) {
      throw new PathPolicyError("File does not exist.");
    }
    candidate = fallback;
  }

  const filePath = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  const insideRoot = isInsideRoot(filePath, rootPath);
  const isLegacyUploadPath = isAllowedLegacyUploadPath(filePath, options.allowLegacyUploadRoots);
  if (!insideRoot && !options.allowOutsideRoot && !isLegacyUploadPath) {
    throw new PathPolicyError("File path must stay inside the selected project.");
  }

  return {
    filePath,
    relativePath: insideRoot ? path.relative(rootPath, filePath) : filePath,
    line
  };
}
