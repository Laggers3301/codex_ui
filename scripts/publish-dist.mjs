import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Keep the current entry and its hashed assets usable throughout publication. */
export async function publishDist(staging, destination) {
  if (!(await stat(path.join(staging, "index.html"))).isFile()) throw new Error("Build entry is missing");
  await mkdir(destination, { recursive: true });
  const publishFile = async (source, target) => {
    const temporary = `${target}.deploy-${randomUUID()}`;
    try { await copyFile(source, temporary); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  };
  const copyResources = async (source, target, root = false) => {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (root && entry.name === "index.html") continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) await copyResources(from, to);
      else if (entry.isFile()) await publishFile(from, to);
      else throw new Error(`Unexpected build entry: ${entry.name}`);
    }
  };
  await copyResources(staging, destination, true);
  // Do not delete old hashed chunks: already-open tabs may still request them.
  await publishFile(path.join(staging, "index.html"), path.join(destination, "index.html"));
}
