import { build } from "esbuild";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const webDir = join(rootDir, "web");
const tempDir = join(webDir, ".build");
const tempChunksDir = join(tempDir, "chunks");
const outputAppPath = join(webDir, "app.js");
const outputChunksDir = join(webDir, "chunks");

// Normalize generated JavaScript so git diff --check stays quiet.
async function stripTrailingWhitespaceRecursively(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await stripTrailingWhitespaceRecursively(entryPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const content = await readFile(entryPath, "utf8");
    await writeFile(entryPath, content.replace(/[ \t]+\n/g, "\n"));
  }
}

await rm(tempDir, { force: true, recursive: true });

await build({
  entryPoints: [join(webDir, "app-source.js")],
  bundle: true,
  minify: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: tempDir,
  entryNames: "app",
  chunkNames: "chunks/[name]-[hash]",
});

await stripTrailingWhitespaceRecursively(tempDir);

await rm(outputAppPath, { force: true });
await rm(outputChunksDir, { force: true, recursive: true });

await rename(join(tempDir, "app.js"), outputAppPath);
await rename(tempChunksDir, outputChunksDir);
await rm(tempDir, { force: true, recursive: true });
