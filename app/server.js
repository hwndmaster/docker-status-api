import express from "express";
import http from "http";
import https from "https";

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------ */
/*  Config from environment                                           */
/*                                                                    */
/*  LOCAL_LABEL=nas                                                   */
/*  REMOTE_SERVERS=windows=http://192.168.1.100:3000                  */
/*  EXCLUDE_IMAGES=ghcr.io/immich-app/postgres                        */
/*  EXCLUDE_NAMES=immich_postgres,some_other                          */
/*  GHCR_TOKENS=ghcr.io/hwndmaster=ghp_yourtoken                      */
/* ------------------------------------------------------------------ */

const LOCAL_LABEL = process.env.LOCAL_LABEL || "nas";

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

const EXCLUDE_NAMES = (process.env.EXCLUDE_NAMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Tokens for private/authenticated GHCR namespaces.
// Format: "ghcr.io/owner=token,ghcr.io/owner2=token2"
const GHCR_TOKENS = (process.env.GHCR_TOKENS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .reduce((acc, s) => {
    const eqIdx = s.indexOf("=");
    acc[s.slice(0, eqIdx).toLowerCase()] = s.slice(eqIdx + 1);
    return acc;
  }, {});

console.log("Config:");
console.log(`  LOCAL_LABEL: ${LOCAL_LABEL}`);
console.log(`  REMOTE_SERVERS: ${REMOTE_SERVERS.map((s) => `${s.label}=${s.url}`).join(", ") || "None"}`);
console.log(`  EXCLUDE_IMAGES: ${EXCLUDE_IMAGES.join(", ") || "None"}`);
console.log(`  EXCLUDE_NAMES: ${EXCLUDE_NAMES.join(", ") || "None"}`);
console.log(`  GHCR_TOKENS: ${Object.keys(GHCR_TOKENS).join(", ") || "None"}`);

const ENABLE_TIMING_LOGS = process.env.ENABLE_TIMING_LOGS !== "0";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const REGISTRY_HTTP_TIMEOUT_MS = parsePositiveInt(
  process.env.REGISTRY_HTTP_TIMEOUT_MS,
  4000
);
const GHCR_LATEST_CHAIN_TIMEOUT_MS = parsePositiveInt(
  process.env.GHCR_LATEST_CHAIN_TIMEOUT_MS,
  6000
);
const GHCR_LATEST_CREATED_TTL_MS = parseNonNegativeInt(
  process.env.GHCR_LATEST_CREATED_TTL_MS,
  5 * 60 * 1000
);

const HTTPS_KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
});

function elapsedMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function logTiming(scope, step, ms, details = "") {
  if (!ENABLE_TIMING_LOGS) return;
  const suffix = details ? ` ${details}` : "";
  console.log(`[timing] ${scope} ${step}: ${ms.toFixed(1)}ms${suffix}`);
}

console.log(`  ENABLE_TIMING_LOGS: ${ENABLE_TIMING_LOGS}`);
console.log(`  REGISTRY_HTTP_TIMEOUT_MS: ${REGISTRY_HTTP_TIMEOUT_MS}`);
console.log(`  GHCR_LATEST_CHAIN_TIMEOUT_MS: ${GHCR_LATEST_CHAIN_TIMEOUT_MS}`);
console.log(`  GHCR_LATEST_CREATED_TTL_MS: ${GHCR_LATEST_CREATED_TTL_MS}`);

function getGhcrToken(image) {
  // Match longest prefix first, e.g. "ghcr.io/hwndmaster" before "ghcr.io"
  const lower = image.toLowerCase();
  const match = Object.keys(GHCR_TOKENS)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => lower.startsWith(prefix));
  return match ? GHCR_TOKENS[match] : null;
}

function isExcluded(image, containerName) {
  // Strip digest before matching so "ghcr.io/foo/bar" matches
  // "ghcr.io/foo/bar:tag@sha256:..." correctly
  const imageNoDigest = image.split("@")[0];
  if (EXCLUDE_IMAGES.some((pattern) => imageNoDigest.includes(pattern))) return true;
  if (EXCLUDE_NAMES.some((n) => n === containerName)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Simple in-memory cache (per image, TTL = 10 min)                  */
/* ------------------------------------------------------------------ */

const tagCache = new Map();
const registryTagsInFlight = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

const ghcrLatestCreatedCache = new Map();
const ghcrLatestCreatedInFlight = new Map();

// Latest-version lookups for GHCR images (GitHub releases API / manifest
// annotations), keyed by source-repo slug or image ref.
const latestVersionCache = new Map();
const latestVersionInFlight = new Map();

// Generic TTL + in-flight-dedup + stale-on-error lookup used by the
// latest-version caches above.
async function cachedLookup(cache, inFlight, key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.result;
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = (async () => {
    try {
      const result = await fetcher();
      cache.set(key, { result, expiresAt: Date.now() + ttlMs });
      return result;
    } catch (err) {
      if (entry) {
        console.warn(`[cache] ${key}: ${err.message}. Using stale cached value.`);
        return entry.result;
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, pending);
  return pending;
}

function getCachedTags(image) {
  const entry = tagCache.get(image);
  if (entry && Date.now() < entry.expiresAt) return entry.result;
  return undefined;
}

function setCachedTags(image, result) {
  tagCache.set(image, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

function clearCachedTags(image) {
  tagCache.delete(image);
}

function getGhcrLatestCacheKey(image) {
  return image.split("@")[0].toLowerCase();
}

function getCachedGhcrLatestCreated(cacheKey, allowExpired = false) {
  const entry = ghcrLatestCreatedCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() < entry.expiresAt) return entry.result;
  if (allowExpired) return entry.result;
  return undefined;
}

function setCachedGhcrLatestCreated(cacheKey, result) {
  if (GHCR_LATEST_CREATED_TTL_MS <= 0) return;
  ghcrLatestCreatedCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + GHCR_LATEST_CREATED_TTL_MS,
  });
}

/* ------------------------------------------------------------------ */
/*  Docker socket                                                     */
/* ------------------------------------------------------------------ */

const DOCKER_SOCKET = "/var/run/docker.sock";

// GET helper kept for back-compat with callers that just want the parsed
// JSON body. Doesn't enforce 2xx status codes — the daemon usually returns
// JSON even for error responses, and existing callers cope.
function dockerRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: "GET" },
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

// GET a Docker engine API path and return the raw response body as a
// Buffer (for non-JSON endpoints like /logs).
function dockerRequestRaw(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Docker's /logs endpoint returns a multiplexed stream when the container
// runs without a TTY: 8-byte frame headers (1B stream type, 3B zero, 4B
// big-endian payload size) interleaved with the payload. With a TTY it's
// plain text. Detect framing from the first header and decode accordingly.
function demuxDockerLogStream(buf) {
  const looksFramed =
    buf.length >= 8 &&
    buf[0] <= 2 &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0;
  if (!looksFramed) return buf.toString("utf8");

  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.slice(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out;
}
// Returns parsed JSON on success, null for empty 2xx (e.g. 204 from /start).
// Used for state-changing calls where a 304/4xx/5xx must surface as an error.
function dockerApi(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...extraHeaders };
    if (data !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }

    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method, headers },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!buf) return resolve(null);
            try {
              return resolve(JSON.parse(buf));
            } catch {
              return resolve(buf);
            }
          }
          let detail = buf;
          try {
            detail = JSON.parse(buf).message || buf;
          } catch {}
          reject(
            Object.assign(
              new Error(`Docker ${method} ${path} → ${res.statusCode}: ${detail}`),
              { statusCode: res.statusCode }
            )
          );
        });
      }
    );
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

// Split an image reference into the (name, tag) pair the /images/create
// endpoint expects. Handles registries with ports correctly — e.g.
// "registry:5000/foo:1.2" → name="registry:5000/foo", tag="1.2".
function splitImageTag(image) {
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const tagPos = noDigest.indexOf(":", lastSlash + 1);
  if (tagPos === -1) return { name: noDigest, tag: "latest" };
  return { name: noDigest.slice(0, tagPos), tag: noDigest.slice(tagPos + 1) };
}

// Build the X-Registry-Auth header value for private-registry pulls.
// Docker expects base64url(JSON) — URL-safe base64 of the credentials,
// WITH padding (some daemon versions reject the unpadded form even though
// it's technically valid base64url).
function makeRegistryAuth(image, pat) {
  if (!pat) return null;
  const serveraddress = image.startsWith("ghcr.io/") ? "ghcr.io" : null;
  if (!serveraddress) return null;
  // GHCR accepts any non-empty username paired with a PAT as password,
  // but the username most reliably understood across docker daemon
  // versions is the owner extracted from the image path.
  const owner = image.replace(/^ghcr\.io\//, "").split("/")[0] || "x-access-token";
  const auth = JSON.stringify({
    username: owner,
    password: pat,
    serveraddress,
  });
  return Buffer.from(auth)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Stream-pull an image via POST /images/create. The response is a stream
// of NDJSON status objects; the pull is complete when the stream closes.
// Any object with an `error` field means the pull failed even if the
// HTTP response itself was 200.
function dockerPullImage(image, registryAuth) {
  return new Promise((resolve, reject) => {
    const { name, tag } = splitImageTag(image);
    const path =
      `/images/create?fromImage=${encodeURIComponent(name)}` +
      `&tag=${encodeURIComponent(tag)}`;

    const headers = {};
    if (registryAuth) headers["X-Registry-Auth"] = registryAuth;

    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: "POST", headers },
      (res) => {
        let buf = "";
        const events = [];
        let streamError = null;

        res.on("data", (chunk) => {
          buf += chunk.toString();
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const obj = JSON.parse(line);
              events.push(obj);
              if (obj.error) streamError = obj.error;
            } catch {
              /* ignore non-JSON lines */
            }
          }
        });
        res.on("end", () => {
          if (buf.trim()) {
            try {
              const obj = JSON.parse(buf);
              events.push(obj);
              if (obj.error) streamError = obj.error;
            } catch {}
          }

          // The /images/create endpoint can fail in two distinct ways:
          //  - HTTP 200 with an `{"error": "..."}` event somewhere in the
          //    NDJSON stream (registry-side failure surfaced through the
          //    streaming protocol — most "denied", "manifest unknown" etc.).
          //  - Non-2xx HTTP status with a single JSON body usually shaped
          //    like `{"message": "..."}` (daemon-side failure: bad auth
          //    header parsing, DNS issue, daemon config, etc.).
          // We collapse both into one error message so the caller sees
          // something useful instead of just "HTTP 500".
          const httpFailed = res.statusCode < 200 || res.statusCode >= 300;
          if (streamError || httpFailed) {
            const fromMessage = events.find((e) => e?.message)?.message;
            const detail =
              streamError ||
              fromMessage ||
              (events.length
                ? JSON.stringify(events.slice(-3))
                : "<empty body>");
            return reject(
              new Error(
                `Pull failed for ${image} (HTTP ${res.statusCode}): ${detail}`
              )
            );
          }
          resolve(events);
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

function httpsGet(url, headers = {}, timeoutMs = REGISTRY_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    options.headers = { "User-Agent": "docker-status-api/1.0", ...headers };
    options.agent = HTTPS_KEEP_ALIVE_AGENT;

    const req = https.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsGet(res.headers.location, headers, timeoutMs)
            .then(resolve)
            .catch(reject);
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
            resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
          } catch (e) {
            reject(new Error(`JSON parse error for ${url}: ${e.message}`));
          }
        });
      });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTPS timeout after ${timeoutMs}ms (${url})`));
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Generic HTTP helpers (for proxying /update and /logs)             */
/* ------------------------------------------------------------------ */

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout requesting ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      }
    );

    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error(`Timeout proxying update request to ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Docker Hub                                                        */
/* ------------------------------------------------------------------ */

// Returns [{ name, digest }] where `digest` is the manifest-list digest
// the tag points to (or null if the registry didn't supply one). The
// digest is what we match against the local image's RepoDigest to refine
// installed-version detection — see findCurrentVersionByDigest.
async function fetchDockerHubTags(repo, name) {
  const url = `https://hub.docker.com/v2/repositories/${repo}/${name}/tags?page_size=100&ordering=last_updated`;
  const { body } = await httpsGet(url);
  if (!Array.isArray(body.results)) return [];
  return body.results.map((t) => ({ name: t.name, digest: t.digest || null }));
}

/* ------------------------------------------------------------------ */
/*  GHCR                                                              */
/* ------------------------------------------------------------------ */

// Get an anonymous pull token for public GHCR repos.
async function fetchGhcrAnonToken(repo, name, timeoutMs = REGISTRY_HTTP_TIMEOUT_MS) {
  const url = `https://ghcr.io/token?scope=repository:${repo}/${name}:pull&service=ghcr.io`;
  const { body } = await httpsGet(url, {}, timeoutMs);
  return body.token || body.access_token || null;
}

// Get a Bearer token using a PAT (for private repos or manifest access).
// GHCR accepts PATs as password in Basic auth to exchange for a Bearer token.
async function fetchGhcrBearerToken(
  repo,
  name,
  pat,
  timeoutMs = REGISTRY_HTTP_TIMEOUT_MS
) {
  const url = `https://ghcr.io/token?scope=repository:${repo}/${name}:pull&service=ghcr.io`;
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  const { body } = await httpsGet(
    url,
    { Authorization: `Basic ${basic}` },
    timeoutMs
  );
  return body.token || body.access_token || null;
}

// GHCR's tags/list is unusable for "what's the newest version": it
// paginates in insertion order (oldest first) and repos that tag every
// commit (immich: 100k+ tags) would need a ~150-request walk to reach the
// newest tags. Instead, the latest version for a GHCR image comes from:
//   1. The GitHub releases API of the image's source repo (from the
//      org.opencontainers.image.source label) — one request, and immich's
//      two containers share the same repo so they share one lookup.
//   2. Fallback: the org.opencontainers.image.version annotation on the
//      remote manifest of the tag we'd pull. This is the newest build OF
//      THAT TAG (e.g. "v2" → "v2.7.5"), so it misses newer major series,
//      but it needs no GitHub release to exist.

// "https://github.com/owner/repo[/...]" → "owner/repo", else null.
function parseGitHubRepo(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const u = new URL(sourceUrl);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const [owner, repo] = u.pathname.replace(/^\//, "").split("/");
    if (!owner || !repo) return null;
    return `${owner}/${repo.replace(/\.git$/, "")}`;
  } catch {
    return null;
  }
}

// Latest (non-prerelease, non-draft) release tag of a GitHub repo, or null
// when the repo has no releases. Anonymous rate limit is 60/hr — fine with
// the 10-minute per-repo cache, and cachedLookup falls back to the stale
// value if we do get throttled.
async function fetchGitHubLatestReleaseTag(repoSlug) {
  const { status, body } = await httpsGet(
    `https://api.github.com/repos/${repoSlug}/releases/latest`,
    { Accept: "application/vnd.github+json" }
  );
  if (status === 404) return null; // repo has no releases
  if (status !== 200) {
    throw new Error(`GitHub releases API for ${repoSlug} returned HTTP ${status}`);
  }
  const tag = body?.tag_name;
  if (!tag || guessTagPattern(tag) === "unknown") return null;
  return tag;
}

// Version annotation + manifest digest of one specific remote GHCR tag.
// The digest is the same one RepoDigests records locally after a pull, so
// comparing them tells whether pulling this tag would download anything.
async function fetchGhcrManifestInfo(repo, name, tag, pat) {
  const token = pat
    ? await fetchGhcrBearerToken(repo, name, pat)
    : await fetchGhcrAnonToken(repo, name);
  if (!token) throw new Error(`Could not get GHCR token for ${repo}/${name}`);

  const accept = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ].join(",");

  const { status, body, headers } = await httpsGet(
    `https://ghcr.io/v2/${repo}/${name}/manifests/${encodeURIComponent(tag)}`,
    { Authorization: `Bearer ${token}`, Accept: accept }
  );
  if (status !== 200) return null;

  let version = body?.annotations?.["org.opencontainers.image.version"] || null;
  if (
    version &&
    (NON_VERSION_TAGS.has(version.toLowerCase()) ||
      guessTagPattern(version) === "unknown")
  ) {
    version = null;
  }
  return { version, digest: headers?.["docker-content-digest"] || null };
}

async function getGhcrManifestInfoCached(image, pat) {
  const { repo, name } = parseGhcrImage(image);
  const tag = extractTag(image);
  return cachedLookup(
    latestVersionCache,
    latestVersionInFlight,
    `ghcr-manifest:${repo}/${name}:${tag}`,
    CACHE_TTL_MS,
    () => fetchGhcrManifestInfo(repo, name, tag, pat)
  );
}

// Resolve the latest available version for a GHCR image. Returns a version
// string or null when nothing trustworthy was found.
async function getGhcrLatestVersion(image, sourceUrl, pat) {
  const repoSlug = parseGitHubRepo(sourceUrl);
  if (repoSlug) {
    const releaseTag = await cachedLookup(
      latestVersionCache,
      latestVersionInFlight,
      `github-release:${repoSlug}`,
      CACHE_TTL_MS,
      () => fetchGitHubLatestReleaseTag(repoSlug)
    );
    if (releaseTag) return releaseTag;
  }

  const info = await getGhcrManifestInfoCached(image, pat);
  return info?.version || null;
}

// Fetch the creation timestamp of the latest manifest from GHCR.
// Returns ISO 8601 truncated to seconds (e.g. "2026-05-07T09:06:30") or null.
// Used for date-based images (e.g. personal repos without semver tags) where
// multiple builds per day need to be distinguishable.
//
// Resolution order:
//   1. OCI annotation on the manifest (cheap; depends on build pipeline)
//   2. `created` field inside the image's config blob (always set by buildkit)
async function fetchGhcrLatestCreated(
  repo,
  name,
  pat,
  timeoutMs = GHCR_LATEST_CHAIN_TIMEOUT_MS
) {
  const startedAt = Date.now();
  const remainingMs = () => {
    const left = timeoutMs - (Date.now() - startedAt);
    if (left <= 0) {
      throw new Error(
        `GHCR latest check timed out for ${repo}/${name} after ${timeoutMs}ms`
      );
    }
    return left;
  };

  const token = await fetchGhcrBearerToken(repo, name, pat, remainingMs());
  if (!token) throw new Error(`Could not get GHCR token for ${repo}/${name}`);

  // Accept both single image manifests AND image indexes (multi-arch lists),
  // otherwise multi-arch images return 404 with the wrong Accept header.
  const acceptManifest = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ].join(",");

  const manifestUrl = `https://ghcr.io/v2/${repo}/${name}/manifests/latest`;
  const { body: top } = await httpsGet(manifestUrl, {
    Authorization: `Bearer ${token}`,
    Accept: acceptManifest,
  }, remainingMs());

  // If we got back a manifest list / image index, follow it to one
  // platform-specific manifest before reading any annotations or the config.
  let manifest = top;
  if (Array.isArray(top?.manifests) && top.manifests.length > 0) {
    const pick =
      top.manifests.find(
        (m) =>
          m.platform &&
          m.platform.os === "linux" &&
          m.platform.architecture === "amd64"
      ) ||
      top.manifests.find(
        (m) => m.platform && m.platform.architecture && m.platform.architecture !== "unknown"
      ) ||
      top.manifests[0];

    const { body: inner } = await httpsGet(
      `https://ghcr.io/v2/${repo}/${name}/manifests/${pick.digest}`,
      { Authorization: `Bearer ${token}`, Accept: acceptManifest },
      remainingMs()
    );
    manifest = inner;
  }

  // 1) OCI annotation on the image manifest (cheapest path).
  const annotation = manifest?.annotations?.["org.opencontainers.image.created"];
  if (annotation) return annotation.slice(0, 19);

  // 2) Fetch the config blob — its `created` field is set by Docker buildkit
  //    on every build, so this is the reliable fallback.
  const configDigest = manifest?.config?.digest;
  if (!configDigest) return null;

  const { body: config } = await httpsGet(
    `https://ghcr.io/v2/${repo}/${name}/blobs/${configDigest}`,
    { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.config.v1+json,application/vnd.docker.container.image.v1+json,application/json" },
    remainingMs()
  );

  const created =
    config?.created ||
    config?.config?.Labels?.["org.opencontainers.image.created"] ||
    null;

  return created ? created.slice(0, 19) : null;
}

async function getGhcrLatestCreatedCached(image, repo, name, pat) {
  const cacheKey = getGhcrLatestCacheKey(image);

  const cached = getCachedGhcrLatestCreated(cacheKey);
  if (cached !== undefined) {
    return { value: cached, source: "cache" };
  }

  if (ghcrLatestCreatedInFlight.has(cacheKey)) {
    return ghcrLatestCreatedInFlight.get(cacheKey);
  }

  const pending = (async () => {
    try {
      const value = await fetchGhcrLatestCreated(
        repo,
        name,
        pat,
        GHCR_LATEST_CHAIN_TIMEOUT_MS
      );
      setCachedGhcrLatestCreated(cacheKey, value);
      return { value, source: "remote" };
    } catch (err) {
      const stale = getCachedGhcrLatestCreated(cacheKey, true);
      if (stale !== undefined) {
        console.warn(
          `[ghcr-cache] ${repo}/${name}: ${err.message}. Using stale cached value.`
        );
        return { value: stale, source: "stale-cache" };
      }
      throw err;
    } finally {
      ghcrLatestCreatedInFlight.delete(cacheKey);
    }
  })();

  ghcrLatestCreatedInFlight.set(cacheKey, pending);
  return pending;
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

function sanitizeHttpUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function hasCustomRegistryPrefix(image) {
  const noDigest = image.split("@")[0];
  const firstSlash = noDigest.indexOf("/");
  if (firstSlash === -1) return false;

  const firstSegment = noDigest.slice(0, firstSlash);
  if (firstSegment === "docker.io" || firstSegment === "index.docker.io") {
    return false;
  }

  return (
    firstSegment.includes(".") ||
    firstSegment.includes(":") ||
    firstSegment === "localhost"
  );
}

function guessGitHubSourceFromImage(image) {
  if (image.startsWith("ghcr.io/")) {
    const { repo, name } = parseGhcrImage(image);
    if (!repo || !name) return null;
    return `https://github.com/${repo}/${name}`;
  }

  if (hasCustomRegistryPrefix(image)) return null;

  const { repo, name } = parseDockerHubImage(image);
  if (!repo || repo === "library" || !name) return null;
  return `https://github.com/${repo}/${name}`;
}

function extractSourceUrlFromImageInfo(imageInfo, image) {
  const labels = imageInfo?.Config?.Labels ?? {};
  const candidates = [
    labels["org.opencontainers.image.source"],
    labels["org.label-schema.vcs-url"],
    labels["org.opencontainers.image.url"],
    labels["org.label-schema.url"],
  ];

  for (const candidate of candidates) {
    const safe = sanitizeHttpUrl(candidate);
    if (safe) return safe;
  }

  return guessGitHubSourceFromImage(image);
}

function extractVersionFromLabels(imageInfo, skipOciVersion = false) {
  const labels = imageInfo?.Config?.Labels ?? {};
  const version = skipOciVersion
    ? labels["org.label-schema.version"] || labels["version"] || null
    : labels["org.opencontainers.image.version"] ||
      labels["org.label-schema.version"] ||
      labels["version"] ||
      null;
  // Ignore label if author wrote "latest" or similar as version
  if (version && NON_VERSION_TAGS.has(version.toLowerCase())) return null;
  // Some images ship garbage in the version label (e.g. lissy93/
  // networking-toolbox publishes "ghcr.io-lissy93-networking-toolbox-latest").
  // Only trust values that actually look like a version — semver-ish or
  // date-based, i.e. starting with digits after an optional "v".
  if (version && guessTagPattern(version) === "unknown") return null;
  return version;
}

// Fallback: use image creation timestamp as version, truncated to seconds
// (e.g. "2026-04-28T19:05:54"). Truncating to the date alone collapses
// multiple same-day builds to the same version, which makes them look
// identical in the UI and breaks the "is the remote newer?" comparison.
// Useful for projects like metube — and any private repo that ships
// multiple builds per day under :latest — where date-based tags are used
// but no semver label is set.
function extractCreatedFromImageInfo(imageInfo) {
  const created = imageInfo?.Created; // e.g. "2026-04-28T19:05:54.350040342Z"
  if (!created) return null;
  return created.slice(0, 19); // → "2026-04-28T19:05:54"
}

function extractComposeDir(containerLabels, imageInfo) {
  const imageLabels = imageInfo?.Config?.Labels ?? {};

  // 1) Explicit override label. Set on the container (preferred, via
  //    `services.X.labels` in compose) or baked into the image. This wins
  //    over the standard compose label, because the whole point of adding
  //    the override is to provide a path that THIS container can chdir
  //    into — typically a Linux-form path like "/c/Docker/foo" — instead
  //    of the host-native "C:\\Docker\\foo" that Compose v2 records.
  const override =
    containerLabels?.["com.docker-status-api.compose-dir"] ||
    imageLabels["com.docker-status-api.compose-dir"];
  if (override) return override;

  // 2) Standard compose label — present on all compose containers, but
  //    written in host-native form (e.g. "C:\\Docker\\foo" on Windows),
  //    which is generally not directly usable as cwd from inside this
  //    Linux container. Prefer the override above when paths need
  //    translating.
  return containerLabels?.["com.docker.compose.project.working_dir"] || null;
}

/* ------------------------------------------------------------------ */
/*  Tag resolution                                                    */
/* ------------------------------------------------------------------ */

// Fetch (and cache) the registry's tag list for a Docker Hub image as
// [{ name, digest }]. GHCR images don't use this — their latest version
// comes from getGhcrLatestVersion (see the comment there for why).
// Caching is per image because different tag lookups for the same image
// (latest-detection, current-version refinement) can share the same
// fetched list.
async function getRegistryTags(image) {
  if (hasDigest(image)) return [];

  const cached = getCachedTags(image);
  if (cached !== undefined) return cached;

  if (registryTagsInFlight.has(image)) {
    return registryTagsInFlight.get(image);
  }

  const pending = (async () => {
    const { repo, name } = parseDockerHubImage(image);
    const tags = await fetchDockerHubTags(repo, name);
    setCachedTags(image, tags);
    return tags;
  })();

  registryTagsInFlight.set(image, pending);
  try {
    return await pending;
  } finally {
    registryTagsInFlight.delete(image);
  }
}

// Pure: pick the highest-versioned tag that matches the same versioning
// pattern as the installed one (so we don't compare 1.2.3 to 20240501).
function findLatestVersionTag(tags, installedVersion) {
  const pattern = guessTagPattern(installedVersion);
  const candidates = tags
    .filter((t) => isVersionTag(t.name))
    .filter((t) => pattern === "unknown" || guessTagPattern(t.name) === pattern)
    .map((t) => t.name)
    // Tie-break equal versions by shorter name so the plain tag wins over
    // suffixed variants ("v3.0.1" over "v3.0.1-cuda" / "v3.0.1-rocm").
    .sort((a, b) => compareVersions(a, b) || a.length - b.length);
  return candidates.length > 0 ? candidates[0] : null;
}

// Read the local image's manifest-list (or per-platform manifest) digest
// out of `RepoDigests`. That's the same digest a registry exposes per
// tag, so it's the linker between "what we have on disk" and "which tag
// names point to it".
function extractRepoDigest(imageInfo, image) {
  const repoDigests = imageInfo?.RepoDigests || [];
  if (repoDigests.length === 0) return null;

  // Strip tag and digest off the image reference to get just the repo.
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const colonAfterSlash = noDigest.indexOf(":", lastSlash + 1);
  const repo = colonAfterSlash === -1 ? noDigest : noDigest.slice(0, colonAfterSlash);

  const match = repoDigests.find((rd) => rd.startsWith(repo + "@")) || repoDigests[0];
  const atPos = match.lastIndexOf("@");
  return atPos !== -1 ? match.slice(atPos + 1) : null;
}

// Pure: from a list of tags with digests, return the most specific
// version-shaped tag that points to `localDigest`. "Most specific" =
// most version components (e.g. "4.0.6" beats "4.0" beats "4"); on a
// tie, the longer string (so "v4.0.6" beats "4.0.6" only if a maintainer
// publishes both, which is fine — they're equivalent labels for us).
//
// Returns null when the registry didn't expose digests (GHCR), the local
// image has no RepoDigest (locally-built), or no matching tag exists.
function findCurrentVersionByDigest(tags, localDigest) {
  if (!localDigest) return null;

  const matches = tags.filter(
    (t) => t.digest && t.digest === localDigest && isVersionTag(t.name)
  );
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const lenA = parseVersion(a.name).length;
    const lenB = parseVersion(b.name).length;
    if (lenA !== lenB) return lenB - lenA;
    return b.name.length - a.name.length;
  });
  return matches[0].name;
}

/* ------------------------------------------------------------------ */
/*  Core: resolve one raw Docker container object → our format        */
/* ------------------------------------------------------------------ */

async function resolveContainer(c, onTiming = null) {
  const name = c.Names[0].replace(/^\//, "");
  const image = c.Image;
  const tagVersion = extractTag(image);
  const pat = getGhcrToken(image);
  const containerStart = process.hrtime.bigint();

  const recordTiming = (stage, ms, details = "") => {
    if (typeof onTiming === "function") {
      onTiming({ name, image, stage, ms, details });
    }
    const detailPrefix = `image=${image}`;
    const detailText = details ? `${detailPrefix} ${details}` : detailPrefix;
    logTiming(`[resolve:${name}]`, stage, ms, detailText);
  };

  console.log(`[resolve] ${name}: image=${image}, tagVersion=${tagVersion}, isVersionTag=${isVersionTag(tagVersion)}`);

  const inspectStart = process.hrtime.bigint();
  const imageInfo = await getImageInfo(c.ImageID);
  recordTiming("inspect-image", elapsedMs(inspectStart));

  const sourceStart = process.hrtime.bigint();
  const sourceUrl = extractSourceUrlFromImageInfo(imageInfo, image);
  recordTiming("extract-source-url", elapsedMs(sourceStart));

  // Updates work via the Docker engine API (pull + recreate) so we can
  // refresh anything that's referenced by tag — no compose dir / file
  // access required. Digest-pinned images can't be updated (nothing newer
  // to pull for an immutable reference), and neither can non-running
  // containers — the stop/remove/recreate flow assumes a running one.
  const updatable =
    !image.startsWith("sha256:") &&
    !image.includes("@sha256:") &&
    c.State === "running";

  let installedVersion = tagVersion;
  let installedFromCreated = false;
  const installedVersionStart = process.hrtime.bigint();

  if (!isVersionTag(tagVersion)) {
    console.log(`[resolve] ${name}: created=${imageInfo?.Created}, labels=${JSON.stringify(imageInfo?.Config?.Labels)}`);

    // For GHCR images with a PAT, skip org.opencontainers.image.version —
    // these repos often carry a base image version (e.g. "24.04") rather
    // than the actual app version. Fall straight through to timestamp-based.
    const skipOci = image.startsWith("ghcr.io/") && pat !== null;
    const labelVersion = extractVersionFromLabels(imageInfo, skipOci);

    if (labelVersion) {
      installedVersion = labelVersion;
      console.log(`[resolve] ${name}: installedVersion=${installedVersion} (from label)`);
    } else {
      const createdVersion = extractCreatedFromImageInfo(imageInfo);
      console.log(`[resolve] ${name}: createdVersion=${createdVersion}`);
      if (createdVersion) {
        installedVersion = createdVersion;
        installedFromCreated = true;
        console.log(`[resolve] ${name}: installedVersion=${installedVersion} (from creation timestamp)`);
      }
    }
  } else {
    // The tag is version-shaped but may be a coarse rolling tag — immich
    // publishes "v2" that tracks the whole major series. When the image's
    // version label refines the tag (label "v2.7.5" for tag "v2", i.e.
    // same version prefix with more components), prefer the label.
    const skipOci = image.startsWith("ghcr.io/") && pat !== null;
    const labelVersion = extractVersionFromLabels(imageInfo, skipOci);
    if (
      labelVersion &&
      normalizeTag(labelVersion).startsWith(normalizeTag(tagVersion) + ".")
    ) {
      installedVersion = labelVersion;
      console.log(`[resolve] ${name}: refined tag ${tagVersion} → ${installedVersion} via version label`);
    }
  }
  recordTiming(
    "resolve-installed-version",
    elapsedMs(installedVersionStart),
    `installed=${installedVersion} fromCreated=${installedFromCreated}`
  );

  let latestVersion = installedVersion;
  let updateAvailable = false;
  // Whether pulling the container's OWN tag would fetch a newer image —
  // that's what the /update endpoint actually does. Distinct from
  // updateAvailable: a container pinned to "v2" can't reach v3.0.1 by
  // pulling; that needs a tag change in the compose file. null = unknown
  // (falls back to updateAvailable in the response).
  let pullUpdateAvailable = null;
  let error = null;

  try {
    if (installedFromCreated && image.startsWith("ghcr.io/") && pat) {
      const remoteCreatedStart = process.hrtime.bigint();
      // Timestamp-based GHCR image with PAT — compare manifest creation timestamp
      const { repo, name: imgName } = parseGhcrImage(image);
      const { value: remoteCreated, source } = await getGhcrLatestCreatedCached(
        image,
        repo,
        imgName,
        pat
      );
      recordTiming(
        "fetch-ghcr-latest-created",
        elapsedMs(remoteCreatedStart),
        `source=${source}`
      );
      console.log(`[resolve] ${name}: remoteCreated=${remoteCreated}, installedCreated=${installedVersion}`);
      if (remoteCreated) {
        latestVersion = remoteCreated;
        // ISO 8601 strings sort lexicographically, so > works as expected.
        updateAvailable = remoteCreated > installedVersion;
      }
    } else if (!hasDigest(image) && detectRegistry(image) === "ghcr") {
      // GHCR: tag listing is impractical (see getGhcrLatestVersion), so
      // the latest version comes from the source repo's GitHub releases,
      // falling back to the remote manifest's version annotation.
      if (!installedFromCreated) {
        const ghcrLatestStart = process.hrtime.bigint();
        const latest = await getGhcrLatestVersion(image, sourceUrl, pat);
        recordTiming("fetch-ghcr-latest-version", elapsedMs(ghcrLatestStart));
        console.log(`[resolve] ${name}: ghcrLatest=${latest}, installed=${installedVersion}`);

        const installedPattern = guessTagPattern(installedVersion);
        if (
          latest &&
          (installedPattern === "unknown" || guessTagPattern(latest) === installedPattern)
        ) {
          latestVersion = latest;
          // Strictly newer only — a source repo's release can briefly lag
          // the images (or describe a different component), and "different"
          // must not read as "update available" here.
          updateAvailable = compareVersions(latest, installedVersion) < 0;
        }
      }

      // Same-tag pull check: compare the local image digest against the
      // remote manifest digest of the tag we'd pull.
      const digestStart = process.hrtime.bigint();
      const localDigest = extractRepoDigest(imageInfo, image);
      const manifestInfo = localDigest
        ? await getGhcrManifestInfoCached(image, pat).catch((e) => {
            console.warn(`[resolve] ${name}: manifest digest check failed: ${e.message}`);
            return null;
          })
        : null;
      if (manifestInfo?.digest && localDigest) {
        pullUpdateAvailable = manifestInfo.digest !== localDigest;
        updateAvailable = updateAvailable || pullUpdateAvailable;
      }
      recordTiming(
        "check-ghcr-manifest-digest",
        elapsedMs(digestStart),
        `pullUpdate=${pullUpdateAvailable}`
      );
    } else if (!hasDigest(image)) {
      // Docker Hub: tag-based comparison. Also entered for
      // timestamp-fallback images (":latest" with no usable version
      // label) — Docker Hub exposes per-tag digests, so we can still
      // decide update-availability by digest even when the installed
      // "version" is a creation timestamp.
      const registryTagsStart = process.hrtime.bigint();
      // Fetch tags once and use the same list for both the
      // installed-version refinement and the latest-version lookup — they
      // share a cache so this is one network call.
      const tags = await getRegistryTags(image);
      recordTiming("fetch-registry-tags", elapsedMs(registryTagsStart));

      const compareStart = process.hrtime.bigint();
      // Refine `installedVersion` if the registry tells us a more specific
      // tag points to our local image. Catches cases like Dashy where the
      // OCI label is "4.0" but the tag pointing to that exact digest is
      // "4.0.6".
      const localDigest = extractRepoDigest(imageInfo, image);
      const refined = findCurrentVersionByDigest(tags, localDigest);
      if (refined && refined !== installedVersion) {
        console.log(`[resolve] ${name}: refined ${installedVersion} → ${refined} via digest match`);
        installedVersion = refined;
        installedFromCreated = false;
      }

      if (installedFromCreated) {
        // Installed version is a creation timestamp — tag names can't be
        // compared against it, so compare digests of the pulled tag instead.
        const pulledTag = extractTag(image);
        const remoteDigest = tags.find((t) => t.name === pulledTag)?.digest || null;
        console.log(
          `[resolve] ${name}: digest compare tag=${pulledTag} local=${localDigest?.slice(7, 19) ?? "none"} remote=${remoteDigest?.slice(7, 19) ?? "none"}`
        );

        if (remoteDigest && localDigest && remoteDigest === localDigest) {
          // The tag still points at exactly what we're running.
          latestVersion = installedVersion;
          updateAvailable = false;
        } else {
          // Prefer the version tag sharing the remote tag's digest; fall
          // back to the highest version-shaped tag (some repos rebuild
          // "latest" without moving the version tags, so digests differ).
          const mapped = remoteDigest
            ? findCurrentVersionByDigest(tags, remoteDigest)
            : null;
          const latest = mapped || findLatestVersionTag(tags, installedVersion);
          if (latest) latestVersion = latest;
          updateAvailable = Boolean(
            remoteDigest && localDigest && remoteDigest !== localDigest
          );
        }
        // Here the comparison IS the same-tag pull check.
        pullUpdateAvailable = updateAvailable;
      } else {
        const latest = findLatestVersionTag(tags, installedVersion);
        console.log(`[resolve] ${name}: pattern=${guessTagPattern(installedVersion)}, latestFound=${latest}`);

        if (latest) {
          latestVersion = latest;
          updateAvailable = normalizeTag(latest) !== normalizeTag(installedVersion);
        }

        // Same-tag pull check via the digest Docker Hub exposes per tag
        // (a container pinned to e.g. "postgres:14" may have no newer
        // "14" build even though newer majors exist — and vice versa).
        const remoteDigest = tags.find((t) => t.name === extractTag(image))?.digest || null;
        if (remoteDigest && localDigest) {
          pullUpdateAvailable = remoteDigest !== localDigest;
          updateAvailable = updateAvailable || pullUpdateAvailable;
        }
      }
      recordTiming("compare-versions", elapsedMs(compareStart));
    }
  } catch (e) {
    console.error(`[version-check] ${image}: ${e.message}`);
    error = e.message;
  }

  const totalMs = elapsedMs(containerStart);
  recordTiming(
    "total",
    totalMs,
    `updateAvailable=${updateAvailable}${error ? " hasError=true" : ""}`
  );

  // Compose project (stack) this container belongs to, used by the
  // dashboard to group services of one stack into a single row.
  const project = c.Labels?.["com.docker.compose.project"] || null;

  return {
    name,
    status: c.State,
    // Human status line ("Up 3 hours (healthy)", "Exited (1) 2 hours ago")
    // — the dashboard derives health / exit-code coloring from it.
    ...(c.Status && { statusText: c.Status }),
    image,
    ...(project && { project }),
    ...(sourceUrl && { sourceUrl }),
    currentVersion: installedVersion,
    latestVersion,
    updateAvailable,
    // Unknown (null) degrades to updateAvailable so the button still
    // shows where we couldn't compare digests.
    pullUpdateAvailable: pullUpdateAvailable ?? updateAvailable,
    canUpdate: updatable,
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
        port: url.port,
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
  const requestId = Math.random().toString(36).slice(2, 8);
  const requestStart = process.hrtime.bigint();
  const perContainerTiming = new Map();

  const onContainerTiming = ({ name, stage, ms }) => {
    const current = perContainerTiming.get(name) || { totalMs: 0, stages: [] };
    if (stage === "total") {
      current.totalMs = ms;
    } else {
      current.stages.push({ stage, ms });
    }
    perContainerTiming.set(name, current);
  };

  try {
    const listStart = process.hrtime.bigint();
    // all=true: stopped/crashed containers stay visible (with a status
    // dot) instead of silently disappearing from the dashboard.
    const raw = await dockerRequest("/containers/json?all=true");
    logTiming(
      `[/containers:${requestId}]`,
      "docker-list",
      elapsedMs(listStart),
      `count=${raw.length}`
    );

    const filterStart = process.hrtime.bigint();
    const filtered = raw.filter((c) => {
      const name = c.Names[0].replace(/^\//, "");
      return !isExcluded(c.Image, name);
    });
    logTiming(
      `[/containers:${requestId}]`,
      "filter",
      elapsedMs(filterStart),
      `count=${filtered.length}`
    );

    const resolveStart = process.hrtime.bigint();
    const containers = await Promise.all(
      filtered.map((c) => resolveContainer(c, onContainerTiming))
    );
    logTiming(
      `[/containers:${requestId}]`,
      "resolve-all",
      elapsedMs(resolveStart),
      `count=${containers.length}`
    );

    const slowestContainers = [...perContainerTiming.entries()]
      .map(([name, data]) => ({
        name,
        totalMs: data.totalMs || data.stages.reduce((sum, stage) => sum + stage.ms, 0),
        topStages: [...data.stages].sort((a, b) => b.ms - a.ms).slice(0, 3),
      }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 5);

    for (const item of slowestContainers) {
      const topStagesText = item.topStages
        .map((stage) => `${stage.stage}=${stage.ms.toFixed(1)}ms`)
        .join(", ");
      logTiming(
        `[/containers:${requestId}]`,
        `slow-container ${item.name}`,
        item.totalMs,
        topStagesText ? `top=${topStagesText}` : ""
      );
    }

    logTiming(
      `[/containers:${requestId}]`,
      "request-total",
      elapsedMs(requestStart),
      `returned=${containers.length}`
    );

    res.json({ containers });
  } catch (err) {
    logTiming(`[/containers:${requestId}]`, "request-total", elapsedMs(requestStart), "status=500");
    console.error(`[/containers:${requestId}]`, err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  /all-containers — local + all remote servers merged               */
/* ------------------------------------------------------------------ */

app.get("/all-containers", async (req, res) => {
  async function fetchLocal() {
    const raw = await dockerRequest("/containers/json?all=true");
    const filtered = raw.filter((c) => {
      const name = c.Names[0].replace(/^\//, "");
      return !isExcluded(c.Image, name);
    });
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
/*  /update/:name — pull + restart a container via docker compose     */
/* ------------------------------------------------------------------ */

app.post("/update/:name", async (req, res) => {
  const { name } = req.params;
  const { server } = req.query; // ?server=nas or ?server=windows

  // If targeted at a remote server — proxy the request
  if (server && server !== LOCAL_LABEL) {
    const remote = REMOTE_SERVERS.find((s) => s.label === server);
    if (!remote) {
      return res.status(404).json({ error: `Unknown server: ${server}` });
    }
    try {
      console.log(`[update] Proxying update of ${name} to ${remote.label} (${remote.url})`);
      const { status, body } = await httpPost(`${remote.url}/update/${encodeURIComponent(name)}`);
      return res.status(status).json(body);
    } catch (e) {
      return res.status(502).json({ error: `Failed to proxy update to ${remote.label}: ${e.message}` });
    }
  }

  // Local update — Watchtower-style: pull the image via the Docker engine
  // API, then if the digest changed, recreate the container in place using
  // its existing Config + HostConfig + network attachments. No filesystem
  // access to the project's compose tree is required: the daemon socket is
  // the entire interface.
  const force = req.query.force === "1" || req.query.force === "true";

  try {
    const containers = await dockerRequest("/containers/json");
    const c = containers.find((c) =>
      c.Names.some((n) => n.replace(/^\//, "") === name)
    );
    if (!c) return res.status(404).json({ error: `Container not found: ${name}` });

    // Inspect the current container so we have its full config to recreate
    // with — env vars, ports, mounts, restart policy, networks, labels, etc.
    const inspect = await dockerRequest(`/containers/${c.Id}/json`);
    const image = inspect.Config.Image;

    if (image.startsWith("sha256:") || image.includes("@sha256:")) {
      return res.status(400).json({
        error: `Container ${name} pins an image by digest (${image}); ` +
          `there's no newer version to pull. Re-create it with a tag instead.`,
      });
    }

    // 1) Pull the image. For private GHCR repos we authenticate with the
    //    same PAT used elsewhere in this server.
    const pat = getGhcrToken(image);
    const auth = makeRegistryAuth(image, pat);
    console.log(`[update] ${name}: pulling ${image}${auth ? " (with auth)" : ""}`);
    await dockerPullImage(image, auth);

    // 2) Resolve the freshly-pulled tag to its image ID. If it matches the
    //    one the running container is using, there's nothing to do.
    const newImage = await dockerRequest(`/images/${encodeURIComponent(image)}/json`);
    const newImageId = newImage?.Id;
    const oldImageId = inspect.Image;

    if (newImageId && newImageId === oldImageId && !force) {
      console.log(`[update] ${name}: already on ${newImageId.slice(7, 19)}, no recreate`);
      clearCachedTags(image);
      return res.json({
        ok: true,
        name,
        recreated: false,
        imageId: newImageId,
        message: "Image already up to date — container left as-is.",
      });
    }

    // 3) Stop the old container (skip if it's not running anyway), then
    //    remove it. We free the name so the new container can claim it.
    if (inspect.State?.Running) {
      console.log(`[update] ${name}: stopping ${c.Id.slice(0, 12)}`);
      await dockerApi("POST", `/containers/${c.Id}/stop?t=10`);
    }
    console.log(`[update] ${name}: removing ${c.Id.slice(0, 12)}`);
    await dockerApi("DELETE", `/containers/${c.Id}?v=false`);

    // 4) Build the create body from the inspect data. Docker only allows
    //    one network in NetworkingConfig.EndpointsConfig at create time,
    //    so we pick the first and connect to any others after creation.
    const networks = inspect.NetworkSettings?.Networks ?? {};
    const networkNames = Object.keys(networks);
    const firstNetwork = networkNames[0];

    const createBody = {
      ...inspect.Config,
      HostConfig: inspect.HostConfig,
    };
    if (firstNetwork) {
      createBody.NetworkingConfig = {
        EndpointsConfig: { [firstNetwork]: networks[firstNetwork] },
      };
    }

    console.log(`[update] ${name}: creating new container`);
    const created = await dockerApi(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      createBody
    );
    const newId = created.Id;

    // 5) Connect remaining networks (compose stacks rarely have more than
    //    one, but we handle it for completeness).
    for (let i = 1; i < networkNames.length; i++) {
      const netName = networkNames[i];
      console.log(`[update] ${name}: connecting to network ${netName}`);
      await dockerApi(
        "POST",
        `/networks/${encodeURIComponent(netName)}/connect`,
        { Container: newId, EndpointConfig: networks[netName] }
      );
    }

    // 6) Start it.
    console.log(`[update] ${name}: starting ${newId.slice(0, 12)}`);
    await dockerApi("POST", `/containers/${newId}/start`);

    clearCachedTags(image);

    return res.json({
      ok: true,
      name,
      recreated: true,
      oldImageId,
      newImageId,
      newContainerId: newId,
    });
  } catch (e) {
    console.error(`[update] ${name}: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/*  /logs/:name — recent container logs (local or proxied to remote)  */
/* ------------------------------------------------------------------ */

app.get("/logs/:name", async (req, res) => {
  const { name } = req.params;
  const { server } = req.query;
  // Bounded: 1 hour to 7 days, default 24h. tail caps the volume for
  // chatty containers regardless of the window.
  const hours = Math.min(parsePositiveInt(req.query.hours, 24), 24 * 7);
  const TAIL_LINES = 1000;

  if (server && server !== LOCAL_LABEL) {
    const remote = REMOTE_SERVERS.find((s) => s.label === server);
    if (!remote) {
      return res.status(404).json({ error: `Unknown server: ${server}` });
    }
    try {
      const { status, body } = await httpGetJson(
        `${remote.url}/logs/${encodeURIComponent(name)}?hours=${hours}`
      );
      return res.status(status).json(body);
    } catch (e) {
      return res.status(502).json({
        error: `Failed to proxy logs from ${remote.label}: ${e.message}`,
      });
    }
  }

  try {
    // all=true so logs of stopped/crashed containers stay reachable —
    // that's exactly when they're most interesting.
    const containers = await dockerRequest("/containers/json?all=true");
    const c = containers.find((c) =>
      c.Names.some((n) => n.replace(/^\//, "") === name)
    );
    if (!c) return res.status(404).json({ error: `Container not found: ${name}` });

    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const { status, body } = await dockerRequestRaw(
      `/containers/${c.Id}/logs?stdout=true&stderr=true&timestamps=true` +
        `&since=${since}&tail=${TAIL_LINES}`
    );
    if (status !== 200) {
      return res.status(502).json({ error: `Docker logs request → HTTP ${status}` });
    }

    // Trim RFC3339 nanosecond timestamps down to seconds for readability.
    const logs = demuxDockerLogStream(body).replace(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z?\s?/gm,
      "$1 "
    );

    res.json({ name, hours, tail: TAIL_LINES, logs });
  } catch (err) {
    console.error(`[logs] ${name}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  /start | /stop | /restart /:name — container lifecycle control    */
/* ------------------------------------------------------------------ */

// The three lifecycle endpoints are identical apart from the Docker engine
// path they hit, so they're built from one factory. They mirror the
// remote-proxy pattern used by /update and /logs, and reuse dockerApi()
// (the same helper /update already uses to stop/start during a recreate).
function makeLifecycleHandler(verb, dockerPath) {
  return async (req, res) => {
    const { name } = req.params;
    const { server } = req.query;

    // Remote target → proxy. We call the remote WITHOUT a server param so it
    // treats the request as local, exactly like the /update proxy does.
    if (server && server !== LOCAL_LABEL) {
      const remote = REMOTE_SERVERS.find((s) => s.label === server);
      if (!remote) {
        return res.status(404).json({ error: `Unknown server: ${server}` });
      }
      try {
        const { status, body } = await httpPost(
          `${remote.url}/${verb}/${encodeURIComponent(name)}`
        );
        return res.status(status).json(body);
      } catch (e) {
        return res.status(502).json({
          error: `Failed to proxy ${verb} to ${remote.label}: ${e.message}`,
        });
      }
    }

    try {
      // all=true so a stopped container is still findable (needed for /start).
      const containers = await dockerRequest("/containers/json?all=true");
      const c = containers.find((c) =>
        c.Names.some((n) => n.replace(/^\//, "") === name)
      );
      if (!c) return res.status(404).json({ error: `Container not found: ${name}` });

      try {
        await dockerApi("POST", `/containers/${c.Id}${dockerPath}`);
        return res.json({ ok: true, name, action: verb });
      } catch (e) {
        // 304 = already started (start) / already stopped (stop): benign no-op.
        if (e.statusCode === 304) {
          return res.json({ ok: true, name, action: verb, noop: true });
        }
        throw e;
      }
    } catch (err) {
      console.error(`[${verb}] ${name}: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  };
}

app.post("/start/:name", makeLifecycleHandler("start", "/start"));
app.post("/stop/:name", makeLifecycleHandler("stop", "/stop?t=10"));
app.post("/restart/:name", makeLifecycleHandler("restart", "/restart?t=10"));

/* ------------------------------------------------------------------ */
/*  /logs-view/:name — standalone log window (opened via window.open) */
/* ------------------------------------------------------------------ */

// The dashboard is embedded as an iframe inside Dashy, so an in-page modal
// gets clipped to the iframe. Logs instead open in a real separate window
// pointed at this route. Being same-origin as /dashboard, the page can
// fetch the existing /logs endpoint itself (with a refresh + time window).
app.get("/logs-view/:name", (req, res) => {
  const name = req.params.name;
  const server = typeof req.query.server === "string" ? req.query.server : "";

  const htmlEsc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  // Inject as JS string literals; escape "<" so a "</script>" inside a value
  // can't break out of the inline script.
  const jsName = JSON.stringify(name).replace(/</g, "\\u003c");
  const jsServer = JSON.stringify(server).replace(/</g, "\\u003c");
  const titleText = htmlEsc(server ? `${name} @ ${server}` : name);

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${titleText} — logs</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #16191f; color: #cdd6e4; height: 100vh; display: flex; flex-direction: column; }
    header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #2a3342; flex: none; }
    header .title { font-size: 13px; color: #cdd6e4; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header select, header button {
      background: #222a36; color: #cdd6e4; border: 1px solid #37415280;
      border-radius: 4px; padding: 3px 10px; font-size: 12px; cursor: pointer;
    }
    header button:hover, header select:hover { border-color: #86a6de; color: #fff; }
    pre {
      flex: 1; margin: 0; padding: 10px 12px; overflow: auto;
      font-size: 11px; line-height: 1.5; color: #c4cbd8;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <header>
    <span class="title">${titleText}</span>
    <select id="hours" title="Time window">
      <option value="1">1h</option>
      <option value="6">6h</option>
      <option value="24" selected>24h</option>
      <option value="168">7d</option>
    </select>
    <button id="refresh">Refresh</button>
  </header>
  <pre id="log">Loading...</pre>
  <script>
    var NAME = ${jsName};
    var SERVER = ${jsServer};
    var pre = document.getElementById('log');
    var hoursSel = document.getElementById('hours');
    document.title = (SERVER ? NAME + ' @ ' + SERVER : NAME) + ' — logs';

    function load() {
      pre.textContent = 'Loading...';
      var url = '/logs/' + encodeURIComponent(NAME) +
        '?server=' + encodeURIComponent(SERVER) +
        '&hours=' + encodeURIComponent(hoursSel.value);
      fetch(url).then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, statusText: r.statusText, data: data };
        });
      }).then(function (res) {
        if (!res.ok) {
          pre.textContent = 'Error: ' + (res.data.error || res.statusText);
          return;
        }
        pre.textContent = res.data.logs || '(no log output in the selected window)';
        pre.scrollTop = pre.scrollHeight;
      }).catch(function (e) {
        pre.textContent = 'Error: ' + e.message;
      });
    }

    document.getElementById('refresh').addEventListener('click', load);
    hoursSel.addEventListener('change', load);
    load();
  </script>
</body>
</html>`);
});

/* ------------------------------------------------------------------ */
/*  /dashboard — inline HTML widget for Dashy iframe                  */
/* ------------------------------------------------------------------ */

app.get("/dashboard", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; font-size: 13px; background: transparent; color: #e0e0e0; padding: 2px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 6px 8px; color: #888; font-weight: normal; border-bottom: 1px solid #333; }
    td { padding: 6px 8px; border-bottom: 1px solid #222; vertical-align: middle; }
    tr:hover td { background: #ffffff08; }
    .container-title {
      color: inherit;
      cursor: pointer;
      user-select: none;
    }
    .container-title::before {
      content: '▸';
      display: inline-block;
      margin-right: 5px;
      color: #6b7a95;
      font-size: 10px;
    }
    .container-title:hover { color: #ffffff; }
    .container-title:hover::before { color: #86a6de; }
    .container-title.expanded::before { content: '▾'; }
    .server { color: #7a8fff; font-size: 11px; margin-top: 2px; }
    .members { color: #8a97ab; font-size: 11px; margin-top: 2px; }
    .member { white-space: nowrap; }
    .vname { color: #8da0bf; font-size: 11px; }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
      flex: none;
    }
    .members .status-dot { width: 6px; height: 6px; margin-right: 4px; }
    .st-green { background: #4caf50; }
    .st-yellow { background: #ffb300; }
    .st-red { background: #f44336; }
    .st-gray { background: #7a7a7a; }
    .detail-row { display: none; }
    .detail-row.open { display: table-row; }
    .detail-row > td { background: #0f1218; border-bottom: 1px solid #222; }
    .detail-panel {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 4px 2px;
    }
    .detail-panel .sep {
      width: 1px;
      align-self: stretch;
      background: #2a3342;
      margin: 2px 4px;
    }
    .btn-cmd {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #222a36;
      color: #cdd6e4;
      border: 1px solid #37415280;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 12px;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }
    .btn-cmd:hover { border-color: #86a6de; color: #fff; }
    .btn-cmd:disabled { opacity: 0.4; cursor: not-allowed; border-color: #37415280; color: #cdd6e4; }
    .btn-start:not(:disabled) { border-color: #4caf5080; color: #7fd684; }
    .btn-start:not(:disabled):hover { border-color: #4caf50; color: #b6f0b9; }
    .btn-stop:not(:disabled) { border-color: #f4433680; color: #ef8a82; }
    .btn-stop:not(:disabled):hover { border-color: #f44336; color: #ffb0aa; }
    .ok { color: #4caf50; }
    .update-badge { color: #ff9800; font-weight: bold; }
    .btn-update {
      background: #ff9800;
      color: #000;
      border: none;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 12px;
      cursor: pointer;
      font-weight: bold;
    }
    .btn-update:disabled {
      background: #555;
      color: #888;
      cursor: not-allowed;
    }
    .spinner { display: inline-block; animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .toast {
      position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
      background: #333; color: #fff; padding: 8px 16px; border-radius: 6px;
      font-size: 12px; opacity: 0; transition: opacity 0.3s;
      pointer-events: none;
    }
    .toast.show { opacity: 1; }
    .toast.error { background: #c62828; }

    .version {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 200px;
      display: block;
    }

    @media (max-width: 700px) {
      body {
        padding: 2px;
        font-size: 12px;
      }

      thead {
        display: none;
      }

      table,
      tbody,
      tr,
      td {
        display: block;
        width: 100%;
      }

      tr {
        border: 1px solid #2a3342;
        border-radius: 8px;
        margin-bottom: 10px;
        overflow: hidden;
        background: #ffffff05;
      }

      tr:hover td {
        background: transparent;
      }

      td {
        border-bottom: 1px solid #1f2734;
        padding: 8px 10px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      td:last-child {
        border-bottom: none;
      }

      td[data-label]::before {
        content: attr(data-label);
        color: #8da0bf;
        font-size: 10px;
        font-weight: bold;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        flex: 0 0 78px;
        margin-top: 3px;
      }

      td[data-label="Container"] {
        display: block;
      }

      td[data-label="Container"]::before {
        display: block;
        margin: 0 0 4px 0;
      }

      .versions {
        flex: 1;
        min-width: 0;
      }

      .version {
        width: auto;
        max-width: 100%;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        text-align: right;
        overflow-wrap: anywhere;
      }

      .btn-update {
        padding: 4px 10px;
      }

      /* Detail row is its own block-level card in the mobile layout; pull it
         up so it reads as attached to the row it expands. */
      .detail-row.open { display: block; margin-top: -6px; }
      .detail-panel { align-items: stretch; }
      .detail-panel .sep { display: none; }
      .btn-cmd { justify-content: center; flex: 1 1 auto; }
    }
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
    <tbody id="tbody"><tr><td colspan="4" style="color:#555;padding:8px">Loading...</td></tr></tbody>
  </table>
  <div class="toast" id="toast"></div>

  <script>
    const API_BASE = '';

    function showToast(msg, isError = false) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => t.className = 'toast', 3000);
    }

    // Groups currently rendered; doUpdate() looks them up by index.
    let groups = [];

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    // One row per compose project (per server); containers without a
    // project label stay individual rows.
    function groupContainers(containers) {
      const map = new Map();
      for (const c of containers) {
        const key = c.server + '|' + (c.project || 'solo:' + c.name);
        if (!map.has(key)) {
          map.set(key, { server: c.server, title: c.project || c.name, containers: [] });
        }
        map.get(key).containers.push(c);
      }
      for (const g of map.values()) {
        // A project with a single (non-excluded) container reads better
        // under its precise container name.
        if (g.containers.length === 1) g.title = g.containers[0].name;
      }
      return [...map.values()];
    }

    function versionCell(g, field) {
      const unique = [...new Set(g.containers.map(c => c[field]))];
      const lines = unique.length === 1
        ? \`<div class='version'>\${esc(unique[0])}</div>\`
        : g.containers
            .map(c => \`<div class='version'><span class='vname'>\${esc(c.name)}:</span> \${esc(c[field])}</div>\`)
            .join('');
      return \`<div class='versions'>\${lines}</div>\`;
    }

    // Map a container's state (+ health / exit code when present) to a
    // dot color: green=running, yellow=starting/transitional,
    // red=faulted, gray=cleanly stopped.
    function statusColor(c) {
      const s = (c.status || '').toLowerCase();
      const text = (c.statusText || '').toLowerCase();
      if (s === 'running') {
        if (text.includes('unhealthy')) return 'red';
        if (text.includes('health: starting')) return 'yellow';
        return 'green';
      }
      if (s === 'restarting' || s === 'created') return 'yellow';
      if (s === 'dead') return 'red';
      if (s === 'exited') {
        const m = /exited \\((\\d+)\\)/.exec(text);
        const code = m ? parseInt(m[1], 10) : 0;
        // 130/137/143 = stopped via SIGINT/SIGKILL/SIGTERM (docker stop)
        return code === 0 || code === 130 || code === 137 || code === 143
          ? 'gray' : 'red';
      }
      return 'gray'; // paused, removing, unknown
    }

    const STATUS_SEVERITY = { green: 0, gray: 1, yellow: 2, red: 3 };

    function statusDot(color, title) {
      return \`<span class="status-dot st-\${color}" title="\${esc(title)}"></span>\`;
    }

    // Container names are [a-zA-Z0-9_.-], so embedding them in the inline
    // onclick handlers below is safe once HTML-escaped.

    // Clicking a row's title toggles the supplemental detail row beneath it.
    function toggleDetail(idx, el) {
      const row = document.getElementById('detail-' + idx);
      if (!row) return;
      el.classList.toggle('expanded', row.classList.toggle('open'));
    }

    // Logs open in a real separate window — the dashboard is an iframe inside
    // Dashy, so an in-page panel would be clipped. One window per container,
    // reused/focused on repeat clicks via a stable window name.
    function openLogs(name, server) {
      const url = \`\${API_BASE}/logs-view/\${encodeURIComponent(name)}?server=\${encodeURIComponent(server)}\`;
      const winName = 'logs_' + (name + '_' + server).replace(/[^a-zA-Z0-9_]/g, '_');
      const w = window.open(url, winName, 'width=1000,height=720,scrollbars=yes,resizable=yes');
      if (w) w.focus();
      else showToast('Popup blocked — allow pop-ups for this dashboard', true);
    }

    // Whole-project lifecycle action. start → non-running members;
    // stop → running members; restart → all members. Sequential, because a
    // stack's members share networks/volumes and parallel changes get racy
    // (same reason doUpdate is sequential).
    async function groupAction(idx, action, btn) {
      const g = groups[idx];
      if (!g) return;
      const targets = action === 'start'
        ? g.containers.filter(c => c.status !== 'running')
        : action === 'stop'
          ? g.containers.filter(c => c.status === 'running')
          : g.containers.slice();
      if (!targets.length) return;

      const panel = btn.closest('.detail-panel');
      const buttons = panel ? [...panel.querySelectorAll('button')] : [btn];
      buttons.forEach(b => b.disabled = true);

      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        const c = targets[i];
        btn.innerHTML = targets.length > 1
          ? \`<span class="spinner">⟳</span> \${i + 1}/\${targets.length}\`
          : '<span class="spinner">⟳</span>';
        try {
          const res = await fetch(\`\${API_BASE}/\${action}/\${encodeURIComponent(c.name)}?server=\${encodeURIComponent(c.server)}\`, {
            method: 'POST',
          });
          const data = await res.json();
          if (!res.ok) {
            failed++;
            showToast(\`\${c.name}: \${data.error || res.statusText}\`, true);
          }
        } catch (e) {
          failed++;
          showToast(\`\${c.name}: \${e.message}\`, true);
        }
      }

      if (!failed) {
        const verb = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted';
        showToast(\`\${g.title} \${verb}\`);
      }
      // Let Docker settle, then refresh (rebuilds rows, collapsing the panel).
      setTimeout(loadContainers, 1500);
    }

    // Pulling only helps when the container's own tag has a newer build;
    // old remote servers may not send pullUpdateAvailable yet.
    function canPullUpdate(c) {
      return (c.pullUpdateAvailable !== undefined ? c.pullUpdateAvailable : c.updateAvailable) && c.canUpdate;
    }

    // The expanded panel: whole-project lifecycle controls, the official-site
    // link (moved here from the title), and one log button per container.
    function detailPanel(g, idx) {
      const anyRunning = g.containers.some(c => c.status === 'running');
      const anyStopped = g.containers.some(c => c.status !== 'running');

      const cmd = (action, text, cls, enabled) =>
        \`<button class="btn-cmd \${cls}"\${enabled ? '' : ' disabled'} onclick="groupAction(\${idx}, '\${action}', this)">\${text}</button>\`;

      const controls = [
        cmd('start', '▶ Start', 'btn-start', anyStopped),
        cmd('stop', '■ Stop', 'btn-stop', anyRunning),
        cmd('restart', '⟳ Restart', 'btn-restart', g.containers.length > 0),
      ].join('');

      const sourceUrl = (g.containers.find(c => c.sourceUrl) || {}).sourceUrl;
      const linkBtn = sourceUrl
        ? \`<span class="sep"></span><a class="btn-cmd" href="\${esc(sourceUrl)}" target="_blank" rel="noopener">🔗 Open site</a>\`
        : '';

      const logBtns = g.containers
        .map(c => \`<button class="btn-cmd" onclick="openLogs('\${esc(c.name)}', '\${esc(c.server)}')">📄 Log \${esc(c.name)}</button>\`)
        .join('');

      return \`<div class="detail-panel">\${controls}\${linkBtn}<span class="sep"></span>\${logBtns}</div>\`;
    }

    function renderGroup(g, idx) {
      const frag = document.createDocumentFragment();
      const tr = document.createElement('tr');
      const updatable = g.containers.filter(canPullUpdate);
      const anyUpdate = g.containers.some(c => c.updateAvailable);

      const tagChangeNeeded = g.containers.some(
        c => c.updateAvailable && c.pullUpdateAvailable === false
      );
      const badgeTitle = tagChangeNeeded
        ? 'Newer release exists, but the image tag pins an older series - change the tag in the compose file to upgrade'
        : 'Update available, but this container cannot be updated in place';
      const badgeText = tagChangeNeeded ? '↑ tag change' : '↑ Yes';

      const countSuffix = g.containers.length > 1 && updatable.length ? \` (\${updatable.length})\` : '';
      const updateCell = updatable.length
        ? \`<button class="btn-update" onclick="doUpdate(\${idx}, this)">↑ Update\${countSuffix}</button>\`
        : anyUpdate
          ? \`<span class="update-badge" title="\${badgeTitle}">\${badgeText}</span>\`
          : \`<span class="ok">✓</span>\`;

      // Title is now a click-to-expand toggle; the official link moves into
      // the detail panel below.
      const label = \`<span class="container-title" onclick="toggleDetail(\${idx}, this)">\${esc(g.title)}</span>\`;

      // Group dot shows the worst member status; solo rows show their own.
      const worst = g.containers.reduce(
        (acc, c) => STATUS_SEVERITY[statusColor(c)] > STATUS_SEVERITY[acc.color]
          ? { color: statusColor(c), title: \`\${c.name}: \${c.statusText || c.status}\` }
          : acc,
        { color: statusColor(g.containers[0]), title: g.containers[0].statusText || g.containers[0].status }
      );
      const members = g.containers.length > 1
        ? \`<div class="members">\${g.containers
            .map(c => \`<span class="member">\${statusDot(statusColor(c), c.statusText || c.status)}\${esc(c.name)}</span>\`)
            .join(', ')}</div>\`
        : '';

      tr.innerHTML = \`
        <td data-label="Container">
          <div>\${statusDot(worst.color, worst.title)}\${label}</div>
          \${members}
          <div class="server">\${esc(g.server)}</div>
        </td>
        <td data-label="Current">\${versionCell(g, 'currentVersion')}</td>
        <td data-label="Latest">\${versionCell(g, 'latestVersion')}</td>
        <td data-label="Update">\${updateCell}</td>
      \`;

      const detail = document.createElement('tr');
      detail.className = 'detail-row';
      detail.id = 'detail-' + idx;
      detail.innerHTML = \`<td colspan="4">\${detailPanel(g, idx)}</td>\`;

      frag.appendChild(tr);
      frag.appendChild(detail);
      return frag;
    }

    function loadContainers() {
      fetch(API_BASE + '/all-containers')
        .then(r => r.json())
        .then(data => {
          const tbody = document.getElementById('tbody');
          tbody.innerHTML = '';
          // Faulted groups first, then groups with updates, then the rest.
          const rank = g =>
            (g.containers.some(c => statusColor(c) === 'red') ? 0 : 2) +
            (g.containers.some(c => c.updateAvailable) ? 0 : 1);
          groups = groupContainers(data.containers).sort((a, b) => rank(a) - rank(b));
          groups.forEach((g, i) => tbody.appendChild(renderGroup(g, i)));
        })
        .catch(e => {
          document.getElementById('tbody').innerHTML =
            \`<tr><td colspan="4" style="color:#f44336;padding:8px">Error: \${e.message}</td></tr>\`;
        });
    }

    // Updates every updatable container of the group, one at a time (they
    // may share networks/volumes — parallel recreates get racy).
    async function doUpdate(idx, btn) {
      const g = groups[idx];
      if (!g) return;
      const targets = g.containers.filter(canPullUpdate);
      btn.disabled = true;

      let failed = 0;
      let recreated = 0;
      for (let i = 0; i < targets.length; i++) {
        const c = targets[i];
        btn.innerHTML = targets.length > 1
          ? \`<span class="spinner">⟳</span> \${i + 1}/\${targets.length}\`
          : '<span class="spinner">⟳</span> Updating...';
        try {
          const res = await fetch(\`\${API_BASE}/update/\${encodeURIComponent(c.name)}?server=\${encodeURIComponent(c.server)}\`, {
            method: 'POST',
          });
          const data = await res.json();
          if (!res.ok) {
            failed++;
            showToast(\`\${c.name}: \${data.error || res.statusText}\`, true);
          } else if (data.recreated) {
            recreated++;
          }
        } catch (e) {
          failed++;
          showToast(\`\${c.name}: \${e.message}\`, true);
        }
      }

      if (!failed) {
        if (!recreated) {
          // The server pulled but found nothing new (recreated: false).
          showToast(\`\${g.title}: already up to date - nothing new to pull\`);
        } else if (targets.length > 1) {
          showToast(\`\${g.title}: updated \${recreated} of \${targets.length} containers\`);
        } else {
          showToast(\`\${g.title} updated successfully\`);
        }
      }
      // Small delay to let Docker settle after restart
      setTimeout(loadContainers, 2000);
    }

    loadContainers();
  </script>
</body>
</html>`);
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
      containerLabels: c.Labels ?? {},   // labels of the container
      imageLabels: imageInfo?.Config?.Labels ?? {},  // labels of the image
      created: imageInfo?.Created,
      composeDir: extractComposeDir(c.Labels, imageInfo),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Start                                                             */
/* ------------------------------------------------------------------ */

app.listen(3000, () => {
  console.log("Docker Status API running on port 3000");
  console.log(`Local label: ${LOCAL_LABEL}`);
  if (REMOTE_SERVERS.length > 0) {
    console.log("Remote servers:", REMOTE_SERVERS.map((s) => `${s.label}=${s.url}`).join(", "));
  } else {
    console.log("No remote servers configured (set REMOTE_SERVERS env var)");
  }
  if (EXCLUDE_IMAGES.length > 0) {
    console.log("Excluding images containing:", EXCLUDE_IMAGES.join(", "));
  }
});
