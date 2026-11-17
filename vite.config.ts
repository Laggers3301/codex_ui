import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const superDocRuntime = fileURLToPath(new URL("./src/writing/SuperDocRuntime.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^superdoc$/, replacement: superDocRuntime }] },
  build: {
    // Keep old content-hashed bundles available to tabs that loaded before deployment.
    emptyOutDir: false,
    rollupOptions: {
      output: {
        // Stable vendor chunks: their hashes depend only on the package versions, so a release that touches
        // application code leaves them cached. Only top-level, statically needed packages are grouped; nested
        // node_modules (mermaid's own katex, ...) and lazy libraries (mermaid, codemirror, pdfjs, superdoc)
        // keep Rollup's default placement and never enter the entry's static import graph.
        manualChunks(id) {
          // Stylesheets keep their importer's cascade position (xterm.css, katex.min.css stay in the entry CSS).
          if (/\.css(?:\?|$)/.test(id)) return undefined;
          const parts = id.split("node_modules/");
          if (parts.length !== 2) return undefined;
          const name = parts[1].startsWith("@") ? parts[1].split("/").slice(0, 2).join("/") : parts[1].split("/")[0];
          if (/^(react|react-dom|scheduler)$/.test(name)) return "vendor-react";
          if (/^(@tiptap\/.*|prosemirror-.*|linkifyjs|marked|orderedmap|rope-sequence|w3c-keyname|crelt|fast-equals|use-sync-external-store|@floating-ui\/.*)$/.test(name)) return "vendor-editor";
          if (/^(react-markdown|remend|unified|trough|bail|vfile|vfile-.*|remark-.*|rehype-.*|micromark|micromark-.*|mdast-util-.*|hast-.*|hastscript|unist-util-.*|property-information|space-separated-tokens|comma-separated-tokens|web-namespaces|zwitch|ccount|devlop|extend|is-plain-obj|markdown-table|longest-streak|trim-lines|style-to-js|style-to-object|inline-style-parser|html-url-attributes|decode-named-character-reference|character-entities.*|character-reference-invalid|is-alphabetical|is-alphanumerical|is-decimal|is-hexadecimal|parse-entities|stringify-entities|estree-util-is-identifier-name|@ungap\/structured-clone)$/.test(name)) return "vendor-markdown";
          if (name === "katex") return "vendor-katex";
          if (name.startsWith("@xterm/")) return "vendor-xterm";
          if (name === "@tanstack/virtual-core" || name === "@tanstack/react-virtual") return "vendor-virtual";
          if (name === "lucide-react" || name === "@icon-park/svg") return "vendor-icons";
          return undefined;
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4573",
      "/ws": {
        target: "ws://127.0.0.1:4573",
        ws: true
      }
    }
  }
});
