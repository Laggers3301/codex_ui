import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("personal workspace directory routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("confines listing, folder creation, and project creation to the authenticated user's workspace", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "personal-workspace-"));
    const usersRoot = path.join(temporary, "users");
    vi.stubEnv("CODEX_WEB_USER_WORKSPACE_ROOT", usersRoot);
    vi.stubEnv("CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT", "1");
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(temporary, "private-data"));
    vi.stubEnv("CODEX_WEB_AUTH_MODE", "member");
    vi.resetModules();

    let app: ReturnType<typeof Fastify> | undefined;
    let store: any;
    try {
      const [{ registerRoutes }, { createSessionCookie }, { ProjectStore }] = await Promise.all([
        import("./routes.js"), import("./auth.js"), import("./db.js")
      ]);
      store = new ProjectStore(path.join(temporary, "store.sqlite"));
      app = Fastify();
      registerRoutes(app, { getPendingServerRequests: () => [], request: async () => ({}) } as any, store, { backgroundIndexing: false });

      const aliceCookie = createSessionCookie("alice").split(";")[0];
      const bobCookie = createSessionCookie("bob").split(";")[0];
      const aliceRoot = path.join(usersRoot, "alice");
      const bobRoot = path.join(usersRoot, "bob");
      fs.mkdirSync(bobRoot, { recursive: true });

      const metadata = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: aliceCookie, "x-codex-web-user-id": "bob" } });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json().projectRoot).toBe(aliceRoot);
      expect(metadata.json().allowOutsideProjectRoot).toBe(false);
      expect(metadata.json().systemDirectoryPickerAvailable).toBe(false);
      expect(fs.statSync(aliceRoot).isDirectory()).toBe(true);

      const rootListing = await app.inject({ method: "GET", url: "/api/system/directories?userId=bob", headers: { cookie: aliceCookie, "x-codex-web-user-id": "bob" } });
      expect(rootListing.statusCode).toBe(200);
      expect(rootListing.json().data.rootPath).toBe(aliceRoot);
      expect(rootListing.json().data.parentPath).toBeNull();

      for (const query of [
        `?path=${encodeURIComponent(bobRoot)}`,
        `?path=${encodeURIComponent(path.join(usersRoot, "alice-sibling"))}`,
        `?path=${encodeURIComponent(path.join(aliceRoot, "..", "bob"))}`
      ]) {
        expect((await app.inject({ method: "GET", url: `/api/system/directories${query}`, headers: { cookie: aliceCookie } })).statusCode).toBe(400);
      }

      const createdFolder = await app.inject({
        method: "POST", url: "/api/system/directories", headers: { cookie: aliceCookie, "x-codex-web-user-id": "bob" },
        payload: { parentPath: aliceRoot, name: "notes" }
      });
      expect(createdFolder.statusCode).toBe(201);
      expect(createdFolder.json().data.path).toBe(path.join(aliceRoot, "notes"));
      expect(fs.statSync(createdFolder.json().data.path).isDirectory()).toBe(true);

      const duplicate = await app.inject({ method: "POST", url: "/api/system/directories", headers: { cookie: aliceCookie }, payload: { parentPath: aliceRoot, name: "notes" } });
      expect(duplicate.statusCode).toBe(409);
      for (const name of ["", ".", "..", "../bob", "x/y", "x\\y", "bad\u0001name"]) {
        const response = await app.inject({ method: "POST", url: "/api/system/directories", headers: { cookie: aliceCookie }, payload: { parentPath: aliceRoot, name } });
        expect(response.statusCode, JSON.stringify(name)).toBe(400);
      }
      expect((await app.inject({ method: "POST", url: "/api/system/directories", headers: { cookie: bobCookie }, payload: { parentPath: aliceRoot, name: "bob-write" } })).statusCode).toBe(400);
      expect(fs.existsSync(path.join(bobRoot, "bob-write"))).toBe(false);

      const escapeLink = path.join(aliceRoot, "escape");
      fs.symlinkSync(bobRoot, escapeLink, "dir");
      expect((await app.inject({ method: "GET", url: `/api/system/directories?path=${encodeURIComponent(escapeLink)}`, headers: { cookie: aliceCookie } })).statusCode).toBe(400);
      const linkedProject = await app.inject({
        method: "POST", url: "/api/projects", headers: { cookie: aliceCookie },
        payload: { name: "bad", rootPath: path.join(escapeLink, "created"), createDirectory: true, gitInit: true }
      });
      expect(linkedProject.statusCode).toBe(400);
      expect(fs.existsSync(path.join(bobRoot, "created"))).toBe(false);

      const outsideProjectPath = path.join(temporary, "outside-created");
      const forgedProject = await app.inject({
        method: "POST", url: "/api/projects", headers: { cookie: aliceCookie, "x-codex-web-user-id": "bob" },
        payload: { name: "outside", rootPath: outsideProjectPath, createDirectory: true, gitInit: true }
      });
      expect(forgedProject.statusCode).toBe(400);
      expect(fs.existsSync(outsideProjectPath)).toBe(false);

      const validProjectPath = path.join(aliceRoot, "notes", "project");
      const validProject = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: aliceCookie }, payload: { name: "valid", rootPath: validProjectPath, createDirectory: true } });
      expect(validProject.statusCode).toBe(201);
      expect(validProject.json().data.rootPath).toBe(validProjectPath);
      expect((await app.inject({ method: "POST", url: "/api/system/select-directory", headers: { cookie: aliceCookie } })).statusCode).toBe(501);
    } finally {
      if (app) await app.close();
      store?.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects a personal workspace root redirected through a symlink", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "personal-workspace-link-"));
    const usersRoot = path.join(temporary, "users");
    fs.mkdirSync(usersRoot);
    fs.mkdirSync(path.join(usersRoot, "bob"));
    fs.symlinkSync(path.join(usersRoot, "bob"), path.join(usersRoot, "alice"), "dir");
    vi.stubEnv("CODEX_WEB_USER_WORKSPACE_ROOT", usersRoot);
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(temporary, "private-data"));
    vi.stubEnv("CODEX_WEB_AUTH_MODE", "member");
    vi.resetModules();
    let app: ReturnType<typeof Fastify> | undefined;
    let store: any;
    try {
      const [{ registerRoutes }, { createSessionCookie }, { ProjectStore }] = await Promise.all([
        import("./routes.js"), import("./auth.js"), import("./db.js")
      ]);
      store = new ProjectStore(path.join(temporary, "store.sqlite"));
      app = Fastify();
      registerRoutes(app, { getPendingServerRequests: () => [], request: async () => ({}) } as any, store, { backgroundIndexing: false });
      const response = await app.inject({ method: "GET", url: "/api/system/directories", headers: { cookie: createSessionCookie("alice").split(";")[0] } });
      expect(response.statusCode).toBe(400);
      expect(response.json().data).toBeUndefined();
      expect(fs.readdirSync(path.join(usersRoot, "bob"))).toEqual([]);
    } finally {
      if (app) await app.close();
      store?.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
