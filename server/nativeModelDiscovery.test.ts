import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { nativeModelDiscoveryArgs, nativeModelDiscoveryEnabled, prepareNativeModelDiscovery, withoutPinnedModelCatalog } from "./nativeModelDiscovery.js";

const homes: string[] = [];
const home = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-model-discovery-")); homes.push(directory); return directory; };
afterEach(() => { for (const directory of homes.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("Codex native model discovery", () => {
  it("preserves provider lists, comments, CRLF and data paths while removing the root pin", () => {
    const source = '# Runtime\r\nmodel_catalog_json = "/owned/legacy.json" # pin\r\nsqlite_home = "/owned/state"\r\n[model_providers.other]\r\nmodel_catalog_json = "/providers/keep.json"\r\n';
    expect(withoutPinnedModelCatalog(source)).toBe(source.replace('model_catalog_json = "/owned/legacy.json" # pin\r\n', ""));
  });

  it("distinguishes real settings from multiline instructions and preserves large integers", () => {
    const source = 'instructions = """\nmodel_catalog_json = "example only"\n"""\n"model_catalog_json" = "/legacy.json"\nvalue = 9223372036854775807\n';
    const migrated = withoutPinnedModelCatalog(source);
    expect(migrated).toContain('model_catalog_json = "example only"');
    expect(migrated).not.toContain('"model_catalog_json" = "/legacy.json"');
    expect(migrated).toContain("9223372036854775807");
  });

  it("retains malformed configs and keeps config content out of errors", () => {
    const directory = home(), source = 'secret = "PRIVATE_TEST_VALUE\nmodel_catalog_json="old"\n';
    fs.writeFileSync(path.join(directory, "config.toml"), source);
    expect(() => prepareNativeModelDiscovery(directory)).toThrow(/原配置已保留/);
    try { withoutPinnedModelCatalog(source); } catch (error) { expect(String(error)).not.toContain("PRIVATE_TEST_VALUE"); }
    expect(fs.readFileSync(path.join(directory, "config.toml"), "utf8")).toBe(source);
    expect(fs.readdirSync(directory)).toEqual(["config.toml"]);
  });

  it("backs up once and retains native caches, UI catalogs and credentials exactly", () => {
    const directory = home(), source = 'model_catalog_json="old.json"\napproval_policy="never"\n';
    const retained = ["models_cache.json", "model-catalog-gpt-5.6-sol-long-context.json", "auth.json"];
    fs.writeFileSync(path.join(directory, "config.toml"), source);
    for (const name of retained) fs.writeFileSync(path.join(directory, name), name);
    prepareNativeModelDiscovery(directory); prepareNativeModelDiscovery(directory);
    const backups = fs.readdirSync(directory).filter(name => name.includes(".before-native-model-discovery."));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, backups[0]), "utf8")).toBe(source);
    expect(fs.statSync(path.join(directory, backups[0])).mode & 0o777).toBe(0o600);
    expect(parse(fs.readFileSync(path.join(directory, "config.toml"), "utf8"))).toEqual({ approval_policy: "never" });
    for (const name of retained) expect(fs.readFileSync(path.join(directory, name), "utf8")).toBe(name);
  });

  it("replaces only a private config symlink and leaves its shared target intact", () => {
    const directory = home(), shared = home(), source = 'model_catalog_json="shared.json"\nmodel="gpt-6.1-sol"\n';
    fs.writeFileSync(path.join(shared, "shared.toml"), source);
    fs.symlinkSync(path.join(shared, "shared.toml"), path.join(directory, "config.toml"));
    prepareNativeModelDiscovery(directory);
    expect(fs.readFileSync(path.join(shared, "shared.toml"), "utf8")).toBe(source);
    expect(fs.lstatSync(path.join(directory, "config.toml")).isSymbolicLink()).toBe(false);
  });

  it("preserves explicit providers and the legacy opt-out", () => {
    const directory = home();
    expect(nativeModelDiscoveryEnabled(directory, "codex-account", {})).toBe(true);
    expect(nativeModelDiscoveryEnabled(directory, "api-provider", {})).toBe(false);
    expect(nativeModelDiscoveryEnabled(directory, "codex-account", { CODEX_WEB_CODEX_MODEL_DISCOVERY: "legacy" })).toBe(false);
    fs.writeFileSync(path.join(directory, "config.toml"), 'model_provider="other"\nmodel_catalog_json="provider.json"\n');
    expect(nativeModelDiscoveryEnabled(directory, "codex-account", {})).toBe(false);
    fs.writeFileSync(path.join(directory, "config.toml"), 'profile="custom"\n[profiles.custom]\nmodel_provider="other"\nmodel_catalog_json="provider.json"\n');
    expect(nativeModelDiscoveryEnabled(directory, "codex-account", {})).toBe(false);
  });

  it("isolates project config and enables Default questions without a catalog pin", () => {
    expect(nativeModelDiscoveryArgs({})).toEqual(["-c", "project_root_markers=[]", "-c", "features.default_mode_request_user_input=true"]);
    expect(nativeModelDiscoveryArgs({ CODEX_WEB_DEFAULT_MODE_REQUEST_USER_INPUT: "false" })).toEqual(["-c", "project_root_markers=[]"]);
    expect(nativeModelDiscoveryArgs({}).join(" ")).not.toContain("model_catalog_json");
  });
});
