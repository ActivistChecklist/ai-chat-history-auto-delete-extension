/**
 * Reads one secret from 1Password with the `op` CLI and returns it to the caller.
 *
 * The value only ever travels through this process's memory: it is never printed and
 * never placed in another command's argv. Callers hand it to a child process through a
 * temp file (CRX signing) or an environment variable (AMO upload).
 */

/**
 * @param {(cmd: string, args: string[], opts: object) => {error?: Error, status: number|null, stdout: string, stderr: string}} spawnSync
 * @param {string} ref an op:// secret reference
 * @param {{account?: string|null, envName?: string}} [opts]
 * @returns {string} the raw secret (trailing newline preserved, as op prints it)
 */
export function readOpSecret(spawnSync, ref, { account = null, envName = 'secret reference' } = {}) {
  if (!ref) {
    throw new Error(`Set ${envName} in .env to your 1Password secret reference (op://<vault>/<item>/<field>).`);
  }
  // Try OP_ACCOUNT-scoped first when set, then unscoped. Passing --account makes op
  // resolve the account from its own config file, which is empty when the 1Password
  // desktop-app integration is providing accounts, so the unscoped form is the one
  // that works there.
  const attempts = account
    ? [['read', ref, '--account', account], ['read', ref]]
    : [['read', ref]];
  let r;
  for (const args of attempts) {
    r = spawnSync('op', args, { encoding: 'utf8' });
    if (!r.error && r.status === 0) break;
  }
  if (r.error) {
    throw new Error(`1Password CLI (op) not found: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`op read failed for ${envName} (status ${r.status}):\n${r.stderr?.trim()}`);
  }
  return r.stdout;
}
