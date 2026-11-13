import { describe, it, expect } from 'vitest';
import { diagnoseSigning, signingRefProblem, formatSigningFailure, parseAccounts } from '../../scripts/lib/signing.mjs';

const ok = (out = '') => ({ status: 0, out, err: '' });
const fail = (err = 'boom') => ({ status: 1, out: '', err });

/** Happy-path runners; override individual ones per test. */
function runners(over = {}) {
  return {
    version: () => ok('2.34.0'),
    accountList: () => ok('[{"url":"my.1password.com"}]'),
    whoami: () => ok('user'),
    read: () => ok('-----BEGIN PRIVATE KEY-----'),
    readUnscoped: () => ok('-----BEGIN PRIVATE KEY-----'),
    ...over
  };
}

const REF = 'op://Vault/Item/private key';

describe('diagnoseSigning', () => {
  it('passes when every check succeeds', () => {
    expect(diagnoseSigning(REF, runners())).toEqual({ ok: true, ref: REF, account: null });
  });

  it('flags a missing reference and points at .env.example', () => {
    const d = diagnoseSigning(undefined, runners());
    expect(d.ok).toBe(false);
    expect(d.title).toMatch(/not set/);
    expect(d.steps.join('\n')).toMatch(/\.env\.example/);
  });

  it('flags a reference that is not an op:// URI', () => {
    const d = diagnoseSigning('/tmp/key.pem', runners());
    expect(d.ok).toBe(false);
    expect(d.title).toMatch(/op:\/\//);
  });

  it('flags op not being installed, with a platform-appropriate fix', () => {
    const d = diagnoseSigning(REF, runners({ version: () => fail('ENOENT') }), {
      platform: 'darwin'
    });
    expect(d.title).toMatch(/not installed/);
    expect(d.steps.join('\n')).toMatch(/brew install 1password-cli/);
  });

  it('does not suggest brew on non-mac', () => {
    const d = diagnoseSigning(REF, runners({ version: () => fail() }), { platform: 'linux' });
    expect(d.steps.join('\n')).not.toMatch(/brew/);
    expect(d.steps.join('\n')).toMatch(/developer\.1password\.com/);
  });

  // The bug this replaced: gating on `op whoami` blocked a perfectly working setup.
  // With the desktop-app integration there is no CLI session, so whoami reports
  // "account is not signed in" while `op read` succeeds via biometric prompt.
  it('passes when read works even though whoami fails', () => {
    const d = diagnoseSigning(REF, runners({
      whoami: () => fail('account is not signed in')
    }));
    expect(d).toEqual({ ok: true, ref: REF, account: null });
  });

  it.each([ok(''), ok('[]'), fail()])(
    'passes on an unhelpful account list when read works',
    (accountList) => {
      expect(diagnoseSigning(REF, runners({ accountList: () => accountList })).ok).toBe(true);
    }
  );

  it.each([ok(''), ok('[]'), fail()])(
    'reports "not connected" when read fails, whoami fails and no account is listed',
    (accountList) => {
      const d = diagnoseSigning(REF, runners({
        read: () => fail('account is not signed in'),
      readUnscoped: () => fail('account is not signed in'),
        whoami: () => fail('account is not signed in'),
        accountList: () => accountList
      }));
      expect(d.ok).toBe(false);
      expect(d.title).toMatch(/No 1Password account is connected/);
      expect(d.steps.join('\n')).toMatch(/op account add/);
    }
  );

  it('surfaces op read stderr in every failure mode', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('vault "Activist" not found'),
      readUnscoped: () => fail('vault "Activist" not found'),
      whoami: () => fail(),
      accountList: () => ok('[]')
    }));
    expect(d.steps.join('\n')).toMatch(/vault "Activist" not found/);
  });

  it('recommends the desktop integration only when the app is present on mac', () => {
    const notConnected = {
      read: () => fail(),
      readUnscoped: () => fail(),
      whoami: () => fail(),
      accountList: () => ok('[]')
    };
    const withApp = diagnoseSigning(REF, runners(notConnected), {
      platform: 'darwin',
      hasDesktopApp: true
    });
    expect(withApp.steps.join('\n')).toMatch(/Integrate with 1Password CLI/);

    const withoutApp = diagnoseSigning(REF, runners(notConnected), {
      platform: 'darwin',
      hasDesktopApp: false
    });
    expect(withoutApp.steps.join('\n')).not.toMatch(/Integrate with 1Password CLI/);
  });

  it('distinguishes a locked account from an absent one', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('not signed in'),
      readUnscoped: () => fail('not signed in'),
      whoami: () => fail('not signed in'),
      accountList: () => ok('[{"url":"my.1password.com"}]')
    }), {
      platform: 'darwin',
      hasDesktopApp: true
    });
    expect(d.title).toMatch(/could not be read/);
    expect(d.steps.join('\n')).toMatch(/Unlock the 1Password desktop app/);
  });

  it('falls back to op signin when there is no desktop app', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('not signed in'),
      readUnscoped: () => fail('not signed in'),
      whoami: () => fail(),
      accountList: () => ok('[{"url":"my.1password.com"}]')
    }), { hasDesktopApp: false });
    expect(d.steps.join('\n')).toMatch(/op signin/);
  });

  it('flags an unresolvable reference and surfaces op stderr', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('item "Item" not found'),
      readUnscoped: () => fail('item "Item" not found')
    }), {
      account: 'my.1password.com'
    });
    expect(d.title).toMatch(/could not be read/);
    const steps = d.steps.join('\n');
    expect(steps).toMatch(/item "Item" not found/);
    expect(steps).toMatch(/op item list/);
  });

  it('never includes the resolved key material in its result', () => {
    const secret = '-----BEGIN PRIVATE KEY-----MIIEvQ';
    const d = diagnoseSigning(REF, runners({ read: () => ok(secret) }));
    expect(JSON.stringify(d)).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('diagnoseSigning account scoping', () => {
  // The bug: passing --account makes op resolve the account from its own config file,
  // which is empty under the desktop-app integration. A scoped read fails there while
  // the identical unscoped read succeeds, so a scoped failure must not end the check.
  it('falls back to an unscoped read and says OP_ACCOUNT can be removed', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('No accounts configured for use with 1Password CLI.'),
      readUnscoped: () => ok('-----BEGIN PRIVATE KEY-----')
    }), { account: 'my.1password.com' });

    expect(d.ok).toBe(true);
    expect(d.account).toBeNull();
    expect(d.note).toMatch(/OP_ACCOUNT="my\.1password\.com" was ignored/);
    expect(d.note).toMatch(/can remove OP_ACCOUNT/);
  });

  it('keeps the scoped account when the scoped read works', () => {
    const d = diagnoseSigning(REF, runners({
      readUnscoped: () => fail('should not be reached')
    }), { account: 'team.1password.com' });

    expect(d).toEqual({ ok: true, ref: REF, account: 'team.1password.com' });
  });

  it('does not pass an account when none is configured', () => {
    const d = diagnoseSigning(REF, runners({ read: () => fail('should not be used') }));
    expect(d).toEqual({ ok: true, ref: REF, account: null });
  });
});

describe('formatSigningFailure', () => {
  it('indents steps and nests sub-steps under their parent', () => {
    const out = formatSigningFailure({
      ok: false,
      title: 'Broken',
      steps: ['Do this:', '  sub-step', 'Then this']
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Broken');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('  Do this:');
    expect(lines[3]).toBe('    sub-step');
    expect(lines[4]).toBe('  Then this');
  });
});

describe('parseAccounts', () => {
  it('uses the full sign-in address, not the bare first label', () => {
    const rows = parseAccounts(JSON.stringify([
      { url: 'team.1password.com', email: 'user@example.org' },
      { url: 'my.1password.com', email: 'personal@example.com' }
    ]));
    // "my" alone is an unreliable shorthand; op --account always takes the address.
    expect(rows.map((r) => r.account)).toEqual(['team.1password.com', 'my.1password.com']);
  });

  it('falls back to the email when a url is absent', () => {
    expect(parseAccounts(JSON.stringify([{ email: 'a@b.com' }]))[0].account).toBe('a@b.com');
  });

  it('survives malformed or empty input', () => {
    expect(parseAccounts('not json')).toEqual([]);
    expect(parseAccounts('[]')).toEqual([]);
    expect(parseAccounts('{}')).toEqual([]);
  });
});

describe('diagnoseSigning with several accounts', () => {
  const TWO = JSON.stringify([
    { url: 'team.1password.com', email: 'user@example.org' },
    { url: 'my.1password.com', email: 'personal@example.com' }
  ]);

  it('asks for OP_ACCOUNT rather than a plain unlock', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('multiple accounts'),
      readUnscoped: () => fail('multiple accounts'),
      whoami: () => fail('account is not signed in'),
      accountList: () => ok(TWO)
    }), { platform: 'darwin', hasDesktopApp: true });

    expect(d.ok).toBe(false);
    expect(d.title).toMatch(/2 1Password accounts are connected/);
    const steps = d.steps.join('\n');
    expect(steps).toMatch(/OP_ACCOUNT="team\.1password\.com"/);
    expect(steps).toMatch(/OP_ACCOUNT="my\.1password\.com"/);
    expect(steps).toMatch(/user@example\.org/);
  });

  it('treats a chosen account as the locked case instead', () => {
    const d = diagnoseSigning(REF, runners({
      read: () => fail('not signed in'),
      readUnscoped: () => fail('not signed in'),
      whoami: () => fail('locked'),
      accountList: () => ok(TWO)
    }), { account: 'team.1password.com', hasDesktopApp: false });

    expect(d.title).toMatch(/could not be read/);
    expect(d.steps.join('\n')).toMatch(/op signin --account team\.1password\.com/);
  });

  it('passes once the chosen account works', () => {
    const d = diagnoseSigning(REF, runners({ accountList: () => ok(TWO) }), {
      account: 'team.1password.com'
    });
    expect(d.ok).toBe(true);
  });
});

describe('signingRefProblem', () => {
  it('accepts a 1Password reference without running op', () => {
    expect(signingRefProblem(REF)).toBeNull();
  });

  it('flags a missing or malformed reference', () => {
    expect(signingRefProblem(undefined).title).toMatch(/not set/);
    expect(signingRefProblem('/tmp/key.pem').title).toMatch(/op:\/\//);
  });
});
