#!/usr/bin/env node
/**
 * After the three release-matrix jobs upload artifacts, build one
 * latest.json with windows-x86_64, darwin-aarch64, and darwin-x86_64.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), RELEASE_TAG, VERSION
 */
import { writeFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;
const version = (process.env.VERSION || "").replace(/^v/, "");

if (!token || !repo || !tag || !version) {
  console.error("need GITHUB_TOKEN, GITHUB_REPOSITORY, RELEASE_TAG, VERSION");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "hookdeploy-agent-release",
};

// GET /releases/tags/{tag} only returns *published* releases (GitHub docs:
// "Get a published release with the specified tag"). Drafts 404 there.
// GET /releases lists drafts when the token has push access (contents:write
// GITHUB_TOKEN qualifies). Filter by tag_name so draft and published both work.
async function findReleaseByTag(tagName) {
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) {
      console.error("release list failed", res.status, await res.text());
      process.exit(1);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    const hit = batch.find((r) => r.tag_name === tagName);
    if (hit) return hit;
    if (batch.length < 100) break;
  }
  console.error(`no release found with tag_name=${tagName} (checked drafts + published)`);
  process.exit(1);
}

const release = await findReleaseByTag(tag);
console.log(
  `using release id=${release.id} tag=${release.tag_name} draft=${release.draft}`,
);
const assets = release.assets || [];

function findAsset(...preds) {
  const a = assets.find((x) => preds.every((p) => p(x.name)));
  if (!a) return null;
  const sig = assets.find((x) => x.name === `${a.name}.sig`);
  // Prefer tag download URLs so latest.json stays valid after a draft is
  // published (browser_download_url uses untagged-* while draft).
  const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(a.name)}`;
  return {
    url,
    name: a.name,
    sigId: sig?.id,
  };
}

// Draft browser_download_url 404s until publish. Download .sig bytes via the
// Releases assets API (Accept: application/octet-stream) instead.
async function sigBody(assetId) {
  if (!assetId) throw new Error("missing .sig asset");
  const s = await fetch(
    `https://api.github.com/repos/${repo}/releases/assets/${assetId}`,
    {
      headers: {
        ...headers,
        Accept: "application/octet-stream",
      },
      redirect: "follow",
    },
  );
  if (!s.ok) throw new Error(`sig fetch ${s.status} asset_id=${assetId}`);
  return (await s.text()).trim();
}

const windows = findAsset(
  (n) => n.endsWith("-setup.exe") || n.endsWith("_x64-setup.exe"),
  (n) => !n.endsWith(".sig"),
);
const darwinArm = findAsset(
  (n) => n.includes("aarch64") && n.endsWith(".app.tar.gz"),
);
const darwinX64 = findAsset(
  (n) =>
    (n.includes("x64") || n.includes("x86_64")) &&
    n.endsWith(".app.tar.gz") &&
    !n.includes("aarch64"),
);

const missing = [
  ["windows-x86_64", windows],
  ["darwin-aarch64", darwinArm],
  ["darwin-x86_64", darwinX64],
].filter(([, v]) => !v);
if (missing.length) {
  console.error(
    "missing artifacts:",
    missing.map(([k]) => k).join(", "),
    "have:",
    assets.map((a) => a.name),
  );
  process.exit(1);
}

const platforms = {
  "windows-x86_64": {
    url: windows.url,
    signature: await sigBody(windows.sigId),
  },
  "darwin-aarch64": {
    url: darwinArm.url,
    signature: await sigBody(darwinArm.sigId),
  },
  "darwin-x86_64": {
    url: darwinX64.url,
    signature: await sigBody(darwinX64.sigId),
  },
};

const latest = {
  version,
  notes: release.body || "",
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync("latest.json", JSON.stringify(latest, null, 2) + "\n");
console.log("wrote latest.json", Object.keys(platforms));
