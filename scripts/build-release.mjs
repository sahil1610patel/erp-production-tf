/** Build deployable assets without remote runtime compilers or CDN dependencies. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "tooling/package.json"));
const Babel = require("@babel/standalone");
const out = path.join(root, "dist");
await fs.mkdir(path.join(out, "frontend/vendor"), { recursive: true });
let html = await fs.readFile(path.join(root, "frontend/index.html"), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const jsx = scripts.filter((m) =>
  /type=["']text\/(?:x-erp-jsx|babel)["']/.test(m[1]),
);
if (jsx.length !== 1)
  throw new Error("Expected one ERP JSX application script");
const compiled = Babel.transform(jsx[0][2], {
  presets: ["react"],
  sourceType: "script",
  comments: false,
  compact: false,
}).code;
await fs.writeFile(path.join(out, "frontend/vendor/app.js"), compiled);
// Drop the development runtime compiler and inline transform loader. All executable
// production JavaScript is served from this origin under script-src self.
for (const match of scripts) {
  if (!/\bsrc\s*=/.test(match[1]) || /babel(?:\.min)?\.js/.test(match[1]))
    html = html.replace(match[0], "");
}
html = html.replace(
  "</body>",
  '<script src="/vendor/app.js" defer></script>\n</body>',
);
await fs.writeFile(path.join(out, "frontend/index.html"), html);
for (const [pkg, file] of [
  ["react", "react.production.min.js"],
  ["react-dom", "react-dom.production.min.js"],
]) {
  await fs.copyFile(
    path.join(root, "tooling/node_modules", pkg, "umd", file),
    path.join(out, "frontend/vendor", file),
  );
}
const css = await require("postcss")([
  require("tailwindcss")({ content: [path.join(root, "frontend/index.html")] }),
  require("autoprefixer")({
    overrideBrowserslist: [
      "last 2 Chrome versions",
      "last 2 Firefox versions",
      "last 2 Safari versions",
      "last 2 Edge versions",
    ],
  }),
]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", {
  from: undefined,
});
if (css.warnings().length)
  throw new Error(
    css
      .warnings()
      .map((w) => w.toString())
      .join("\n"),
  );
await fs.writeFile(path.join(out, "frontend/vendor/tailwind.css"), css.css);
// Keep the requested single-file Babel development workflow usable as well.
await fs.mkdir(path.join(root, "frontend/vendor"), { recursive: true });
for (const file of [
  "react.production.min.js",
  "react-dom.production.min.js",
  "tailwind.css",
]) {
  await fs.copyFile(
    path.join(out, "frontend/vendor", file),
    path.join(root, "frontend/vendor", file),
  );
}
await fs.copyFile(
  path.join(root, "tooling/node_modules/@babel/standalone/babel.min.js"),
  path.join(root, "frontend/vendor/babel.min.js"),
);
// The archive contains source, migrations and the frozen npm manifest. EC2 runs
// npm ci --omit=dev against the signed TLS registry during boot.
const stage = path.join(out, "backend");
await fs.rm(stage, { recursive: true, force: true });
await fs.cp(path.join(root, "backend"), stage, {
  recursive: true,
  filter: (src) =>
    !/(?:^|\/)(?:node_modules|coverage|test|tests)(?:\/|$)/.test(src) &&
    !/(?:^|\/)\.env(?:\.|$)/.test(src),
});
await fs.rm(path.join(out, "backend.zip"), { force: true });
execFileSync("zip", ["-q", "-r", path.join(out, "backend.zip"), "."], {
  cwd: stage,
  stdio: "inherit",
});
const digest = createHash("sha256")
  .update(await fs.readFile(path.join(out, "backend.zip")))
  .digest("hex");
await fs.writeFile(
  path.join(out, "backend.zip.sha256"),
  `${digest}  backend.zip\n`,
);
await fs.writeFile(
  path.join(out, "release.json"),
  JSON.stringify(
    {
      backendSha256: digest,
      backend: JSON.parse(
        await fs.readFile(path.join(root, "backend/package.json"), "utf8"),
      ).version,
      tooling: JSON.parse(
        await fs.readFile(path.join(root, "tooling/package.json"), "utf8"),
      ).dependencies,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Release built: dist/frontend and dist/backend.zip\nSHA256 ${digest}`,
);
