import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionCookie } from "./auth.js";
import { importPetFileForUser, publishSharedPets, registerPetRoutes } from "./pets.js";

function image(format: "PNG" | "WEBP", height = 2288, blankFirstCell = false, extraCell?: [number, number]): Buffer {
  const source = `import io,sys\nfrom PIL import Image,ImageDraw\nw,h=1536,int(sys.argv[1]); blank=sys.argv[3]=='1'\ncounts=[6,8,8,4,5,8,6,6,6]+([8,8] if h==2288 else [])\nim=Image.new('RGBA',(w,h),(0,0,0,0)); d=ImageDraw.Draw(im)\nfor row,count in enumerate(counts):\n for col in range(count):\n  if not (blank and col==0 and row==0): d.rectangle((col*192+80,row*208+80,col*192+110,row*208+110),fill=(255,20,40,255))\n${extraCell ? `d.rectangle((${extraCell[1]}*192+80,${extraCell[0]}*208+80,${extraCell[1]}*192+110,${extraCell[0]}*208+110),fill=(255,20,40,255))\n` : ""}b=io.BytesIO(); im.save(b,format=sys.argv[2],lossless=True); sys.stdout.buffer.write(b.getvalue())`;
  const result = spawnSync("python3", ["-c", source, String(height), format, blankFirstCell ? "1" : "0"], { maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
function laughImage(blankColumn?: number): Buffer {
  const source = `import io,sys\nfrom PIL import Image,ImageDraw\nblank=int(sys.argv[1]); im=Image.new('RGBA',(1536,208),(0,0,0,0)); d=ImageDraw.Draw(im)\nfor col in range(8):\n if col!=blank: d.ellipse((col*192+55,35,col*192+137,175),fill=(255,20,40,255))\nb=io.BytesIO(); im.save(b,format='PNG'); sys.stdout.buffer.write(b.getvalue())`;
  const result = spawnSync("python3", ["-c", source, String(blankColumn ?? -1)], { maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

describe("pet storage", () => {
  it("shares an ordered catalog without sharing custom uploads or user preferences", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pets-shared-")); process.env.CODEX_WEB_PETS_DIR = tmp;
    const app = Fastify(); registerPetRoutes(app);
    const alice = createSessionCookie("shared-alice").split(";")[0], bob = createSessionCookie("shared-bob").split(";")[0];
    try {
      const input = path.join(tmp, "atlas.png"), laugh = path.join(tmp, "laugh.png");
      fs.writeFileSync(input, image("PNG")); fs.writeFileSync(laugh, laughImage());
      const milk = await importPetFileForUser("shared-alice", input, { name: "Old name", laughPath: laugh });
      const codex = await importPetFileForUser("shared-alice", input, { name: "Codex" });
      const secret = await importPetFileForUser("shared-alice", input, { name: "Private custom" });
      const bobPet = await importPetFileForUser("shared-bob", input, { name: "Bob custom" });
      await publishSharedPets("shared-alice", [{ id: milk.id, name: "MilkLoong" }, { id: codex.id }]);
      const list = (cookie: string) => app.inject({ method: "GET", url: "/api/pets", headers: { cookie } });
      expect((await list(alice)).json().pets.map((pet: any) => pet.name)).toEqual(["MilkLoong", "Codex", "Private custom"]);
      expect((await list(bob)).json().pets.map((pet: any) => pet.id)).toEqual([milk.id, codex.id, bobPet.id]);
      expect((await list(bob)).json()).toMatchObject({ visible: false, activePetId: null });
      expect((await app.inject({ method: "PATCH", url: "/api/pets/prefs", headers: { cookie: bob }, payload: { activePetId: milk.id, visible: true } })).statusCode).toBe(200);
      expect((await list(alice)).json()).toMatchObject({ visible: false, activePetId: null });
      for (const url of [milk.spritesheetUrl, milk.laughSpritesheetUrl!, milk.thumbnailUrl!]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie: bob } });
        expect(response.statusCode).toBe(200);
        const cached = await app.inject({ method: "GET", url, headers: { cookie: bob, "if-none-match": response.headers.etag } });
        expect(cached.statusCode).toBe(304); expect(cached.rawPayload.length).toBe(0);
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      }
      const own = await app.inject({ method: "GET", url: secret.thumbnailUrl!, headers: { cookie: alice } });
      expect(own.statusCode).toBe(200); expect(own.rawPayload.length).toBeLessThan(fs.statSync(input).size);
      expect((await app.inject({ method: "GET", url: secret.thumbnailUrl!, headers: { cookie: bob, "if-none-match": own.headers.etag } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: secret.spritesheetUrl, headers: { cookie: bob } })).statusCode).toBe(404);
    } finally { await app.close(); delete process.env.CODEX_WEB_PETS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("keeps collections private and preferences per authenticated session", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pets-")); process.env.CODEX_WEB_PETS_DIR = tmp;
    const app = Fastify(); registerPetRoutes(app);
    const alice = createSessionCookie("alice").split(";")[0], bob = createSessionCookie("bob").split(";")[0];
    try {
      const bytes = image("PNG");
      const input = path.join(tmp, "input.png"); fs.writeFileSync(input, bytes);
      const owned = await importPetFileForUser("alice", input, { name: "测试宠物" });
      expect(owned.version).toBe(2);
      const list = await app.inject({ method: "GET", url: "/api/pets", headers: { cookie: alice } });
      expect(list.statusCode).toBe(200); expect(list.json()).toMatchObject({ visible: false, activePetId: null, pets: [{ id: owned.id, version: 2 }] });
      expect((await app.inject({ method: "GET", url: "/api/pets", headers: { cookie: bob } })).json().pets).toEqual([]);
      expect((await app.inject({ method: "GET", url: `/api/pets/${owned.id}/spritesheet`, headers: { cookie: bob } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/pets/${owned.id}/spritesheet`, headers: { cookie: alice } })).body).toBe(bytes.toString());
      expect((await app.inject({ method: "PATCH", url: "/api/pets/preferences", headers: { cookie: bob }, payload: { activePetId: owned.id } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: "/api/pets/preferences", headers: { cookie: alice }, payload: { activePetId: owned.id, visible: true, position: { x: 0.5, y: 0.75 } } })).json()).toMatchObject({ activePetId: owned.id, visible: true, position: { x: 0.5, y: 0.75 } });
      expect((await app.inject({ method: "PATCH", url: "/api/pets/preferences", headers: { cookie: alice }, payload: { position: { x: 2, y: 0 } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/api/pets/prefs", headers: { cookie: alice }, payload: { activePetId: null } })).json()).toMatchObject({ activePetId: null, visible: false });
      expect((await app.inject({ method: "GET", url: "/api/pets" })).statusCode).toBe(401);
    } finally { await app.close(); delete process.env.CODEX_WEB_PETS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("recognizes only supported v1/v2 PNG/WebP sheet dimensions", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pets-format-")); process.env.CODEX_WEB_PETS_DIR = tmp;
    try {
      for (const [filename, bytes, version] of [["v1.png", image("PNG", 1872), 1], ["v2.webp", image("WEBP", 2288), 2]] as const) {
        const file = path.join(tmp, filename); fs.writeFileSync(file, bytes);
        expect((await importPetFileForUser(`user-${version}`, file)).version).toBe(version);
      }
      const bad = path.join(tmp, "bad.png"); fs.writeFileSync(bad, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(16)]));
      await expect(importPetFileForUser("bad", bad)).rejects.toThrow(/Invalid spritesheet/);
      const blank = path.join(tmp, "blank.png"); fs.writeFileSync(blank, image("PNG", 1872, true));
      await expect(importPetFileForUser("blank", blank)).rejects.toThrow(/required animation\/look cell is empty/);
    } finally { delete process.env.CODEX_WEB_PETS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("preserves a bundled v2 reserved pose while rejecting other occupied unused cells", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pets-bundled-")); process.env.CODEX_WEB_PETS_DIR = tmp;
    const app = Fastify(); registerPetRoutes(app);
    const cookie = createSessionCookie("bundled-user").split(";")[0];
    try {
      const bytes = image("WEBP", 2288, false, [0, 6]);
      const input = path.join(tmp, "bundled.webp"); fs.writeFileSync(input, bytes);
      const pet = await importPetFileForUser("bundled-user", input, { name: "Original bundled pet" });
      expect(pet.version).toBe(2);
      const response = await app.inject({ method: "GET", url: pet.spritesheetUrl, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      for (const [height, row, col] of [[1872, 0, 6], [2288, 0, 7], [2288, 3, 4]] as const) {
        const invalid = path.join(tmp, `invalid-${height}-${row}-${col}.webp`);
        fs.writeFileSync(invalid, image("WEBP", height, false, [row, col]));
        await expect(importPetFileForUser("invalid-user", invalid)).rejects.toThrow(/Unused cells must remain fully transparent/);
      }
    } finally { await app.close(); delete process.env.CODEX_WEB_PETS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("validates and privately serves an optional eight-frame laugh strip", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pets-laugh-")); process.env.CODEX_WEB_PETS_DIR = tmp;
    const app = Fastify(); registerPetRoutes(app);
    const alice = createSessionCookie("laugh-alice").split(";")[0], bob = createSessionCookie("laugh-bob").split(";")[0];
    try {
      const mainFile = path.join(tmp, "main.png"), laughFile = path.join(tmp, "laugh.png"), badFile = path.join(tmp, "bad-laugh.png");
      const mainBytes = image("PNG", 2288), laughBytes = laughImage();
      fs.writeFileSync(mainFile, mainBytes); fs.writeFileSync(laughFile, laughBytes); fs.writeFileSync(badFile, laughImage(4));
      const pet = await importPetFileForUser("laugh-alice", mainFile, { name: "Laughing Nailong", laughPath: laughFile });
      expect(pet.laughSpritesheetUrl).toBe(`/api/pets/${pet.id}/laugh`);
      const listed = await app.inject({ method: "GET", url: "/api/pets", headers: { cookie: alice } });
      expect(listed.json().pets[0].laughSpritesheetUrl).toBe(pet.laughSpritesheetUrl);
      expect(listed.json()).toMatchObject({ activePetId: null, visible: false });
      const read = await app.inject({ method: "GET", url: pet.laughSpritesheetUrl!, headers: { cookie: alice } });
      expect(read.statusCode).toBe(200); expect(read.headers["content-type"]).toContain("image/png"); expect(read.body).toBe(laughBytes.toString());
      expect((await app.inject({ method: "GET", url: pet.laughSpritesheetUrl!, headers: { cookie: bob } })).statusCode).toBe(404);
      await expect(importPetFileForUser("bad-laugh-user", mainFile, { laughPath: badFile })).rejects.toThrow(/Every laugh frame/);
      expect((await app.inject({ method: "GET", url: "/api/pets", headers: { cookie: createSessionCookie("bad-laugh-user").split(";")[0] } })).json().pets).toEqual([]);
    } finally { await app.close(); delete process.env.CODEX_WEB_PETS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("refuses PATCH and import when a user's catalog is corrupt without overwriting it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pets-corrupt-")); process.env.CODEX_WEB_PETS_DIR = tmp;
    const user = "corrupt-user", userDir = path.join(tmp, createHash("sha256").update(user).digest("hex"));
    fs.mkdirSync(userDir, { recursive: true });
    const index = path.join(userDir, "index.json"), corrupt = Buffer.from("{ broken catalog\n", "utf8"); fs.writeFileSync(index, corrupt);
    const input = path.join(tmp, "valid.png"); fs.writeFileSync(input, image("PNG", 2288));
    const app = Fastify(); registerPetRoutes(app); const cookie = createSessionCookie(user).split(";")[0];
    try {
      const patch = await app.inject({ method: "PATCH", url: "/api/pets/preferences", headers: { cookie }, payload: { visible: true } });
      expect(patch.statusCode).toBe(503);
      await expect(importPetFileForUser(user, input)).rejects.toMatchObject({ statusCode: 503 });
      expect(fs.readFileSync(index)).toEqual(corrupt);
      expect(fs.readdirSync(userDir)).toEqual(["index.json"]);
    } finally { await app.close(); delete process.env.CODEX_WEB_PETS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
