import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson(resolve(root, "package.json"));
const tauriConfig = readJson(resolve(root, "src-tauri", "tauri.conf.json"));
const cargoMetadata = JSON.parse(
  execFileSync(
    process.env.CARGO || "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--manifest-path",
      resolve(root, "src-tauri", "Cargo.toml"),
    ],
    { encoding: "utf8" },
  ),
);
const cargoPackage = cargoMetadata.packages.find(
  (candidate) => resolve(candidate.manifest_path) === resolve(root, "src-tauri", "Cargo.toml"),
);

if (!cargoPackage) {
  throw new Error("Cargo metadata does not contain the src-tauri package");
}

const versions = {
  packageJson: packageJson.version,
  tauriConfig: tauriConfig.version,
  cargoPackage: cargoPackage.version,
};
const uniqueVersions = new Set(Object.values(versions));
if (uniqueVersions.size !== 1) {
  throw new Error(`Version mismatch: ${JSON.stringify(versions)}`);
}

const version = versions.packageJson;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid application version: ${String(version)}`);
}

const releaseTag = process.env.RELEASE_TAG?.trim();
if (releaseTag) {
  if (!/^[vV]/.test(releaseTag) || releaseTag.slice(1) !== version) {
    throw new Error(`Release tag ${releaseTag} must match application version v${version}`);
  }
}

console.log(`Application versions are synchronized at ${version}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
