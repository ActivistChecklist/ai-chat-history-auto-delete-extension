/**
 * Diagnoses the 1Password signing setup and returns actionable instructions.
 *
 * Split out from the release script (and kept free of side effects) because "signing is
 * broken" has several distinct causes that need different fixes, and telling someone to
 * run `op signin` when no account is configured at all just wastes their time.
 *
 * Command execution is injected so this is unit-testable without the op CLI present.
 */

/**
 * @typedef {{status: number, out: string, err: string}} CmdResult
 * @typedef {{
 *   version: () => CmdResult,
 *   accountList: () => CmdResult,
 *   whoami: () => CmdResult,
 *   read: (ref: string) => CmdResult
 * }} Runners
 */

/**
 * Turns `op account list --format=json` into {account, email, url}.
 *
 * `account` is the full sign-in address (e.g. `my.1password.com`) because that form is
 * always accepted by `op --account`. The bare first URL label is a shorthand that does
 * not reliably resolve, so it is deliberately not suggested.
 */
export function parseAccounts(json) {
  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      url: r.url || '',
      email: r.email || '',
      account: r.url || r.email || ''
    }))
    .filter((r) => r.account);
}

/**
 * The checks that need no 1Password call: the reference is set and looks like one.
 * A dry run uses only these, so it never prompts for or reads the key.
 * @returns {null | {ok: false, title: string, steps: string[]}}
 */
export function signingRefProblem(ref) {
  if (!ref) {
    return {
      ok: false,
      title: 'OP_SIGNING_KEY_REF is not set, so the CRX cannot be signed.',
      steps: [
        'cp .env.example .env',
        'Open 1Password, right-click the signing key field -> "Copy Secret Reference"',
        'Paste it into .env as OP_SIGNING_KEY_REF="op://<vault>/<item>/private key"',
        'Or pass --no-sign to release without a CRX.'
      ]
    };
  }

  if (!ref.startsWith('op://')) {
    return {
      ok: false,
      title: `OP_SIGNING_KEY_REF must be a 1Password secret reference starting with "op://" (got "${ref}").`,
      steps: [
        'In 1Password, right-click the signing key field -> "Copy Secret Reference"',
        'It should look like: op://<vault>/<item>/private key'
      ]
    };
  }

  return null;
}

/** @returns {{ok: true, ref: string} | {ok: false, title: string, steps: string[]}} */
export function diagnoseSigning(ref, runners, opts = {}) {
  const { platform = process.platform, hasDesktopApp = false, account = null } = opts;
  const isMac = platform === 'darwin';

  const refProblem = signingRefProblem(ref);
  if (refProblem) return refProblem;

  const version = runners.version();
  if (version.status !== 0) {
    return {
      ok: false,
      title: 'The 1Password CLI (op) is not installed, so the signing key cannot be read.',
      steps: [
        isMac ? 'brew install 1password-cli' : 'See https://developer.1password.com/docs/cli/get-started/',
        'Then re-run: yarn release',
        'Or pass --no-sign to release without a CRX.'
      ]
    };
  }

  // Gate on the operation we actually need — resolving the key — not on `op whoami`.
  // With the 1Password desktop-app integration, `whoami` reports "account is not signed
  // in" (there is no CLI session) while `op read` still succeeds by prompting for
  // biometric authorization. Gating on whoami would block a working setup.
  //
  // Try the scoped form first when OP_ACCOUNT is set, then fall back to unscoped: the two
  // resolve accounts by different mechanisms and only one may work on a given machine.
  let read;
  if (account) {
    read = runners.read(ref);
    if (read.status === 0) return { ok: true, ref, account };

    const unscoped = runners.readUnscoped(ref);
    if (unscoped.status === 0) {
      return {
        ok: true,
        ref,
        account: null,
        note: `OP_ACCOUNT="${account}" was ignored — it made op read fail, but the ` +
          'unscoped read works. You can remove OP_ACCOUNT from .env.'
      };
    }
  } else {
    read = runners.readUnscoped(ref);
    if (read.status === 0) return { ok: true, ref, account: null };
  }

  // From here the read failed, so whoami and the account list are used only to explain
  // WHY, because each cause needs a different fix.
  const readErr = (read.err || '').trim().split('\n')[0] || 'op read failed';
  const whoami = runners.whoami();
  const accounts = runners.accountList();
  const listed = parseAccounts(accounts.out);
  const noAccounts = accounts.status !== 0
    || accounts.out.trim() === ''
    || accounts.out.trim() === '[]';

  if (noAccounts && whoami.status !== 0) {
    const steps = [];
    if (isMac && hasDesktopApp) {
      steps.push(
        'Enable the desktop integration (recommended — unlocks with Touch ID, no session to expire):',
        '  1Password app -> Settings -> Developer -> "Integrate with 1Password CLI"',
        '  Then open a new terminal tab and re-run.'
      );
    }
    steps.push(
      'Or connect the CLI manually:',
      '  op account add --address my.1password.com --email <your-email>',
      '  eval $(op signin)'
    );
    steps.push(`(op read said: ${readErr})`);
    return { ok: false, title: 'No 1Password account is connected to the CLI.', steps };
  }

  // Several accounts and none chosen: the read may have hit the wrong one.
  if (listed.length > 1 && !account) {
    const steps = ['Add OP_ACCOUNT to .env to choose the account that owns the signing vault:'];
    for (const a of listed) {
      steps.push(`  OP_ACCOUNT="${a.account}"    # ${a.email || a.url}`);
    }
    steps.push(`(op read said: ${readErr})`);
    return {
      ok: false,
      title: `${listed.length} 1Password accounts are connected but the key could not be read.`,
      steps
    };
  }

  // An account is selected and connected, so this is a locked vault or a wrong reference.
  const steps = [readErr];
  if (/not signed in|session|unauthor|locked/i.test(readErr) || whoami.status !== 0) {
    steps.push(
      isMac && hasDesktopApp
        ? 'Unlock the 1Password desktop app (biometric unlock covers the CLI), then re-run'
        : `eval $(op signin${account ? ` --account ${account}` : ''})`
    );
  }
  steps.push(
    'If it is unlocked, check the vault and item names in the reference:',
    `  ${ref}`,
    `  op item list --vault "<vault>"${account ? ` --account ${account}` : ''}`
  );
  return { ok: false, title: 'The signing key could not be read from 1Password.', steps };
}

/**
 * Builds real runners around a spawn function (kept injectable for tests).
 *
 * `account` scopes every call with `--account`. With more than one 1Password account
 * connected, an unscoped `op read` cannot tell which account owns the vault, so
 * OP_ACCOUNT must select one.
 */
export function makeOpRunners(spawnSync, cwd, account = process.env.OP_ACCOUNT) {
  const scope = account ? ['--account', account] : [];
  const call = (args, scoped = true) => {
    const r = spawnSync('op', scoped ? [...args, ...scope] : args, { cwd, encoding: 'utf8' });
    if (r.error) return { status: 127, out: '', err: r.error.message };
    return { status: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
  };
  return {
    version: () => call(['--version'], false),
    // Listing accounts must NOT be scoped — that is how we discover them.
    accountList: () => call(['account', 'list', '--format=json'], false),
    whoami: () => call(['whoami']),
    read: (ref) => call(['read', ref]),
    // Passing --account makes op resolve the account from its own config file. With the
    // desktop-app integration that file is empty ("accounts": null), so a scoped read
    // fails with "No accounts configured" while an unscoped one succeeds via the app.
    readUnscoped: (ref) => call(['read', ref], false)
  };
}

/** Formats a failed diagnosis for the terminal. */
export function formatSigningFailure(diag) {
  // Always indent by 2, so steps written with leading spaces nest visibly under their parent.
  return [diag.title, '', ...diag.steps.map((s) => `  ${s}`)].join('\n');
}
