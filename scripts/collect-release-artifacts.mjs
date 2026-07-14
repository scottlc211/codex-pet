import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2];
const outputDirectory = process.argv[3] ? resolve(root, process.argv[3]) : null;
const releaseDirectory = resolve(root, "src-tauri", "target", "release");
const bundleDirectory = resolve(releaseDirectory, "bundle");

if (!outputDirectory || !["windows-x86_64", "linux-x86_64"].includes(platform)) {
  throw new Error(
    "Usage: node scripts/collect-release-artifacts.mjs <windows-x86_64|linux-x86_64> <output-directory>",
  );
}

const bundleFiles = await listFiles(bundleDirectory);
const definitions =
  platform === "windows-x86_64"
    ? [
        { label: "MSI installer", match: (path) => path.toLowerCase().endsWith(".msi") },
        { label: "NSIS installer", match: (path) => path.toLowerCase().endsWith("-setup.exe") },
        {
          label: "Windows executable",
          path: resolve(releaseDirectory, "codex-pet.exe"),
          match: (path) => path === resolve(releaseDirectory, "codex-pet.exe"),
        },
      ]
    : [
        { label: "Debian package", match: (path) => path.toLowerCase().endsWith(".deb") },
        { label: "AppImage", match: (path) => path.endsWith(".AppImage") },
        {
          label: "Linux executable",
          path: resolve(releaseDirectory, "codex-pet"),
          match: (path) => path === resolve(releaseDirectory, "codex-pet"),
        },
      ];
const candidates = [...bundleFiles, ...definitions.flatMap((definition) => definition.path ?? [])];
const selectedFiles = [];

for (const definition of definitions) {
  const matches = candidates.filter(definition.match);
  if (matches.length === 0) {
    throw new Error(`Missing ${definition.label} in ${releaseDirectory}`);
  }
  selectedFiles.push(...matches);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const copiedNames = new Set();
for (const source of [...new Set(selectedFiles)].sort()) {
  const name = basename(source);
  if (copiedNames.has(name)) {
    throw new Error(`Duplicate release artifact name: ${name}`);
  }
  copiedNames.add(name);
  await copyFile(source, resolve(outputDirectory, name));
}

const checksumLines = [];
for (const name of [...copiedNames].sort()) {
  checksumLines.push(`${await sha256(resolve(outputDirectory, name))}  ${name}`);
}
const checksumName = `SHA256SUMS-${platform}.txt`;
await writeFile(resolve(outputDirectory, checksumName), `${checksumLines.join("\n")}\n`, "utf8");

console.log(`Collected ${copiedNames.size} files in ${outputDirectory}`);
for (const name of [...copiedNames].sort()) {
  console.log(`- ${name}`);
}
console.log(`- ${checksumName}`);

async function listFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
      }),
    );
    return nested.flat();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function sha256(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error(`Release artifact is not a regular file: ${path}`);
  }
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
