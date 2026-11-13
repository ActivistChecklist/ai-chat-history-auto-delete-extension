import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  CWS_SCOPE,
  crxZipPayload,
  TOKEN_URL,
  parseServiceAccountKey,
  buildServiceAccountJwt,
  describeGoogleError,
  getAccessToken,
  createWebStoreClient,
  knownVersions,
  summarizeStatus,
  uploadAndPublish
} from '../../scripts/lib/chrome-web-store.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = { clientEmail: 'publisher@project.iam.gserviceaccount.com', privateKey: PEM };

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** Records every call and answers from a queue of responses. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { impl, calls };
}

const revision = (version, state) => ({ state, distributionChannels: [{ deployPercentage: 100, crxVersion: version }] });

describe('parseServiceAccountKey', () => {
  it('reads the email and private key', () => {
    const json = JSON.stringify({ type: 'service_account', client_email: SA.clientEmail, private_key: PEM });
    expect(parseServiceAccountKey(json)).toEqual(SA);
  });

  it('rejects text that is not JSON without echoing it', () => {
    expect(() => parseServiceAccountKey('-----BEGIN PRIVATE KEY----- secret')).toThrow(/not valid JSON/);
    try {
      parseServiceAccountKey('-----BEGIN PRIVATE KEY----- secret');
    } catch (err) {
      expect(err.message).not.toMatch(/secret/);
    }
  });

  it('rejects JSON that is not a service account key', () => {
    expect(() => parseServiceAccountKey('{"type":"authorized_user"}')).toThrow(/service_account/);
  });
});

describe('buildServiceAccountJwt', () => {
  it('signs RS256 claims for the Web Store scope that verify with the public key', () => {
    const jwt = buildServiceAccountJwt(SA, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');
    const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(claims)).toEqual({
      iss: SA.clientEmail,
      scope: CWS_SCOPE,
      aud: TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600
    });
    const valid = crypto.verify('sha256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
    expect(valid).toBe(true);
  });
});

describe('describeGoogleError', () => {
  it('reads the token endpoint shape', () => {
    expect(describeGoogleError('{"error":"invalid_grant","error_description":"Invalid JWT"}'))
      .toBe('invalid_grant: Invalid JWT');
  });

  it('reads the API shape', () => {
    expect(describeGoogleError('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"No access"}}'))
      .toBe('PERMISSION_DENIED: No access');
  });

  it('keeps the API error details, which say why a package was rejected', () => {
    const text = JSON.stringify({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'The uploaded package was invalid.',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'PKG_INVALID_VERSION' }]
      }
    });
    const described = describeGoogleError(text);
    expect(described).toMatch(/^INVALID_ARGUMENT: The uploaded package was invalid\./);
    expect(described).toMatch(/details:[\s\S]*PKG_INVALID_VERSION/);
  });

  it('falls back to the raw text', () => {
    expect(describeGoogleError('Bad Gateway')).toBe('Bad Gateway');
  });
});

describe('getAccessToken', () => {
  it('posts a JWT bearer grant and returns the token', async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    await expect(getAccessToken(SA, { fetch: impl, now: () => 1_700_000_000_000 })).resolves.toBe('tok');
    expect(calls[0].url).toBe(TOKEN_URL);
    const body = new URLSearchParams(calls[0].init.body);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion').split('.')).toHaveLength(3);
  });

  it('explains a refused sign-in', async () => {
    const { impl } = fakeFetch(jsonResponse({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400));
    await expect(getAccessToken(SA, { fetch: impl })).rejects.toThrow(/HTTP 400.*invalid_grant: Invalid JWT Signature/);
  });
});

describe('createWebStoreClient', () => {
  it('calls the v2 endpoints for the publisher and item with the token', async () => {
    const { impl, calls } = fakeFetch(jsonResponse({}), jsonResponse({}), jsonResponse({}));
    const client = createWebStoreClient({ publisherId: 'pub1', itemId: 'item1', accessToken: 'tok', fetch: impl });
    await client.fetchStatus();
    await client.upload({ bytes: Buffer.from('crx'), fileName: 'pkg-1.1.1.crx' });
    await client.publish();

    expect(calls.map((c) => c.url)).toEqual([
      'https://chromewebstore.googleapis.com/v2/publishers/pub1/items/item1:fetchStatus',
      'https://chromewebstore.googleapis.com/upload/v2/publishers/pub1/items/item1:upload',
      'https://chromewebstore.googleapis.com/v2/publishers/pub1/items/item1:publish'
    ]);
    for (const c of calls) expect(c.init.headers.Authorization).toBe('Bearer tok');
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.headers['X-Goog-Upload-Protocol']).toBe('raw');
    expect(calls[1].init.headers['X-Goog-Upload-File-Name']).toBe('pkg-1.1.1.crx');
    expect(calls[1].init.body.toString()).toBe('crx');
  });
});

describe('crxZipPayload', () => {
  function crx({ magic = 'Cr24', formatVersion = 3, header = Buffer.from('signed-header'), zip = Buffer.from('PK-zip') } = {}) {
    const prefix = Buffer.alloc(12);
    prefix.write(magic, 0, 'ascii');
    prefix.writeUInt32LE(formatVersion, 4);
    prefix.writeUInt32LE(header.length, 8);
    return Buffer.concat([prefix, header, zip]);
  }

  it('returns the zip after the signed header', () => {
    expect(crxZipPayload(crx()).toString()).toBe('PK-zip');
  });

  it('rejects a file that is not a CRX', () => {
    expect(() => crxZipPayload(Buffer.from('PK\u0003\u0004 a plain zip'))).toThrow(/Not a CRX/);
  });

  it('rejects other CRX format versions', () => {
    expect(() => crxZipPayload(crx({ formatVersion: 2 }))).toThrow(/format version 2/);
  });

  it('rejects a header that runs past the end', () => {
    expect(() => crxZipPayload(crx({ zip: Buffer.alloc(0) }))).toThrow(/past the end/);
  });
});

describe('status helpers', () => {
  const status = {
    publishedItemRevisionStatus: revision('1.1.0', 'PUBLISHED'),
    submittedItemRevisionStatus: revision('1.1.1', 'PENDING_REVIEW')
  };

  it('lists published and in-review versions', () => {
    expect(knownVersions(status)).toEqual(['1.1.0', '1.1.1']);
  });

  it('summarizes each revision', () => {
    expect(summarizeStatus(status)).toEqual(['published: 1.1.0 (PUBLISHED)', 'submitted: 1.1.1 (PENDING_REVIEW)']);
    expect(summarizeStatus({})).toEqual(['nothing published or in review']);
  });
});

describe('uploadAndPublish', () => {
  function fakeClient({ status = {}, upload, polls = [], publish = { state: 'PENDING_REVIEW' } } = {}) {
    const calls = [];
    const statuses = [status, ...polls];
    return {
      calls,
      fetchStatus: async () => { calls.push('fetchStatus'); return statuses.shift() ?? {}; },
      upload: async () => { calls.push('upload'); return upload; },
      publish: async () => { calls.push('publish'); return publish; }
    };
  }
  const opts = { sleep: async () => {}, pollMs: 0 };
  const PKG = { bytes: Buffer.from('crx'), fileName: 'pkg.crx' };

  it('uploads, then submits for review', async () => {
    const client = fakeClient({
      status: { publishedItemRevisionStatus: revision('1.1.0', 'PUBLISHED') },
      upload: { uploadState: 'SUCCEEDED', crxVersion: '1.1.1' }
    });
    const result = await uploadAndPublish(client, PKG, '1.1.1', opts);
    expect(client.calls).toEqual(['fetchStatus', 'upload', 'publish']);
    expect(result.publish.state).toBe('PENDING_REVIEW');
  });

  it('refuses a version the store already has, before uploading', async () => {
    const client = fakeClient({ status: { submittedItemRevisionStatus: revision('1.1.1', 'PENDING_REVIEW') } });
    await expect(uploadAndPublish(client, PKG, '1.1.1', opts)).rejects.toThrow(/already has version 1\.1\.1/);
    expect(client.calls).toEqual(['fetchStatus']);
  });

  it('waits for an upload that is still processing', async () => {
    const client = fakeClient({
      upload: { uploadState: 'IN_PROGRESS' },
      polls: [{ lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }]
    });
    await uploadAndPublish(client, PKG, '1.1.1', opts);
    expect(client.calls).toEqual(['fetchStatus', 'upload', 'fetchStatus', 'fetchStatus', 'publish']);
  });

  it('gives up on an upload that never finishes processing', async () => {
    const client = fakeClient({
      upload: { uploadState: 'IN_PROGRESS' },
      polls: [{ lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }]
    });
    await expect(uploadAndPublish(client, PKG, '1.1.1', { ...opts, maxPolls: 2 }))
      .rejects.toThrow(/still processing/);
    expect(client.calls).not.toContain('publish');
  });

  it('stops on a failed upload without submitting', async () => {
    const client = fakeClient({ upload: { uploadState: 'FAILED' } });
    await expect(uploadAndPublish(client, PKG, '1.1.1', opts)).rejects.toThrow(/did not succeed \(state: FAILED\)/);
    expect(client.calls).not.toContain('publish');
  });

  it('stops when the store reads a different version from the package', async () => {
    const client = fakeClient({ upload: { uploadState: 'SUCCEEDED', crxVersion: '1.1.0' } });
    await expect(uploadAndPublish(client, PKG, '1.1.1', opts)).rejects.toThrow(/read version 1\.1\.0/);
    expect(client.calls).not.toContain('publish');
  });
});
