import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(frontendRoot, "public/vendor/superdoc-1.30.0");
const packageJson = JSON.parse(await readFile(path.join(frontendRoot, "package.json"), "utf8"));
const superdocPackage = JSON.parse(await readFile(path.join(frontendRoot, "node_modules/superdoc/package.json"), "utf8"));
const reactPackage = JSON.parse(await readFile(path.join(frontendRoot, "node_modules/@superdoc-dev/react/package.json"), "utf8"));

if (packageJson.dependencies?.superdoc !== "1.30.0" || superdocPackage.version !== "1.30.0") {
  throw new Error("Expected the pinned, AGPL-only superdoc@1.30.0 package.");
}
if (packageJson.dependencies?.["@superdoc-dev/react"] !== "1.15.2" || reactPackage.version !== "1.15.2") {
  throw new Error("Expected the pinned, AGPL-only @superdoc-dev/react@1.15.2 package.");
}
if (superdocPackage.license !== "AGPL-3.0" || reactPackage.license !== "AGPL-3.0") {
  throw new Error("Unexpected SuperDoc license metadata; refusing to vendor.");
}
if (JSON.stringify(superdocPackage).includes("@superdoc/docx-engine")) {
  throw new Error("Refusing to vendor SuperDoc with the proprietary DOCX engine dependency.");
}

const build = await esbuild.build({
  stdin: {
    contents: 'export { SuperDoc } from "superdoc";\n',
    loader: "js",
    resolveDir: frontendRoot,
    sourcefile: "superdoc-vendor-entry.js"
  },
  absWorkingDir: frontendRoot,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  minify: true,
  legalComments: "external",
  treeShaking: true,
  write: false,
  metafile: true,
  outfile: path.join(vendorRoot, "superdoc.mjs"),
  logLevel: "warning"
});

const inputPaths = Object.keys(build.metafile.inputs);
if (inputPaths.some(input => input.replaceAll("\\", "/").includes("/@superdoc/docx-engine/"))) {
  throw new Error("Proprietary DOCX engine appeared in the SuperDoc bundle graph.");
}
const externalImports = Object.values(build.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path));
if (externalImports.length) {
  throw new Error(`SuperDoc bundle is not self-contained; external imports: ${externalImports.join(", ")}`);
}

await mkdir(vendorRoot, { recursive: true });
for (const output of build.outputFiles) {
  await writeFile(output.path, output.contents);
}
await writeFile(path.join(vendorRoot, "LICENSE-superdoc.txt"), await readFile(path.join(frontendRoot, "node_modules/superdoc/LICENSE")));
await writeFile(path.join(vendorRoot, "LICENSE-react-wrapper.txt"), await readFile(path.join(frontendRoot, "node_modules/@superdoc-dev/react/LICENSE")));
await writeFile(path.join(vendorRoot, "loader.mjs"), [
  'import { SuperDoc } from "./superdoc.mjs?v=esm-20261002";',
  "window.__codexSuperDocRuntime130 = { SuperDoc };",
  "export {};"
].join("\n") + "\n");
await writeFile(path.join(vendorRoot, "NOTICE"), [
  "SuperDoc runtime vendor bundle",
  "",
  "This directory contains the browser ESM bundle built from the official npm packages:",
  "- superdoc 1.30.0 (AGPL-3.0), LICENSE-superdoc.txt",
  "- @superdoc-dev/react 1.15.2 (AGPL-3.0), LICENSE-react-wrapper.txt; the wrapper stays in the normal app chunk",
  "- esbuild legal comments and bundled dependency attribution: superdoc.mjs.LEGAL.txt",
  "",
  "The generated SuperDoc bundle is self-contained and has no external imports. The proprietary @superdoc/docx-engine package is not present in the dependency graph or bundle.",
  "loader.mjs is a same-origin native module bridge that imports the adjacent bundle; it does not use eval, a Blob URL, or a remote host."
].join("\n") + "\n");

const bundleFile = build.outputFiles.find(file => file.path.endsWith("superdoc.mjs"));
console.log(`Prepared SuperDoc 1.30.0 vendor bundle (${bundleFile?.contents.byteLength ?? 0} bytes; ${inputPaths.length} bundled inputs).`);
