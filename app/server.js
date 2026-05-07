import express from "express";
import http from "http";
import https from "https";

const app = express();

/* ------------------------------------------------------------------ */
/*  Config from environment                                           */
/*                                                                    */
/*  LOCAL_LABEL=nas                                                   */
/*  REMOTE_SERVERS=windows=http://192.168.1.100:3000                  */
/*  EXCLUDE_IMAGES=ghcr.io/hwndmaster,myregistry.io/internal          */
/* ------------------------------------------------------------------ */

const REMOTE_SERVERS = (process.env.REMOTE_SERVERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const eqIdx = s.indexOf("=");
    return { label: s.slice(0, eqIdx), url: s.slice(eqIdx + 1) };
  });

const EXCLUDE_IMAGES = (process.env.EXCLUDE_IMAGES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isExcluded(image) {
  return EXCLUDE_IMAGES.some((pattern) => image.includes(pattern));
}

/* ------------------------------------------------------------------ */
/*  Simple in-memory cache (per image, TTL = 10 min)                  */
/* ------------------------------------------------------------------ */

const tagCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedTags(image) {
  const entry = tagCache.get(image);
  if (entry && Date.now() < entry.expiresAt) return entry.result;
  return undefined;
}

function setCachedTags(image, result) {
  tagCache.set(image, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/* ------------------------------------------------------------------ */
/*  Docker socket                                                     */
/* ------------------------------------------------------------------ */

function dockerRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: "/var/run/docker.sock", path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Docker socket parse error: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Generic HTTPS GET helper                                          */
/* ------------------------------------------------------------------ */

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    options.headers = { "User-Agent": "docker-status-api/1.0", ...headers };

    https
      .get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
        }
        if (res.statusCode === 401) {
          reject(new Error(`HTTP 401 - auth required (${url})`));
          res.resume();
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(new Error(`JSON parse error for ${url}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Docker Hub                                                        */
/* ------------------------------------------------------------------ */

async function fetchDockerHubTags(repo, name) {
  const url = `https://hub.docker.com/v2/repositories/${repo}/${name}/tags?page_size=100&ordering=last_updated`;
  const { body } = await httpsGet(url);
  if (!Array.isArray(body.results)) return [];
  return body.results.map((t) => t.name);
}

/* ------------------------------------------------------------------ */
/*  GHCR                                                              */
/* ------------------------------------------------------------------ */

async function fetchGhcrToken(repo, name) {
  const url = `https://ghcr.io/token?scope=repository:${repo}/${name}:pull&service=ghcr.io`;
  const { body } = await httpsGet(url);
  return body.token || body.access_token || null;
}

async function fetchGhcrTags(repo, name) {
  const token = await fetchGhcrToken(repo, name);
  if (!token) throw new Error(`Could not get GHCR token for ${repo}/${name}`);
  const url = `https://ghcr.io/v2/${repo}/${name}/tags/list`;
  const { body } = await httpsGet(url, { Authorization: `Bearer ${token}` });
  return body.tags || [];
}

/* ------------------------------------------------------------------ */
/*  Version helpers                                                   */
/* ------------------------------------------------------------------ */

function extractTag(image) {
  const withoutHost = image.replace(/^[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}(:[0-9]+)?\//, "");
  const withoutDigest = withoutHost.split("@")[0];
  const colonIdx = withoutDigest.lastIndexOf(":");
  return colonIdx !== -1 ? withoutDigest.slice(colonIdx + 1) : "latest";
}

function hasDigest(image) {
  return image.includes("@sha256:");
}

const NON_VERSION_TAGS = new Set([
  "latest", "nightly", "dev", "beta", "test", "rc",
  "stable", "edge", "main", "master", "release",
]);

const ARCH_KEYWORDS = ["amd64", "arm64", "arm", "386", "s390x", "ppc64"];
const VARIANT_KEYWORDS = ["alpine", "slim", "bullseye", "bookworm", "buster", "windowsservercore"];

function isVersionTag(tag) {
  const lower = tag.toLowerCase();
  if (NON_VERSION_TAGS.has(lower)) return false;
  if (ARCH_KEYWORDS.some((k) => lower.includes(k))) return false;
  if (VARIANT_KEYWORDS.some((k) => lower.includes(k))) return false;
  // Nightly builds: 10.11.8.20260405-192842
  if (/\.\d{8}/.test(tag)) return false;
  // Standalone date-based: 20260504, 2026050406
  if (/^\d{8,}/.test(tag)) return false;
  // PR/branch builds: pr-1543, build-123
  if (/^[a-zA-Z]{2,}-\d/.test(tag)) return false;
  return /\d/.test(tag);
}

function normalizeTag(tag) {
  return tag.replace(/^v/, "");
}

function parseVersion(tag) {
  return normalizeTag(tag)
    .split(/[.\-_]/)
    .map((n) => parseInt(n, 10))
    .filter((n) => !Number.isNaN(n));
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return nb - na;
  }
  return 0;
}

function guessTagPattern(tag) {
  const normalized = normalizeTag(tag);
  if (/^\d{8,}/.test(normalized)) return "datebased";
  if (/^\d+\.\d+/.test(normalized)) return "semver";
  if (/^\d+$/.test(normalized)) return "semver";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/*  Image parsing                                                     */
/* ------------------------------------------------------------------ */

function detectRegistry(image) {
  if (image.startsWith("ghcr.io/")) return "ghcr";
  if (image.startsWith("docker.io/")) return "dockerhub";
  return "dockerhub";
}

function parseDockerHubImage(image) {
  const stripped = image.replace(/^docker\.io\//, "");
  const imageNoTag = stripped.split(":")[0].split("@")[0];
  const parts = imageNoTag.split("/");
  if (parts.length === 1) return { repo: "library", name: parts[0] };
  return { repo: parts.slice(0, -1).join("/"), name: parts[parts.length - 1] };
}

function parseGhcrImage(image) {
  const withoutHost = image.replace("ghcr.io/", "").split(":")[0].split("@")[0];
  const parts = withoutHost.split("/");
  return { repo: parts.slice(0, -1).join("/"), name: parts[parts.length - 1] };
}

/* ------------------------------------------------------------------ */
/*  Image labels + creation date fallback                             */
/* ------------------------------------------------------------------ */

async function getImageInfo(imageId) {
  try {
    return await dockerRequest(`/images/${encodeURIComponent(imageId)}/json`);
  } catch {
    return null;
  }
}

function extractVersionFromLabels(imageInfo) {
  const labels = imageInfo?.Config?.Labels ?? {};
  const version =
    labels["org.opencontainers.image.version"] ||
    labels["org.label-schema.version"] ||
    labels["version"] ||
    null;
  // Ignore label if author wrote "latest" or similar as version
  if (version && NON_VERSION_TAGS.has(version.toLowerCase())) return null;
  return version;
}

// Fallback: use image creation date as version (YYYY-MM-DD).
// Useful for projects like metube that use date-based tags but don't set labels.
function extractDateFromImageInfo(imageInfo) {
  const created = imageInfo?.Created; // e.g. "2026-04-28T19:05:54.350040342Z"
  if (!created) return null;
  return created.slice(0, 10); // → "2026-04-28"
}

/* ------------------------------------------------------------------ */
/*  Tag resolution                                                    */
/* ------------------------------------------------------------------ */

async function getLatestVersionTag(image, installedVersion) {
  if (hasDigest(image)) return null;

  const cached = getCachedTags(image);
  if (cached !== undefined) return cached;

  const registry = detectRegistry(image);
  let tags = [];

  if (registry === "ghcr") {
    const { repo, name } = parseGhcrImage(image);
    tags = await fetchGhcrTags(repo, name);
  } else {
    const { repo, name } = parseDockerHubImage(image);
    tags = await fetchDockerHubTags(repo, name);
  }

  const pattern = guessTagPattern(installedVersion);

  const versionTags = tags
    .filter((t) => {
      if (!isVersionTag(t)) return false;
      if (pattern !== "unknown" && guessTagPattern(t) !== pattern) return false;
      return true;
    })
    .sort(compareVersions);

  const result = versionTags.length > 0 ? versionTags[0] : null;
  setCachedTags(image, result);
  return result;
}

/* ------------------------------------------------------------------ */
/*  Core: resolve one raw Docker container object → our format        */
/* ------------------------------------------------------------------ */

async function resolveContainer(c) {
  const name = c.Names[0].replace(/^\//, "");
  const image = c.Image;
  const tagVersion = extractTag(image);

  console.log(`[resolve] ${name}: image=${image}, tagVersion=${tagVersion}, isVersionTag=${isVersionTag(tagVersion)}`);

  let installedVersion = tagVersion;
  let installedFromDate = false;

  if (!isVersionTag(tagVersion)) {
    const imageInfo = await getImageInfo(c.ImageID);
    console.log(`[resolve] ${name}: created=${imageInfo?.Created}, labels=${JSON.stringify(imageInfo?.Config?.Labels)}`);

    const labelVersion = extractVersionFromLabels(imageInfo);
    if (labelVersion) {
      installedVersion = labelVersion;
      console.log(`[resolve] ${name}: installedVersion=${installedVersion} (from label)`);
    } else {
      const dateVersion = extractDateFromImageInfo(imageInfo);
      console.log(`[resolve] ${name}: dateVersion=${dateVersion}`);
      if (dateVersion) {
        installedVersion = dateVersion;
        installedFromDate = true;
        console.log(`[resolve] ${name}: installedVersion=${installedVersion} (from creation date)`);
      }
    }
  }

  let latestVersion = installedVersion;
  let updateAvailable = false;
  let error = null;

  try {
    // If version was derived from image creation date we can't reliably compare
    // it against registry tags (different formats), so skip the check.
    const latest = installedFromDate
      ? null
      : await getLatestVersionTag(image, installedVersion);

    console.log(`[resolve] ${name}: pattern=${guessTagPattern(installedVersion)}, latestFound=${latest}`);

    if (latest) {
      latestVersion = latest;
      updateAvailable = normalizeTag(latest) !== normalizeTag(installedVersion);
    }
  } catch (e) {
    console.error(`[version-check] ${image}: ${e.message}`);
    error = e.message;
  }

  return {
    name,
    status: c.State,
    image,
    currentVersion: installedVersion,
    latestVersion,
    updateAvailable,
    ...(error && { versionCheckError: error }),
  };
}

/* ------------------------------------------------------------------ */
/*  Fetch containers from a remote server                             */
/* ------------------------------------------------------------------ */

function fetchRemoteContainers(server) {
  return new Promise((resolve, reject) => {
    const url = new URL("/containers", server.url);
    const proto = url.protocol === "https:" ? https : http;

    const req = proto.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(
              (json.containers || []).map((c) => ({ ...c, server: server.label }))
            );
          } catch (e) {
            reject(new Error(`Parse error from ${server.label}: ${e.message}`));
          }
        });
      }
    );

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error(`Timeout connecting to ${server.label} (${server.url})`));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  /containers — local only                                          */
/* ------------------------------------------------------------------ */

app.get("/containers", async (req, res) => {
  try {
    const raw = await dockerRequest("/containers/json");
    const filtered = raw.filter((c) => !isExcluded(c.Image));
    const containers = await Promise.all(filtered.map(resolveContainer));
    res.json({ containers });
  } catch (err) {
    console.error("[/containers]", err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  /all-containers — local + all remote servers merged               */
/* ------------------------------------------------------------------ */

app.get("/all-containers", async (req, res) => {
  const LOCAL_LABEL = process.env.LOCAL_LABEL || "nas";

  async function fetchLocal() {
    const raw = await dockerRequest("/containers/json");
    const filtered = raw.filter((c) => !isExcluded(c.Image));
    const containers = await Promise.all(filtered.map(resolveContainer));
    return containers.map((c) => ({ ...c, server: LOCAL_LABEL }));
  }

  const tasks = [fetchLocal(), ...REMOTE_SERVERS.map(fetchRemoteContainers)];
  const settled = await Promise.allSettled(tasks);

  const servers = [];

  for (let i = 0; i < settled.length; i++) {
    const label = i === 0 ? LOCAL_LABEL : REMOTE_SERVERS[i - 1].label;
    if (settled[i].status === "fulfilled") {
      servers.push({ label, ok: true, containers: settled[i].value });
    } else {
      console.error(`[all-containers] ${label}: ${settled[i].reason.message}`);
      servers.push({ label, ok: false, error: settled[i].reason.message, containers: [] });
    }
  }

  const allContainers = servers.flatMap((s) => s.containers);
  const summary = servers.map(({ label, ok, error, containers }) => ({
    label,
    ok,
    ...(error && { error }),
    total: containers.length,
    updatesAvailable: containers.filter((c) => c.updateAvailable).length,
  }));

  res.json({ servers: summary, containers: allContainers });
});

/* ------------------------------------------------------------------ */
/*  /debug/:name — inspect image info for a container by name         */
/* ------------------------------------------------------------------ */

app.get("/debug/:name", async (req, res) => {
  try {
    const containers = await dockerRequest("/containers/json");
    const c = containers.find((c) =>
      c.Names.some((n) => n.replace(/^\//, "") === req.params.name)
    );
    if (!c) return res.status(404).json({ error: "Container not found" });

    const imageInfo = await getImageInfo(c.ImageID);
    res.json({
      containerName: req.params.name,
      imageId: c.ImageID,
      imageName: c.Image,
      created: imageInfo?.Created,
      labels: imageInfo?.Config?.Labels ?? {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; font-size: 13px; background: #1a1a2e; color: #e0e0e0; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 6px 8px; color: #888; font-weight: normal; border-bottom: 1px solid #333; }
    td { padding: 6px 8px; border-bottom: 1px solid #222; }
    tr:hover td { background: #ffffff08; }
    .server { color: #7a8fff; font-size: 11px; }
    .up { color: #4caf50; }
    .update { color: #ff9800; font-weight: bold; }
    .ok { color: #4caf50; }
    .error { color: #f44336; padding: 8px; }
  </style>
</head>
<body>
  <table>
    <thead>
      <tr>
        <th>Container</th>
        <th>Current</th>
        <th>Latest</th>
        <th>Update</th>
      </tr>
    </thead>
    <tbody id="tbody"><tr><td colspan="4" style="color:#555">Loading...</td></tr></tbody>
  </table>
  <script>
    fetch('/all-containers')
      .then(r => r.json())
      .then(data => {
        const rows = data.containers.map(c => \`
          <tr>
            <td>
              <div>\${c.name}</div>
              <div class="server">\${c.server}</div>
            </td>
            <td>\${c.currentVersion}</td>
            <td>\${c.latestVersion}</td>
            <td class="\${c.updateAvailable ? 'update' : 'ok'}">\${c.updateAvailable ? '↑ Yes' : '✓'}</td>
          </tr>
        \`).join('');
        document.getElementById('tbody').innerHTML = rows;
      })
      .catch(e => {
        document.getElementById('tbody').innerHTML =
          \`<tr><td colspan="4" class="error">Error: \${e.message}</td></tr>\`;
      });
  </script>
</body>
</html>`);
});

/* ------------------------------------------------------------------ */
/*  Start                                                             */
/* ------------------------------------------------------------------ */

app.listen(3000, () => {
  console.log("Docker Status API running on port 3000");
  console.log(`Local label: ${process.env.LOCAL_LABEL || "nas"}`);
  if (REMOTE_SERVERS.length > 0) {
    console.log("Remote servers:", REMOTE_SERVERS.map((s) => `${s.label}=${s.url}`).join(", "));
  } else {
    console.log("No remote servers configured (set REMOTE_SERVERS env var)");
  }
  if (EXCLUDE_IMAGES.length > 0) {
    console.log("Excluding images containing:", EXCLUDE_IMAGES.join(", "));
  }
});
