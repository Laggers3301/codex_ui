import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionCookie } from "./auth.js";
import { publishUiUpdate, registerUiUpdateRoutes } from "./uiUpdates.js";

describe("generic account update dot", () => {
  it("publishes the same release at questions and Plan without resetting either entry's acknowledgements", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-plan-update-")); process.env.CODEX_WEB_UI_UPDATE_DIR = tmp;
    const app = Fastify(); registerUiUpdateRoutes(app);
    const headers = { cookie: createSessionCookie("mode-alice").split(";")[0] };
    try {
      publishUiUpdate("mode-fix-one", ["questions", "plan", "threads"]);
      for (const target of ["questions", "plan", "threads"]) {
        expect((await app.inject({ url: `/api/ui-updates?target=${target}`, headers })).json().hasUnseen).toBe(true);
        expect((await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers, payload: { version: "mode-fix-one", target } })).statusCode).toBe(200);
      }
      publishUiUpdate("mode-fix-one", ["questions", "plan", "threads"]);
      for (const target of ["questions", "plan", "threads", "account"]) expect((await app.inject({ url: `/api/ui-updates?target=${target}`, headers })).json().hasUnseen).toBe(false);
    } finally { await app.close(); delete process.env.CODEX_WEB_UI_UPDATE_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it("publishes question fixes at the question entry and acknowledges them per user", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-question-update-")); process.env.CODEX_WEB_UI_UPDATE_DIR = tmp;
    const app = Fastify(); registerUiUpdateRoutes(app);
    const alice = { cookie: createSessionCookie("question-alice").split(";")[0] }, bob = { cookie: createSessionCookie("question-bob").split(";")[0] };
    try {
      publishUiUpdate("question-fix-one", ["questions"]);
      expect((await app.inject({ url: "/api/ui-updates?target=account", headers: alice })).json().hasUnseen).toBe(false);
      expect((await app.inject({ url: "/api/ui-updates?target=plugins", headers: alice })).json().hasUnseen).toBe(false);
      expect((await app.inject({ url: "/api/ui-updates?target=questions", headers: alice })).json().hasUnseen).toBe(true);
      await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: alice, payload: { version: "question-fix-one", target: "questions" } });
      expect((await app.inject({ url: "/api/ui-updates?target=questions", headers: alice })).json().hasUnseen).toBe(false);
      expect((await app.inject({ url: "/api/ui-updates?target=questions", headers: bob })).json().hasUnseen).toBe(true);
    } finally { await app.close(); delete process.env.CODEX_WEB_UI_UPDATE_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it("places new plugin releases only at their real entry and preserves user separation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-update-")); process.env.CODEX_WEB_UI_UPDATE_DIR = tmp;
    const app = Fastify(); registerUiUpdateRoutes(app);
    const alice = { cookie: createSessionCookie("entry-alice").split(";")[0] }, bob = { cookie: createSessionCookie("entry-bob").split(";")[0] };
    try {
      publishUiUpdate("feishu-one", ["plugins", "feishu"], "飞书办公已加入 / 常用技能");
      expect((await app.inject({ url: "/api/ui-updates", headers: alice })).json().hasUnseen).toBe(false);
      expect((await app.inject({ url: "/api/ui-updates?target=plugins", headers: alice })).json().hasUnseen).toBe(true);
      await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: alice, payload: { version: "feishu-one", target: "account" } });
      expect((await app.inject({ url: "/api/ui-updates?target=plugins", headers: alice })).json().hasUnseen).toBe(true);
      await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: alice, payload: { version: "feishu-one", target: "plugins" } });
      expect((await app.inject({ url: "/api/ui-updates?target=plugins", headers: alice })).json().hasUnseen).toBe(false);
      expect((await app.inject({ url: "/api/ui-updates?target=feishu", headers: alice })).json().hasUnseen).toBe(true);
      await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: alice, payload: { version: "feishu-one", target: "feishu" } });
      expect((await app.inject({ url: "/api/ui-updates?target=feishu", headers: alice })).json().hasUnseen).toBe(false);
      expect((await app.inject({ url: "/api/ui-updates?target=feishu", headers: bob })).json().hasUnseen).toBe(true);
      expect((await app.inject({ url: "/api/ui-updates?target=plugins", headers: bob })).json().hasUnseen).toBe(true);
    } finally { await app.close(); delete process.env.CODEX_WEB_UI_UPDATE_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it("persists acknowledgements per user and reappears only for a different release", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-update-")); process.env.CODEX_WEB_UI_UPDATE_DIR = tmp;
    const app = Fastify(); registerUiUpdateRoutes(app);
    const alice = createSessionCookie("update-alice").split(";")[0], bob = createSessionCookie("update-bob").split(";")[0];
    const read = (cookie: string) => app.inject({ method: "GET", url: "/api/ui-updates", headers: { cookie } });
    try {
      expect((await app.inject({ method: "GET", url: "/api/ui-updates" })).statusCode).toBe(401);
      publishUiUpdate("release-one");
      expect((await read(alice)).json()).toEqual({ version: "release-one", hasUnseen: true });
      const ack = await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: { cookie: alice }, payload: { version: "release-one" } });
      expect(ack.json()).toEqual({ version: "release-one", hasUnseen: false });
      expect((await read(alice)).json().hasUnseen).toBe(false);
      expect((await read(bob)).json().hasUnseen).toBe(true);
      const restarted = Fastify(); registerUiUpdateRoutes(restarted);
      expect((await restarted.inject({ method: "GET", url: "/api/ui-updates", headers: { cookie: alice } })).json().hasUnseen).toBe(false);
      await restarted.close();
      publishUiUpdate("release-two");
      const stale = await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: { cookie: alice }, payload: { version: "release-one" } });
      expect(stale.json()).toEqual({ version: "release-two", hasUnseen: true });
      expect((await read(alice)).json().hasUnseen).toBe(true);
      expect((await app.inject({ method: "POST", url: "/api/ui-updates/seen", headers: { cookie: alice }, payload: { version: "../bad" } })).statusCode).toBe(400);
    } finally { await app.close(); delete process.env.CODEX_WEB_UI_UPDATE_DIR; fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
