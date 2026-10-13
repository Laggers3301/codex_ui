import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticatedUserFromHeaders } from "./auth.js";
import { serverConfig } from "./config.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_UPLOADS_GLOBAL = 8, MAX_UPLOADS_PER_USER = 2;
const MAX_PETS_PER_USER = Number(process.env.CODEX_WEB_PETS_MAX_COUNT) || 32;
const MAX_TOTAL_BYTES_PER_USER = Number(process.env.CODEX_WEB_PETS_MAX_BYTES) || 128 * 1024 * 1024;
const uploadsByUser = new Map<string, number>(); let activeUploads = 0;
const COLUMNS = 8, CELL_WIDTH = 192, CELL_HEIGHT = 208;
type Pet = { id: string; name: string; version: 1 | 2; format: "png" | "webp"; createdAt: string; size: number; spritesheetUrl: string; thumbnailUrl?: string; laughSpritesheetUrl?: string };
type Preferences = { activePetId: string | null; visible: boolean; position: { x: number; y: number } };
type UserData = { pets: Pet[]; preferences: Preferences };
const defaults = (): UserData => ({ pets: [], preferences: { activePetId: null, visible: false, position: { x: 0.82, y: 0.78 } } });

export class PetError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
function root(): string { return path.resolve(process.env.CODEX_WEB_PETS_DIR ?? path.join(serverConfig.dataDir, "pets")); }
function safeUser(userId: string): string { return createHash("sha256").update(userId).digest("hex"); }
function userRoot(userId: string): string { return path.join(root(), safeUser(userId)); }
function sharedRoot(): string { return path.join(root(), "shared"); }
function validPet(pet: Pet): boolean {
  return Boolean(pet && typeof pet === "object" && typeof pet.id === "string" && /^[0-9a-f-]{36}$/.test(pet.id)
    && typeof pet.name === "string" && (pet.version === 1 || pet.version === 2)
    && (pet.format === "png" || pet.format === "webp") && typeof pet.createdAt === "string"
    && Number.isFinite(pet.size) && pet.size >= 0 && typeof pet.spritesheetUrl === "string"
    && (pet.thumbnailUrl === undefined || typeof pet.thumbnailUrl === "string")
    && (pet.laughSpritesheetUrl === undefined || typeof pet.laughSpritesheetUrl === "string"));
}
function loadShared(): Pet[] {
  let raw: string;
  try { raw = fs.readFileSync(path.join(sharedRoot(), "index.json"), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw new PetError(503, "Shared pet catalog is unavailable."); }
  try {
    const parsed = JSON.parse(raw) as { pets?: Pet[] };
    if (!Array.isArray(parsed.pets) || !parsed.pets.every(validPet)) throw new Error("Invalid catalog");
    return parsed.pets;
  } catch { throw new PetError(503, "Shared pet catalog is corrupt; no changes were saved."); }
}
function availablePets(data: UserData, shared = loadShared()): Pet[] {
  const sharedIds = new Set(shared.map(pet => pet.id));
  return [...shared, ...data.pets.filter(pet => !sharedIds.has(pet.id))];
}
function petSource(userId: string, data: UserData, id: string): { pet: Pet; directory: string } | undefined {
  const shared = loadShared().find(pet => pet.id === id);
  if (shared) return { pet: shared, directory: sharedRoot() };
  const pet = owned(data, id);
  return pet ? { pet, directory: userRoot(userId) } : undefined;
}
function load(userId: string): UserData {
  const file = path.join(userRoot(userId), "index.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
    throw new PetError(503, "Pet catalog is unavailable; no changes were saved.");
  }
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch { throw new PetError(503, "Pet catalog is corrupt; no changes were saved."); }
  const candidate = data as Partial<UserData> | null;
  const preferences = candidate?.preferences as Preferences | undefined;
  const validPreferences = Boolean(preferences && typeof preferences === "object"
    && (preferences.activePetId === null || typeof preferences.activePetId === "string")
    && typeof preferences.visible === "boolean"
    && preferences.position && Number.isFinite(preferences.position.x) && preferences.position.x >= 0 && preferences.position.x <= 1
    && Number.isFinite(preferences.position.y) && preferences.position.y >= 0 && preferences.position.y <= 1);
  const validPets = Array.isArray(candidate?.pets) && candidate.pets.every(validPet);
  if (!validPreferences || !validPets) throw new PetError(503, "Pet catalog has an invalid structure; no changes were saved.");
  return candidate as UserData;
}
function save(userId: string, data: UserData): void {
  const dir = userRoot(userId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.index-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(temp, path.join(dir, "index.json"));
}
const imageValidator = String.raw`
import base64, io, json, sys, warnings
from PIL import Image
Image.MAX_IMAGE_PIXELS = 1536 * 2288
warnings.simplefilter("error", Image.DecompressionBombWarning)
raw = sys.stdin.buffer.read()
try:
    with Image.open(io.BytesIO(raw)) as probe:
        fmt = (probe.format or "").upper()
        if fmt not in ("PNG", "WEBP") or getattr(probe, "n_frames", 1) != 1:
            raise ValueError("Only single-frame PNG/WebP images are accepted")
        w, h = probe.size
        if w != 1536 or h not in (1872, 2288):
            raise ValueError("Unsupported spritesheet dimensions")
        if "A" not in probe.getbands() and "transparency" not in probe.info:
            raise ValueError("An alpha channel is required")
        probe.verify()
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        rgba = image.convert("RGBA")
        alpha = rgba.getchannel("A")
        lo, hi = alpha.getextrema()
        if lo == 255 or hi == 0:
            raise ValueError("Image must contain visible pixels and transparent background")
        counts = [6, 8, 8, 4, 5, 8, 6, 6, 6] + ([8, 8] if h == 2288 else [])
        for row, visible_cells in enumerate(counts):
            for col in range(8):
                tile = alpha.crop((col * 192, row * 208, (col + 1) * 192, (row + 1) * 208))
                lo, hi = tile.getextrema()
                if col < visible_cells and tile.getbbox() is None:
                    raise ValueError("A required animation/look cell is empty")
                # Desktop bundled v2 sheets use row 0, column 6 for an
                # additional reserved pose, outside the six-frame idle loop.
                # Keep the original bytes; all other unused cells stay empty.
                bundled_reserved_pose = h == 2288 and row == 0 and col == 6
                if col >= visible_cells and hi != 0 and not bundled_reserved_pose:
                    raise ValueError("Unused cells must remain fully transparent")
        # A small first-frame render avoids downloading/decoding the complete
        # 1536x2288 atlas for every 54px picker thumbnail. Preserve original
        # frame pixels and alpha; do not resize or rewrite the source atlas.
        preview = io.BytesIO()
        rgba.crop((0, 0, 192, 208)).save(preview, format="WEBP", lossless=True)
    print(json.dumps({"width": w, "height": h, "format": fmt.lower(), "thumbnail": base64.b64encode(preview.getvalue()).decode("ascii")}))
except Exception as exc:
    print(str(exc) or "Image decode failed", file=sys.stderr)
    sys.exit(2)
`;
const laughValidator = String.raw`
import io, json, sys, warnings
from PIL import Image
Image.MAX_IMAGE_PIXELS = 1536 * 208
warnings.simplefilter("error", Image.DecompressionBombWarning)
raw = sys.stdin.buffer.read()
try:
    with Image.open(io.BytesIO(raw)) as probe:
        if (probe.format or "").upper() != "PNG" or getattr(probe, "n_frames", 1) != 1:
            raise ValueError("Laugh strip must be a single-frame PNG")
        if probe.size != (1536, 208):
            raise ValueError("Laugh strip must be exactly 1536x208")
        if "A" not in probe.getbands() and "transparency" not in probe.info:
            raise ValueError("Laugh strip requires an alpha channel")
        probe.verify()
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        alpha = image.convert("RGBA").getchannel("A")
        lo, hi = alpha.getextrema()
        if lo == 255 or hi == 0:
            raise ValueError("Laugh strip must contain visible pixels and transparent background")
        for col in range(8):
            if alpha.crop((col * 192, 0, (col + 1) * 192, 208)).getbbox() is None:
                raise ValueError("Every laugh frame must contain visible pixels")
    print(json.dumps({"width": 1536, "height": 208, "format": "png"}))
except Exception as exc:
    print(str(exc) or "Image decode failed", file=sys.stderr)
    sys.exit(2)
`;
type DecodedImage = { width: number; height: number; format: "png" | "webp"; thumbnail?: string };
function decodeAndValidate(data: Buffer): Promise<DecodedImage> {
  return runImageValidator(data, imageValidator, 256 * 1024);
}
function decodeLaughAndValidate(data: Buffer): Promise<void> {
  return runImageValidator(data, laughValidator).then(() => undefined);
}
function runImageValidator(data: Buffer, source: string, outputLimit = 4_096): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? "python3", ["-c", source], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let outputBytes = 0, errorBytes = 0, settled = false;
    const finish = (error?: Error, value?: DecodedImage) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value!); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new PetError(422, "Spritesheet decoding exceeded the 8-second limit.")); }, 8_000);
    child.on("error", () => finish(new PetError(503, "The local Pillow image validator is unavailable.")));
    child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= outputLimit) stdout.push(chunk); else { child.kill("SIGKILL"); finish(new PetError(400, "Image validator output limit exceeded.")); } });
    child.stderr.on("data", (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes <= 4_096) stderr.push(chunk); });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish(new PetError(400, `Invalid spritesheet: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 240) || "image decode failed"}`)); return; }
      try { finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch { finish(new PetError(400, "Image validator returned an invalid result.")); }
    });
    child.stdin.on("error", () => {}); child.stdin.end(data);
  });
}
function userFor(request: FastifyRequest): string {
  const user = authenticatedUserFromHeaders(request.headers as any);
  if (!user || user === "auth-disabled") throw new PetError(401, "Pet storage requires an authenticated user session.");
  return user;
}
function error(reply: any, e: unknown) { const err = e instanceof PetError ? e : null; const uploadTooLarge = (e as any)?.code === "FST_REQ_FILE_TOO_LARGE"; return reply.code(err?.statusCode ?? (uploadTooLarge ? 413 : 500)).send({ error: err?.message ?? (uploadTooLarge ? "Spritesheet exceeds the 20 MiB limit." : "Pet operation failed.") }); }
function owned(data: UserData, id: string): Pet | undefined { return data.pets.find((pet) => pet.id === id); }
function thumbnailBytes(image: DecodedImage): Buffer {
  if (!image.thumbnail) throw new PetError(503, "Thumbnail rendering failed.");
  const bytes = Buffer.from(image.thumbnail, "base64");
  if (!bytes.length || bytes.length > 192 * 208 * 4 + 1024) throw new PetError(503, "Thumbnail rendering exceeded its output limit.");
  return bytes;
}
function sendImage(request: FastifyRequest, reply: any, bytes: Buffer, type: string) {
  // Revalidate authorization on every request, but avoid retransmitting an
  // unchanged image. Unlike no-store this also helps reloads; unlike public
  // immutable caching it cannot reuse another user's private image unchecked.
  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  reply.header("Cache-Control", "private, max-age=0, must-revalidate").header("ETag", etag)
    .header("X-Content-Type-Options", "nosniff").type(type);
  const cached = request.headers["if-none-match"];
  if (typeof cached === "string" && cached.split(",").some(value => value.trim() === etag || value.trim() === "*")) return reply.code(304).send();
  return reply.send(bytes);
}

async function addPet(userId: string, filename: string, bytes: Buffer, name = "", declaredVersion?: string, laughBytes?: Buffer): Promise<Pet> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new PetError(bytes.length > MAX_BYTES ? 413 : 400, "Spritesheet must be between 1 byte and 20 MiB.");
  if (laughBytes && (!laughBytes.length || laughBytes.length > MAX_BYTES)) throw new PetError(laughBytes.length > MAX_BYTES ? 413 : 400, "Laugh strip must be between 1 byte and 20 MiB.");
  const size = await decodeAndValidate(bytes);
  if (size.width !== 1536 || ![1872, 2288].includes(size.height) || size.height % CELL_HEIGHT !== 0 || size.width / CELL_WIDTH !== COLUMNS) throw new PetError(400, "Spritesheet dimensions must be v1 1536x1872 or v2 1536x2288 (8 columns, 192x208 cells).");
  const version = size.height === 1872 ? 1 : 2; if (declaredVersion && declaredVersion !== String(version)) throw new PetError(400, "Declared version does not match spritesheet dimensions.");
  const thumbnail = thumbnailBytes(size);
  const ext = path.extname(filename).toLowerCase(); if ((ext === ".png" && size.format !== "png") || (ext === ".webp" && size.format !== "webp") || ![".png", ".webp"].includes(ext)) throw new PetError(400, "Filename extension must match PNG or WebP content.");
  if (laughBytes) await decodeLaughAndValidate(laughBytes);
  const data = load(userId);
  const directory = userRoot(userId);
  const usedBytes = data.pets.reduce((sum, item) => {
    let laughSize = 0, thumbnailSize = 0;
    if (item.laughSpritesheetUrl) {
      try { const stat = fs.lstatSync(path.join(directory, `${item.id}-laugh.png`)); if (stat.isFile()) laughSize = stat.size; } catch { /* missing prior optional asset */ }
    }
    if (item.thumbnailUrl) {
      try { const stat = fs.lstatSync(path.join(directory, `${item.id}-thumbnail.webp`)); if (stat.isFile()) thumbnailSize = stat.size; } catch { /* missing prior derived preview */ }
    }
    return sum + item.size + laughSize + thumbnailSize;
  }, 0);
  if (data.pets.length >= MAX_PETS_PER_USER || usedBytes + bytes.length + thumbnail.length + (laughBytes?.length ?? 0) > MAX_TOTAL_BYTES_PER_USER) throw new PetError(413, "Per-user pet storage quota reached.");
  const id = randomUUID(), pet: Pet = { id, name: name.trim().slice(0, 80) || path.basename(filename, ext).slice(0, 80) || "Pet", version, format: size.format, createdAt: new Date().toISOString(), size: bytes.length, spritesheetUrl: `/api/pets/${id}/spritesheet`, thumbnailUrl: `/api/pets/${id}/thumbnail`, ...(laughBytes ? { laughSpritesheetUrl: `/api/pets/${id}/laugh` } : {}) };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, `${id}.${size.format}`), bytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(directory, `${id}-thumbnail.webp`), thumbnail, { flag: "wx", mode: 0o600 });
  if (laughBytes) fs.writeFileSync(path.join(directory, `${id}-laugh.png`), laughBytes, { flag: "wx", mode: 0o600 });
  data.pets.push(pet); save(userId, data);
  return pet;
}

/** Trusted local import helper. Never expose the userId argument to HTTP callers. */
export async function importPetFileForUser(userId: string, filePath: string, options: { name?: string; laughPath?: string } = {}): Promise<Pet> {
  if (!userId || userId === "auth-disabled") throw new PetError(401, "A real authenticated user id is required.");
  const stat = fs.statSync(filePath); if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new PetError(413, "Spritesheet must be a regular file no larger than 20 MiB.");
  let laughBytes: Buffer | undefined;
  if (options.laughPath) {
    const laughStat = fs.statSync(options.laughPath);
    if (!laughStat.isFile() || laughStat.size < 1 || laughStat.size > MAX_BYTES) throw new PetError(413, "Laugh strip must be a regular file no larger than 20 MiB.");
    if (path.extname(options.laughPath).toLowerCase() !== ".png") throw new PetError(400, "Laugh strip must use the PNG format.");
    laughBytes = fs.readFileSync(options.laughPath);
  }
  return addPet(userId, path.basename(filePath), fs.readFileSync(filePath), options.name ?? "", undefined, laughBytes);
}

/** Administrator-only local publication. There is deliberately no HTTP write route. */
export async function publishSharedPets(userId: string, selection: Array<{ id: string; name?: string }>): Promise<Pet[]> {
  if (!userId || userId === "auth-disabled" || !selection.length || selection.length > 32) throw new PetError(400, "Invalid shared pet selection.");
  const source = load(userId), pets: Pet[] = [], assets: Array<{ filename: string; bytes: Buffer }> = [];
  const ids = new Set<string>();
  for (const item of selection) {
    const original = owned(source, item.id);
    if (!original || ids.has(item.id)) throw new PetError(404, "Source pet not found or duplicated.");
    ids.add(item.id);
    const pet = { ...original, name: item.name?.trim().slice(0, 80) || original.name, thumbnailUrl: `/api/pets/${original.id}/thumbnail` };
    const bytes = fs.readFileSync(path.join(userRoot(userId), `${pet.id}.${pet.format}`));
    if (!bytes.length || bytes.length > MAX_BYTES) throw new PetError(413, "Source pet exceeds upload limits.");
    const decoded = await decodeAndValidate(bytes);
    assets.push({ filename: `${pet.id}.${pet.format}`, bytes });
    assets.push({ filename: `${pet.id}-thumbnail.webp`, bytes: thumbnailBytes(decoded) });
    if (pet.laughSpritesheetUrl) {
      const laugh = fs.readFileSync(path.join(userRoot(userId), `${pet.id}-laugh.png`));
      if (!laugh.length || laugh.length > MAX_BYTES) throw new PetError(413, "Source laugh strip exceeds upload limits.");
      await decodeLaughAndValidate(laugh);
      assets.push({ filename: `${pet.id}-laugh.png`, bytes: laugh });
    }
    pets.push(pet);
  }
  if (assets.reduce((sum, item) => sum + item.bytes.length, 0) > MAX_TOTAL_BYTES_PER_USER) throw new PetError(413, "Shared catalog storage quota reached.");
  // Check the old catalog and all possible collisions before writing anything.
  loadShared();
  const directory = sharedRoot();
  for (const asset of assets) {
    const filename = path.join(directory, asset.filename);
    if (fs.existsSync(filename) && !fs.readFileSync(filename).equals(asset.bytes)) throw new PetError(409, "An existing shared asset has different bytes.");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const asset of assets) {
    const filename = path.join(directory, asset.filename);
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, asset.bytes, { flag: "wx", mode: 0o600 });
  }
  const temp = path.join(directory, `.index-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify({ pets }), { mode: 0o600 });
  fs.renameSync(temp, path.join(directory, "index.json"));
  return pets;
}

export function registerPetRoutes(app: FastifyInstance): void {
  app.get("/api/pets", async (request, reply) => { try { const data = load(userFor(request)); reply.header("Cache-Control", "no-store"); return { ...data.preferences, prefs: data.preferences, pets: availablePets(data) }; } catch (e) { return error(reply, e); } });
  const patchPreferences = async (request: FastifyRequest<{ Body: Partial<Preferences> }>, reply: any) => {
    try {
      const user = userFor(request), data = load(user), patch = request.body ?? {};
      if (patch.activePetId !== undefined && patch.activePetId !== null && (typeof patch.activePetId !== "string" || !petSource(user, data, patch.activePetId))) throw new PetError(404, "Pet not found.");
      if (patch.visible !== undefined && typeof patch.visible !== "boolean") throw new PetError(400, "visible must be a boolean.");
      if (patch.activePetId === null && patch.visible === true) throw new PetError(400, "A hidden/no-pet preference cannot be visible.");
      if (patch.visible === true && !(patch.activePetId ?? data.preferences.activePetId)) throw new PetError(400, "Select a pet before making it visible.");
      if (patch.position !== undefined && (!patch.position || !Number.isFinite(patch.position.x) || !Number.isFinite(patch.position.y) || patch.position.x < 0 || patch.position.x > 1 || patch.position.y < 0 || patch.position.y > 1)) throw new PetError(400, "position x/y must be between 0 and 1.");
      data.preferences = { ...data.preferences, ...(patch.activePetId !== undefined ? { activePetId: patch.activePetId } : {}), ...(patch.visible !== undefined ? { visible: patch.visible } : {}), ...(patch.position !== undefined ? { position: patch.position } : {}) };
      if (patch.activePetId === null) data.preferences.visible = false;
      save(user, data); return { ...data.preferences };
    } catch (e) { return error(reply, e); }
  };
  app.patch<{ Body: Partial<Preferences> }>("/api/pets/preferences", patchPreferences);
  app.patch<{ Body: Partial<Preferences> }>("/api/pets/prefs", patchPreferences);
  const upload = async (request: FastifyRequest, reply: any) => {
    let uploadUser: string | undefined, acquired = false;
    try {
      const user = userFor(request); uploadUser = user;
      if (activeUploads >= MAX_UPLOADS_GLOBAL || (uploadsByUser.get(user) ?? 0) >= MAX_UPLOADS_PER_USER) throw new PetError(429, "Pet upload concurrency limit reached; try again shortly.");
      activeUploads += 1; uploadsByUser.set(user, (uploadsByUser.get(user) ?? 0) + 1);
      acquired = true;
      if (!request.isMultipart()) throw new PetError(400, "Multipart form data with one `file` is required.");
      const parts = request.parts({ limits: { files: 1, fileSize: MAX_BYTES, fields: 2 } });
      let bytes: Buffer | undefined, filename = "pet", name = "", versionField: string | undefined;
      for await (const part of parts) {
        if (part.type === "file") {
          if (part.fieldname !== "file") throw new PetError(400, "File field must be named `file`.");
          bytes = await part.toBuffer(); filename = part.filename;
        } else if (part.fieldname === "name") name = String(part.value).slice(0, 80);
        else if (part.fieldname === "version") versionField = String(part.value);
      }
      if (!bytes?.length) throw new PetError(400, "A non-empty spritesheet file is required.");
      const pet = await addPet(user, filename, bytes, name, versionField);
      reply.code(201); return { pet };
    } catch (e) { return error(reply, e); }
    finally { if (acquired && uploadUser) { uploadsByUser.set(uploadUser, uploadsByUser.get(uploadUser)! - 1); if (uploadsByUser.get(uploadUser) === 0) uploadsByUser.delete(uploadUser); activeUploads -= 1; } }
  };
  app.post("/api/pets/import", upload);
  app.post("/api/pets", upload);
  app.get<{ Params: { id: string } }>("/api/pets/:id/spritesheet", async (request, reply) => {
    try {
      const user = userFor(request), data = load(user), source = petSource(user, data, request.params.id); if (!source || !/^[0-9a-f-]{36}$/.test(source.pet.id)) throw new PetError(404, "Pet not found.");
      const { pet, directory } = source;
      const file = path.join(directory, `${pet.id}.${pet.format}`), bytes = fs.readFileSync(file);
      return sendImage(request, reply, bytes, pet.format === "png" ? "image/png" : "image/webp");
    } catch (e) { return error(reply, (e as NodeJS.ErrnoException).code === "ENOENT" ? new PetError(404, "Pet not found.") : e); }
  });
  app.get<{ Params: { id: string } }>("/api/pets/:id/thumbnail", async (request, reply) => {
    try {
      const user = userFor(request), source = petSource(user, load(user), request.params.id);
      if (!source?.pet.thumbnailUrl || !/^[0-9a-f-]{36}$/.test(source.pet.id)) throw new PetError(404, "Pet thumbnail not found.");
      const bytes = fs.readFileSync(path.join(source.directory, `${source.pet.id}-thumbnail.webp`));
      return sendImage(request, reply, bytes, "image/webp");
    } catch (e) { return error(reply, (e as NodeJS.ErrnoException).code === "ENOENT" ? new PetError(404, "Pet thumbnail not found.") : e); }
  });
  app.get<{ Params: { id: string } }>("/api/pets/:id/laugh", async (request, reply) => {
    try {
      const user = userFor(request), data = load(user), source = petSource(user, data, request.params.id);
      if (!source?.pet.laughSpritesheetUrl || !/^[0-9a-f-]{36}$/.test(source.pet.id)) throw new PetError(404, "Pet laugh strip not found.");
      const bytes = fs.readFileSync(path.join(source.directory, `${source.pet.id}-laugh.png`));
      return sendImage(request, reply, bytes, "image/png");
    } catch (e) { return error(reply, (e as NodeJS.ErrnoException).code === "ENOENT" ? new PetError(404, "Pet laugh strip not found.") : e); }
  });
}
