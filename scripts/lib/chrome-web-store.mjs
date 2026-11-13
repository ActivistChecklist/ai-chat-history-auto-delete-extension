/**
 * Chrome Web Store API (v2) client: service account sign-in, upload, publish and status.
 *
 * Kept free of process-level side effects, with fetch, the clock and sleep injected, so
 * the whole flow is unit-testable without network access or real credentials.
 *
 * Reference: https://developer.chrome.com/docs/webstore/using-api
 */
import crypto from 'node:crypto';

export const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://chromewebstore.googleapis.com';

const KEY_HELP = 'Store the whole JSON key file from Google Cloud in 1Password.';

/**
 * Pulls what sign-in needs out of a service account JSON key. Never echoes the input,
 * because it holds a private key.
 * @returns {{clientEmail: string, privateKey: string}}
 */
export function parseServiceAccountKey(json) {
  let key;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error(`The service account key is not valid JSON. ${KEY_HELP}`);
  }
  if (key?.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error(
      `The service account key needs "type": "service_account", "client_email" and "private_key". ${KEY_HELP}`
    );
  }
  return { clientEmail: key.client_email, privateKey: key.private_key };
}

/** The signed JWT Google exchanges for an access token (OAuth 2.0 JWT bearer grant). */
export function buildServiceAccountJwt({ clientEmail, privateKey }, nowSeconds) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: clientEmail,
    scope: CWS_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

/**
 * Google's two error shapes: the token endpoint's and the API's. The API's `details`
 * carry the actual reason (for example why a package was rejected), so they are kept.
 */
export function describeGoogleError(text) {
  try {
    const body = JSON.parse(text);
    if (typeof body.error === 'string') {
      return [body.error, body.error_description].filter(Boolean).join(': ');
    }
    if (body.error) {
      const summary = [body.error.status, body.error.message].filter(Boolean).join(': ');
      const details = body.error.details?.length
        ? `\n  details: ${JSON.stringify(body.error.details, null, 2).replace(/\n/g, '\n  ')}`
        : '';
      return summary + details;
    }
  } catch { /* not JSON; fall through to the raw text */ }
  return String(text ?? '').trim().slice(0, 500);
}

async function request(fetchImpl, url, init, what) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${what} failed (HTTP ${res.status}): ${describeGoogleError(text) || 'no details'}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function getAccessToken(serviceAccount, { fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const assertion = buildServiceAccountJwt(serviceAccount, Math.floor(now() / 1000));
  const json = await request(fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  }, 'Signing in with the service account');
  if (!json.access_token) throw new Error('Google returned no access token.');
  return json.access_token;
}

export function createWebStoreClient({ publisherId, itemId, accessToken, fetch: fetchImpl = fetch }) {
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const auth = { Authorization: `Bearer ${accessToken}` };
  return {
    fetchStatus: () => request(fetchImpl, `${API_ROOT}/v2/${name}:fetchStatus`, { headers: auth },
      'Reading the item status'),
    /** Uploads a signed CRX, which a listing with verified uploads requires. */
    upload: ({ bytes, fileName }) => request(fetchImpl, `${API_ROOT}/upload/v2/${name}:upload`, {
      method: 'POST',
      headers: { ...auth, 'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-File-Name': fileName },
      body: bytes
    }, 'Uploading the package'),
    publish: () => request(fetchImpl, `${API_ROOT}/v2/${name}:publish`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: '{}'
    }, 'Submitting for review')
  };
}

function revisionVersions(revision) {
  return (revision?.distributionChannels ?? []).map((c) => c.crxVersion).filter(Boolean);
}

/** Every version the store has published or has in review. */
export function knownVersions(status) {
  return [
    ...revisionVersions(status?.publishedItemRevisionStatus),
    ...revisionVersions(status?.submittedItemRevisionStatus)
  ];
}

/** Human-readable lines for a fetchStatus response. */
export function summarizeStatus(status) {
  const lines = [];
  for (const [label, revision] of [
    ['published', status?.publishedItemRevisionStatus],
    ['submitted', status?.submittedItemRevisionStatus]
  ]) {
    if (!revision) continue;
    const versions = revisionVersions(revision).join(', ') || 'unknown version';
    lines.push(`${label}: ${versions} (${revision.state ?? 'unknown state'})`);
  }
  if (status?.takenDown) lines.push('taken down: yes');
  if (status?.warned) lines.push('warned: yes');
  return lines.length ? lines : ['nothing published or in review'];
}

const hasState = (state, word) => typeof state === 'string' && state.includes(word);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The zip archive inside a CRX3 file. A CRX3 starts with "Cr24", the format version (3)
 * and the signed header's length, as little-endian 32-bit integers, then that header,
 * then the zip.
 */
export function crxZipPayload(crx) {
  if (crx.length < 12 || crx.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('Not a CRX file (it does not start with "Cr24").');
  }
  const formatVersion = crx.readUInt32LE(4);
  if (formatVersion !== 3) throw new Error(`Unsupported CRX format version ${formatVersion}; expected 3.`);
  const start = 12 + crx.readUInt32LE(8);
  if (start >= crx.length) throw new Error('The CRX header runs past the end of the file.');
  return crx.subarray(start);
}

/**
 * Uploads the package, waits for the store to process it, checks the version it read,
 * then submits it for review. Refuses a version the store already has, before uploading.
 * @param {{bytes: Buffer, fileName: string}} pkg
 */
export async function uploadAndPublish(client, pkg, version, {
  sleep = defaultSleep,
  pollMs = 3000,
  maxPolls = 40,
  log = () => {}
} = {}) {
  const before = await client.fetchStatus();
  if (knownVersions(before).includes(version)) {
    throw new Error(
      `The Web Store already has version ${version} (${summarizeStatus(before).join('; ')}). ` +
      'Release a new version first.'
    );
  }

  log('uploading');
  const upload = await client.upload(pkg);
  let state = upload.uploadState;
  for (let polls = 0; hasState(state, 'IN_PROGRESS'); polls++) {
    if (polls >= maxPolls) {
      throw new Error('The upload is still processing. Check on it later with `yarn publish:chrome --status`.');
    }
    log('processing');
    await sleep(pollMs);
    state = (await client.fetchStatus()).lastAsyncUploadState;
  }
  if (!hasState(state, 'SUCCEEDED')) {
    throw new Error(`The upload did not succeed (state: ${state ?? 'none'}). Response: ${JSON.stringify(upload)}`);
  }
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`The store read version ${upload.crxVersion} from the package, expected ${version}.`);
  }

  log('submitting');
  const publish = await client.publish();
  return { before, upload, publish };
}
