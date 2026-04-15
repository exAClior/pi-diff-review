import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

export async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
  let currentDir = resolve(cwd);

  while (true) {
    const piDir = join(currentDir, ".pi");
    const guidelinesPath = join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await stat(piDir).catch(() => null);
    if (piStats?.isDirectory()) {
      const guidelineStats = await stat(guidelinesPath).catch(() => null);
      if (guidelineStats?.isFile()) {
        try {
          const content = await readFile(guidelinesPath, "utf8");
          const trimmed = content.trim();
          return trimmed.length > 0 ? trimmed : null;
        } catch {
          return null;
        }
      }

      return null;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}
