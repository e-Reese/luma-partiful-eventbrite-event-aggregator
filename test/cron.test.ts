import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cycle = path.join(repoRoot, 'scripts', 'cycle.sh');

/**
 * Runs cycle.sh the way cron actually runs it.
 *
 * cron does not read shell profiles, so ~/.zshrc never executes and an
 * nvm-managed toolchain is not on PATH. It also starts from a near-empty
 * environment with PATH=/usr/bin:/bin. `env -i` reproduces both, which is the
 * only way to catch a bug that is invisible from an interactive shell.
 *
 * This is not hypothetical: cycle.sh failed this way 107 consecutive times,
 * every three hours for a month, while the site served month-old data.
 */
function runAsCron(args: string[] = []) {
  return spawnSync(
    '/usr/bin/env',
    ['-i', `HOME=${process.env.HOME}`, 'PATH=/usr/bin:/bin', cycle, ...args],
    { encoding: 'utf8', timeout: 20_000 },
  );
}

describe('cycle.sh under cron', () => {
  it('finds a node toolchain without an interactive shell profile', () => {
    const { status, stdout, stderr } = runAsCron(['--preflight']);

    expect(stderr + stdout).not.toMatch(/npm: command not found/);
    expect(status).toBe(0);
  });

  it('reports the npm it resolved, and that npm actually runs', () => {
    const { stdout } = runAsCron(['--preflight']);

    const resolved = stdout.match(/^npm:\s+(\S+)$/m)?.[1];
    expect(resolved, `no "npm: <path>" line in preflight output:\n${stdout}`).toBeTruthy();

    const version = spawnSync(resolved!, ['--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('preflight does not start a collection cycle', () => {
    const { stdout } = runAsCron(['--preflight']);

    // A real cycle prints per-source result lines. Preflight must not.
    expect(stdout).not.toMatch(/terminated (exhausted|cursor_stuck|page_cap|error)/);
  });
});
