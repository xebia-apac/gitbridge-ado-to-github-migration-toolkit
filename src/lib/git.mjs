import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { validateAdoRepositoryUrl } from '../ado/client.mjs';
const exec = promisify(execFile);

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'ADO_PAT' || key === 'GH_MIGRATION_TOKEN' || key === 'GIT_AUTH_TOKEN' || key.startsWith('GIT_CONFIG_') || key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') {
      delete env[key];
    }
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function isLocalGitPath(value) {
  if (isAbsolute(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && !url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateGitHubRepositoryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GitHub repository URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)) {
    throw new Error('GitHub repository URL host is not approved.');
  }
  return url.toString();
}

async function runGit(args, options, operation, gitExec = exec) {
  try {
    return await gitExec('git', args, options);
  } catch (error) {
    const code = typeof error?.code === 'number' ? ` (exit ${error.code})` : '';
    throw new Error(`Git ${operation} failed${code}.`);
  }
}

async function withAskPass(env, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gitbridge-'));
  const askpass = join(dir, 'askpass.sh');
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' "$GIT_AUTH_USERNAME" ;;\n  *) printf \'%s\\n\' "$GIT_AUTH_TOKEN" ;;\nesac\n', { mode: 0o700 });
  await chmod(askpass, 0o700);
  try {
    return await fn({ ...gitEnvironment(), ...env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function cloneMirrorRepository({ sourceUrl, adoOrgUrl, adoPat, workDir, gitExec = exec }) {
  if (!sourceUrl || !workDir) throw new Error('Missing Git clone parameters');
  const localSource = isLocalGitPath(sourceUrl);
  if (!localSource && !adoPat) throw new Error('Missing ADO Git credentials.');
  const trustedSourceUrl = localSource ? sourceUrl : validateAdoRepositoryUrl(adoOrgUrl, sourceUrl);
  const cloneArgs = ['-c', 'http.followRedirects=false', 'clone', '--mirror', trustedSourceUrl, workDir];
  const clone = environment => runGit(cloneArgs, { env: environment ?? gitEnvironment(), maxBuffer: 20 * 1024 * 1024 }, 'clone', gitExec);
  if (localSource) await clone(gitEnvironment());
  else await withAskPass({ GIT_AUTH_USERNAME: 'build', GIT_AUTH_TOKEN: adoPat }, clone);
}

export async function pushMirrorRepository({ targetUrl, githubToken, workDir, gitExec = exec }) {
  if (!targetUrl || !workDir) throw new Error('Missing Git push parameters');
  const localTarget = isLocalGitPath(targetUrl);
  if (!localTarget && !githubToken) throw new Error('Missing GitHub Git credentials.');
  const trustedTargetUrl = localTarget ? targetUrl : validateGitHubRepositoryUrl(targetUrl);
  const pushArgs = ['-c', 'http.followRedirects=false', '-C', workDir, 'push', '--mirror', trustedTargetUrl];

  if ((await readMirrorRefs(workDir)).length === 0) return;

  const push = environment => runGit(pushArgs, { env: environment ?? gitEnvironment(), maxBuffer: 20 * 1024 * 1024 }, 'push', gitExec);
  if (localTarget) return push(gitEnvironment());
  return withAskPass({ GIT_AUTH_USERNAME: 'x-access-token', GIT_AUTH_TOKEN: githubToken }, push);
}

export async function mirrorRepository(parameters) {
  if (!parameters.sourceUrl || !parameters.targetUrl) throw new Error('Missing Git migration parameters');
  if (!isLocalGitPath(parameters.sourceUrl)) validateAdoRepositoryUrl(parameters.adoOrgUrl, parameters.sourceUrl);
  if (!isLocalGitPath(parameters.targetUrl)) validateGitHubRepositoryUrl(parameters.targetUrl);
  await cloneMirrorRepository(parameters);
  return pushMirrorRepository(parameters);
}
export async function readMirrorRefs(repoDir) {
  const { stdout } = await exec('git', ['-C', repoDir, 'for-each-ref', '--format=%(refname) %(objectname)']);
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [ref, sha] = line.split(' '); return { ref, sha };
  });
}
