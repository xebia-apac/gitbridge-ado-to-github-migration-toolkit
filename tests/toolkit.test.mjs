import test from 'node:test';
import assert from 'node:assert/strict';
import {
  csv,
  failedDiscoveryResult,
  projectReportSummary,
  repositoryReportSummary,
  rollupDiscoveryStatus,
  rollupOrganizationStatus,
  rollupProjectStatus,
  rollupRepositoryStatus,
  successfulDiscoveryResult
} from '../src/lib/report.mjs';
import { AdoClient, selectAccessibleProjects, validateAdoRepositoryUrl } from '../src/ado/client.mjs';
import { GitHubClient } from '../src/github/client.mjs';

function adoResponse(data, { status = 200, continuationToken = null, retryAfter = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name === 'x-ms-continuationtoken') return continuationToken;
        if (name === 'retry-after') return retryAfter;
        return null;
      }
    },
    json: async () => data
  };
}

test('CSV writer escapes commas, quotes and newlines safely', () => {
  const result = csv([{ repo: 'hello,world', note: 'say "hi"' }]);
  assert.equal(result, '"repo","note"\n"hello,world","say ""hi"""');
});

test('CSV writer neutralizes formula-leading untrusted text', () => {
  const result = csv([{ project: '=1+1', branch: '  @SUM(1,1)', normal: 'main' }]);
  assert.equal(result, '"project","branch","normal"\n"\'=1+1","\'  @SUM(1,1)","main"');
});

test('discovery status rollup distinguishes success, partial, failed and not verified', () => {
  assert.equal(rollupDiscoveryStatus(['SUCCESS', 'SUCCESS']), 'SUCCESS');
  assert.equal(rollupDiscoveryStatus(['SUCCESS', 'FAILED']), 'PARTIAL');
  assert.equal(rollupDiscoveryStatus(['FAILED'], { hasInventory: false }), 'FAILED');
  assert.equal(rollupDiscoveryStatus(['NOT_VERIFIED'], { hasInventory: false }), 'NOT_VERIFIED');
  assert.equal(rollupDiscoveryStatus(['SUCCESS'], { scopeComplete: false }), 'PARTIAL');
});

test('discovery result construction uses the same uppercase status vocabulary as the CLI', () => {
  assert.deepEqual(successfulDiscoveryResult([{ id: 'p1' }]), { status: 'SUCCESS', items: [{ id: 'p1' }], error: null });
  assert.equal(failedDiscoveryResult(Object.assign(new Error('forbidden'), { status: 403 })).status, 'NOT_VERIFIED');
  assert.equal(failedDiscoveryResult(new Error('server error')).status, 'FAILED');
});

test('repository, project and organization rollups include nested failures and incomplete scope', () => {
  const repositoryStatus = rollupRepositoryStatus(['SUCCESS', 'FAILED']);
  assert.equal(repositoryStatus, 'PARTIAL');
  assert.equal(rollupProjectStatus({
    repositoryInventoryStatus: 'SUCCESS',
    adapterStatuses: ['SUCCESS', 'SUCCESS'],
    repositoryStatuses: [repositoryStatus]
  }), 'PARTIAL');
  assert.equal(rollupOrganizationStatus({
    projectCatalogStatus: 'SUCCESS', projectStatuses: ['SUCCESS'], scopeComplete: true
  }), 'SUCCESS');
  assert.equal(rollupOrganizationStatus({
    projectCatalogStatus: 'SUCCESS', projectStatuses: ['SUCCESS'], scopeComplete: false
  }), 'PARTIAL');
  assert.equal(rollupOrganizationStatus({
    projectCatalogStatus: 'NOT_VERIFIED', projectStatuses: []
  }), 'NOT_VERIFIED');
});

test('project and repository JSON/CSV summaries carry the same discovery statuses', () => {
  const repository = {
    projectId: 'p1', projectName: 'Project', id: 'r1', name: 'Repo', remoteUrl: 'https://dev.azure.com/org/_git/repo',
    defaultBranch: 'refs/heads/main', sizeBytes: 12, branches: [{ name: 'refs/heads/main' }], tags: [], commits: [],
    lfs: { lfsConfigured: null, detection: 'tracked-gitattributes' }, branchesStatus: 'SUCCESS', tagsStatus: 'SUCCESS',
    commitsStatus: 'FAILED', branchPoliciesStatus: 'SUCCESS', permissionsStatus: 'SUCCESS', lfsStatus: 'NOT_VERIFIED',
    lfsObjectAvailabilityStatus: 'NOT_VERIFIED', discoveryStatus: 'PARTIAL'
  };
  const inventory = {
    project: { id: 'p1', name: 'Project' }, repositories: [repository], branchPolicies: [], buildPipelines: [],
    releasePipelines: [], serviceConnections: [], repositoryInventoryStatus: 'SUCCESS', branchPoliciesStatus: 'SUCCESS',
    buildPipelinesStatus: 'SUCCESS', releasePipelinesStatus: 'SUCCESS', serviceConnectionsStatus: 'SUCCESS', discoveryStatus: 'PARTIAL'
  };
  const projectRow = projectReportSummary(inventory);
  const repositoryRow = repositoryReportSummary(repository);
  const json = JSON.stringify({ discoveryStatus: inventory.discoveryStatus, repository: { discoveryStatus: repository.discoveryStatus } });
  const csvOutput = `${csv([projectRow])}\n${csv([repositoryRow])}`;
  assert.equal(projectRow.discoveryStatus, 'PARTIAL');
  assert.equal(repositoryRow.discoveryStatus, 'PARTIAL');
  assert.ok(json.includes('PARTIAL'));
  assert.ok(csvOutput.includes('PARTIAL'));
  assert.ok(csvOutput.includes('FAILED'));
  assert.ok(csvOutput.includes('NOT_VERIFIED'));
});

test('ADO client sends Basic PAT authentication and returns project payload', async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ value: [{ id: 'p1', name: 'Demo' }] }) };
  };
  try {
    const client = new AdoClient('https://dev.azure.com/example/', 'fake-pat');
    const projects = await client.listProjects();
    assert.equal(projects[0].name, 'Demo');
    assert.match(seen.url, /_apis\/projects/);
    assert.equal(seen.options.headers.Authorization, `Basic ${Buffer.from(':fake-pat').toString('base64')}`);
    assert.equal(seen.options.redirect, 'error');
  } finally { globalThis.fetch = originalFetch; }
});

test('ADO client rejects HTTP organization URLs', () => {
  assert.throws(() => new AdoClient('http://dev.azure.com/example', 'fake-pat'), /HTTPS/);
});

test('ADO client rejects arbitrary organization hosts', () => {
  assert.throws(() => new AdoClient('https://attacker.example/example', 'fake-pat'), /not approved/);
});

test('ADO client rejects malformed organization URLs', () => {
  assert.throws(() => new AdoClient('not a URL', 'fake-pat'), /Invalid Azure DevOps URL/);
});

test('ADO client rejects a missing PAT', () => {
  assert.throws(() => new AdoClient('https://dev.azure.com/example', ''), /ADO_ORG_URL and ADO_PAT are required/);
});

test('ADO client does not disclose the PAT in serialized state, request URLs, or errors', async () => {
  const originalFetch = globalThis.fetch;
  const pat = 'credential-that-must-not-leak';
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: false, status: 401, statusText: `Unauthorized ${pat}` };
  };
  try {
    const client = new AdoClient('https://dev.azure.com/example', pat, { maxRetries: 0 });
    assert.equal(JSON.stringify(client), '{}');
    await assert.rejects(client.listProjects(), error => {
      assert.equal(error.message, 'Azure DevOps API request failed with status 401.');
      assert.equal(error.message.includes(pat), false);
      return true;
    });
    assert.equal(seen.url.includes(pat), false);

    globalThis.fetch = async () => { throw new Error(pat); };
    await assert.rejects(client.listProjects(), error => {
      assert.equal(error.message, 'Azure DevOps API request failed or timed out.');
      assert.equal(error.message.includes(pat), false);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('ADO project adapter follows continuation tokens and includes all accessible project states', async () => {
  const requests = [];
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => {
      requests.push(new URL(url));
      return requests.length === 1
        ? adoResponse({ value: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] }, { continuationToken: 'next page' })
        : adoResponse({ value: [{ id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }] });
    },
    maxRetries: 0
  });

  const projects = await client.listProjects();
  assert.deepEqual(projects.map(project => project.name), ['One', 'Two', 'Three']);
  assert.equal(requests[0].searchParams.get('stateFilter'), 'all');
  assert.equal(requests[0].searchParams.get('$top'), '1000');
  assert.equal(requests[1].searchParams.get('continuationToken'), 'next page');
});

test('ADO pagination rejects repeated continuation tokens and malformed collections', async () => {
  let tokenCalls = 0;
  const repeatedTokenClient = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => {
      tokenCalls += 1;
      return adoResponse({ value: [{ id: `p${tokenCalls}` }] }, { continuationToken: 'repeat' });
    },
    maxRetries: 0
  });
  await assert.rejects(repeatedTokenClient.listProjects(), /repeated continuation token/);
  assert.equal(tokenCalls, 2);

  let changingTokenCalls = 0;
  const changingTokenClient = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => {
      changingTokenCalls += 1;
      return adoResponse({ value: [{ id: `page-${changingTokenCalls}` }] }, { continuationToken: `token-${changingTokenCalls}` });
    },
    maxPages: 2,
    maxRetries: 0
  });
  await assert.rejects(changingTokenClient.listProjects(), /configured page limit/);
  assert.equal(changingTokenCalls, 2);

  const malformedClient = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => adoResponse({ unexpected: [] }),
    maxRetries: 0
  });
  await assert.rejects(malformedClient.listProjects(), /malformed collection response/);
  await assert.rejects(malformedClient.listRepositories('Project'), /malformed collection response/);
});

test('ADO project selection supports all, one, multiple, case-insensitive names, and rejects inaccessible names', () => {
  const projects = [{ name: 'One' }, { name: 'Two' }];
  assert.equal(selectAccessibleProjects(projects).length, 2);
  assert.deepEqual(selectAccessibleProjects(projects, ['one, Two,one']), [projects[0], projects[1]]);
  assert.throws(() => selectAccessibleProjects(projects, ['missing']), /unavailable/);
});

test('ADO repository URL validation accepts both official Git remote path forms', () => {
  assert.equal(
    validateAdoRepositoryUrl('https://dev.azure.com/example', 'https://dev.azure.com/example/_git/repo'),
    'https://dev.azure.com/example/_git/repo'
  );
  assert.equal(
    validateAdoRepositoryUrl('https://dev.azure.com/example', 'https://dev.azure.com/example/Project/_git/repo'),
    'https://dev.azure.com/example/Project/_git/repo'
  );
});

test('ADO repository adapter returns full repository metadata including size', async () => {
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => adoResponse({ value: [{ id: 'r1', name: 'Repo', size: 1234, defaultBranch: 'refs/heads/main' }] }),
    maxRetries: 0
  });
  const repositories = await client.listRepositories('Project One');
  assert.equal(repositories[0].name, 'Repo');
  assert.equal(repositories[0].size, 1234);
});

test('ADO branch refs adapter follows continuation tokens', async () => {
  let page = 0;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => {
      page += 1;
      assert.match(url, /filter=refs%2Fheads%2F|filter=refs\/heads\//);
      return page === 1
        ? adoResponse({ value: [{ name: 'refs/heads/main', objectId: 'a' }] }, { continuationToken: 'branches-2' })
        : adoResponse({ value: [{ name: 'refs/heads/release', objectId: 'b' }] });
    },
    maxRetries: 0
  });
  assert.equal((await client.listRefs('Project', 'repo-id')).length, 2);
});

test('ADO tag refs adapter uses the tag filter', async () => {
  let requestedUrl;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => { requestedUrl = new URL(url); return adoResponse({ value: [{ name: 'refs/tags/v1', objectId: 'a' }] }); },
    maxRetries: 0
  });
  assert.equal((await client.listTags('Project', 'repo-id'))[0].name, 'refs/tags/v1');
  assert.equal(requestedUrl.searchParams.get('filter'), 'refs/tags/');
});

test('ADO commit adapter pages with searchCriteria skip and top', async () => {
  const requests = [];
  const pages = [
    [{ commitId: 'a' }, { commitId: 'b' }],
    [{ commitId: 'b' }, { commitId: 'c' }],
    [{ commitId: 'd' }]
  ];
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => {
      const request = new URL(url);
      requests.push(request);
      const page = pages[requests.length - 1].map(commit => ({
        ...commit,
        comment: 'commit-secret-do-not-export',
        author: { name: 'Author', email: 'author-secret-do-not-export', date: '2026-01-01T00:00:00Z' }
      }));
      return adoResponse({ value: page });
    },
    maxRetries: 0
  });
  const commits = await client.listCommits('Project', 'repo-id', 2);
  assert.deepEqual(commits.map(commit => commit.commitId), ['a', 'b', 'c', 'd']);
  assert.equal(requests[0].searchParams.get('searchCriteria.$skip'), '0');
  assert.equal(requests[1].searchParams.get('searchCriteria.$skip'), '2');
  assert.equal(requests[1].searchParams.get('searchCriteria.$top'), '2');
  for (const secret of ['commit-secret-do-not-export', 'author-secret-do-not-export']) {
    assert.equal(JSON.stringify(commits).includes(secret), false);
    assert.equal(csv(commits).includes(secret), false);
  }
});

test('ADO commit pagination fails instead of looping over an unchanged full page', async () => {
  let calls = 0;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => { calls += 1; return adoResponse({ value: [{ commitId: 'a' }, { commitId: 'b' }] }); },
    maxRetries: 0
  });
  await assert.rejects(client.listCommits('Project', 'repo-id', 2), /did not advance/);
  assert.equal(calls, 2);
});

test('ADO build pipeline adapter follows continuation tokens', async () => {
  let calls = 0;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? adoResponse({ value: [{ id: 1, name: 'Build', variables: { token: 'build-secret-do-not-export' }, process: { secret: 'hidden' } }] }, { continuationToken: 'builds-next' })
        : adoResponse({ value: [{ id: 2, name: 'Build Two', variables: { password: 'hidden' } }] });
    },
    maxRetries: 0
  });
  const definitions = await client.listBuildDefinitions('Project');
  assert.deepEqual(definitions.map(definition => definition.id), [1, 2]);
  assert.equal(JSON.stringify(definitions).includes('build-secret-do-not-export'), false);
  assert.equal(csv(definitions).includes('build-secret-do-not-export'), false);
});

test('ADO release pipeline adapter uses the approved release host and paginates', async () => {
  const requests = [];
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => {
      requests.push(new URL(url));
      return requests.length === 1
        ? adoResponse({ value: [{ id: 1, name: 'Release', variables: { token: 'release-secret-do-not-export' }, environments: [{ id: 4, name: 'Prod', rank: 1, variables: { password: 'hidden' } }] }] }, { continuationToken: 'releases-next' })
        : adoResponse({ value: [{ id: 2, name: 'Release Two', variables: { password: 'hidden' } }] });
    },
    maxRetries: 0
  });
  const definitions = await client.listReleaseDefinitions('Project');
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0].environments[0].name, 'Prod');
  assert.equal(JSON.stringify(definitions).includes('release-secret-do-not-export'), false);
  assert.equal(csv(definitions).includes('release-secret-do-not-export'), false);
  assert.equal(requests[0].hostname, 'vsrm.dev.azure.com');
  assert.equal(requests[1].searchParams.get('continuationToken'), 'releases-next');
});

test('ADO service connection adapter excludes authorization and data values', async () => {
  const pathSecret = 'path-secret-do-not-export';
  const querySecret = 'query-secret-do-not-export';
  const fragmentSecret = 'fragment-secret-do-not-export';
  const userSecret = 'userinfo-secret-do-not-export';
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => adoResponse({ value: [
      {
        id: 's1', name: 'Userinfo', type: 'Generic', url: `https://${userSecret}:pass@example.test/path`,
        authorization: { scheme: 'Token', parameters: { token: 'hidden' } }, data: { password: 'hidden' }, isReady: true,
        serviceEndpointProjectReferences: [{ projectReference: { id: 'p1', name: 'Project' }, name: 'Shared Connection' }]
      },
      { id: 's2', name: 'Query', type: 'Generic', url: `https://example.test/path?token=${querySecret}` },
      { id: 's3', name: 'Fragment', type: 'Generic', url: `https://example.test/path#${fragmentSecret}` },
      { id: 's4', name: 'Path', type: 'Generic', url: `https://example.test/${pathSecret}` }
    ] }),
    maxRetries: 0
  });
  const endpoints = await client.listServiceEndpoints('Project');
  assert.deepEqual(endpoints.map(endpoint => endpoint.url), [
    'https://example.test', 'https://example.test', 'https://example.test', 'https://example.test'
  ]);
  assert.equal(endpoints[0].projectReferences[0].projectName, 'Project');
  const json = JSON.stringify(endpoints);
  const csvOutput = csv(endpoints);
  for (const secret of [pathSecret, querySecret, fragmentSecret, userSecret, 'hidden']) {
    assert.equal(json.includes(secret), false);
    assert.equal(csvOutput.includes(secret), false);
  }
  assert.equal(json.includes('authorization'), false);
});

test('ADO branch policy adapter paginates and projects safe settings', async () => {
  let calls = 0;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? adoResponse({ value: [{ id: 5, isEnabled: true, isBlocking: true, type: { id: 't1', displayName: 'Review' }, settings: { minimumApproverCount: 2, secretToken: 'hidden', scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: 'r1', password: 'hidden' }] } }] }, { continuationToken: 'policies-next' })
        : adoResponse({ value: [] });
    },
    maxRetries: 0
  });
  const policies = await client.listBranchPolicies('Project');
  assert.equal(policies[0].settings.minimumApproverCount, 2);
  assert.deepEqual(policies[0].settings.scope, [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: 'r1' }]);
  assert.equal(JSON.stringify(policies).includes('hidden'), false);
});

test('ADO repository permissions adapter maps ACL entries without exporting raw ACLs', async () => {
  let requestedUrl;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return adoResponse({ value: [{
        token: 'repoV2/p1/r1', inheritPermissions: true,
        acesDictionary: { principal: { descriptor: 'identity-descriptor', allow: 3, deny: 0, extendedInfo: { effectiveAllow: 3, effectiveDeny: 0 } } }
      }] });
    },
    maxRetries: 0
  });
  const permissions = await client.listRepositoryPermissions('p1', 'r1');
  assert.equal(requestedUrl.pathname, '/example/_apis/accesscontrollists/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87');
  assert.equal(requestedUrl.searchParams.get('token'), 'repoV2/p1/r1');
  assert.deepEqual(permissions[0], { descriptor: 'identity-descriptor', allow: 3, deny: 0, effectiveAllow: 3, effectiveDeny: 0, inheritPermissions: true });
});

test('ADO LFS adapter scans tracked attributes without returning file contents', async () => {
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async url => {
      const request = new URL(url);
      const scopePath = request.searchParams.get('scopePath');
      if (scopePath === '/') {
        return adoResponse({ value: [
          { path: '/.gitattributes', isFolder: false },
          { path: '/src', isFolder: true }
        ] });
      }
      if (scopePath === '/src') return adoResponse({ value: [
        { path: '/src', isFolder: true },
        { path: '/src/.gitattributes', isFolder: false },
        { path: '/src/app.js', isFolder: false }
      ] });
      return adoResponse({ content: request.searchParams.get('path') === '/src/.gitattributes' ? '*.bin filter=lfs diff=lfs merge=lfs -text' : '*.txt text' });
    },
    maxRetries: 0
  });
  const result = await client.detectLfsUsage('Project', 'repo-id', 'refs/heads/main');
  assert.deepEqual(result, {
    lfsConfigured: true, detection: 'tracked-gitattributes', attributeFileCount: 2,
    scannedAttributeFileCount: 2, repositoryTreeItemCount: 4, repositoryDirectoryCount: 2,
    status: 'SUCCESS', objectAvailabilityStatus: 'NOT_VERIFIED'
  });
  assert.equal(JSON.stringify(result).includes('filter=lfs'), false);
});

test('ADO LFS adapter limits attribute concurrency and marks truncated scans partial', async () => {
  let activeRequests = 0;
  let peakRequests = 0;
  const paths = Array.from({ length: 5 }, (_, index) => `/dir${index}/.gitattributes`);
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    lfsConcurrency: 2,
    maxLfsAttributeFiles: 2,
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl: async url => {
      const request = new URL(url);
      if (request.searchParams.has('scopePath')) {
        return adoResponse({ value: paths.map(path => ({ path, isFolder: false })) });
      }
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 3));
      activeRequests -= 1;
      return adoResponse({ content: '*.txt text' });
    }
  });
  const result = await client.detectLfsUsage('Project', 'repo-id', 'refs/heads/main');
  assert.equal(peakRequests, 2);
  assert.deepEqual(result, {
    lfsConfigured: null, detection: 'tracked-gitattributes-partial', attributeFileCount: 5,
    scannedAttributeFileCount: 2, repositoryTreeItemCount: 5, repositoryDirectoryCount: 1,
    status: 'NOT_VERIFIED', objectAvailabilityStatus: 'NOT_VERIFIED'
  });
});

test('ADO LFS adapter stops attribute inspection above the repository tree limit', async () => {
  let requests = 0;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    maxLfsTreeItems: 2,
    maxRetries: 0,
    fetchImpl: async () => {
      requests += 1;
      return adoResponse({ value: [
        { path: '/.gitattributes', isFolder: false },
        { path: '/src/.gitattributes', isFolder: false },
        { path: '/src/app.js', isFolder: false }
      ] });
    }
  });
  const result = await client.detectLfsUsage('Project', 'repo-id', 'refs/heads/main');
  assert.equal(result.status, 'NOT_VERIFIED');
  assert.equal(result.detection, 'repository-tree-traversal-limit-reached');
  assert.equal(requests, 1);
});

test('ADO LFS adapter caps directory requests', async () => {
  let requests = 0;
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    maxLfsDirectories: 1,
    maxRetries: 0,
    fetchImpl: async () => {
      requests += 1;
      return adoResponse({ value: [
        { path: '/.gitattributes', isFolder: false },
        { path: '/src', isFolder: true }
      ] });
    }
  });
  const result = await client.detectLfsUsage('Project', 'repo-id', 'refs/heads/main');
  assert.equal(result.status, 'NOT_VERIFIED');
  assert.equal(result.detection, 'repository-tree-traversal-limit-reached');
  assert.equal(requests, 1);
});

test('ADO API retries rate limits and transient timeouts with request deadlines', async () => {
  let attempts = 0;
  const delays = [];
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async (_url, options) => {
      attempts += 1;
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return attempts === 1
        ? adoResponse({}, { status: 429, retryAfter: '0' })
        : adoResponse({ value: [{ id: 'p1' }] });
    },
    sleep: async milliseconds => delays.push(milliseconds),
    timeoutMs: 5000,
    maxRetries: 1
  });
  assert.equal((await client.listProjects()).length, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [0]);

  let timeoutAttempts = 0;
  const timeoutClient = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      timeoutAttempts += 1;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    timeoutMs: 5,
    maxRetries: 0
  });
  const keepAlive = setTimeout(() => {}, 50);
  try { await assert.rejects(timeoutClient.listProjects(), /failed or timed out/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(timeoutAttempts, 1);
});

test('ADO API retry exhaustion returns a bounded status error', async () => {
  let attempts = 0;
  const delays = [];
  const client = new AdoClient('https://dev.azure.com/example', 'fake-pat', {
    fetchImpl: async () => { attempts += 1; return adoResponse({}, { status: 429, retryAfter: '0' }); },
    sleep: async milliseconds => delays.push(milliseconds),
    maxRetries: 1
  });
  await assert.rejects(client.listProjects(), error => {
    assert.equal(error.status, 429);
    assert.equal(error.message.includes('fake-pat'), false);
    return true;
  });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [0]);
});

test('GitHub client treats 404 as missing destination repository', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 404, ok: false });
  try {
    const client = new GitHubClient('fake-token');
    assert.equal(await client.getRepository('example', 'new-repo'), null);
  } finally { globalThis.fetch = originalFetch; }
});

test('GitHub repository creation uses a write-only POST and never places the token in the URL', async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 201, json: async () => ({ full_name: 'example/new-repo', private: true }) };
  };
  try {
    const client = new GitHubClient('github-token-do-not-leak');
    const repository = await client.createRepository('example', 'new-repo', true);
    assert.equal(repository.full_name, 'example/new-repo');
    assert.equal(seen.options.method, 'POST');
    assert.equal(new URL(seen.url).pathname, '/orgs/example/repos');
    assert.equal(seen.url.includes('github-token-do-not-leak'), false);
    assert.deepEqual(JSON.parse(seen.options.body), { name: 'new-repo', private: true, auto_init: false });
  } finally { globalThis.fetch = originalFetch; }
});

test('GitHub client refuses an existing migration target without attempting creation', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method ?? 'GET');
    return { status: 200, ok: true, json: async () => ({ full_name: 'example/repo' }) };
  };
  try {
    const client = new GitHubClient('fake-token');
    await assert.rejects(client.assertRepositoryDoesNotExist('example', 'repo'), /already exists/);
    assert.deepEqual(methods, ['GET']);
  } finally { globalThis.fetch = originalFetch; }
});

test('GitHub client rejects redirects, external API paths, and does not serialize its token', async () => {
  let fetchCalls = 0;
  const token = 'github-token-do-not-leak';
  const client = new GitHubClient(token, {
    maxRetries: 0,
    fetchImpl: async (_url, options) => {
      fetchCalls += 1;
      assert.equal(options.redirect, 'error');
      throw new Error(`redirect to ${token}`);
    },
    timeoutMs: 1000
  });
  assert.equal(JSON.stringify(client), '{}');
  await assert.rejects(client.getRepository('example', 'repo'), error => {
    assert.equal(error.message, 'GitHub API request failed or timed out.');
    assert.equal(error.message.includes(token), false);
    return true;
  });
  await assert.rejects(client.request('https://attacker.example/repos/example/repo'), /host is not approved/);
  assert.equal(fetchCalls, 1);
});

test('GitHub client does not allow request options to override its auth header', async () => {
  let observedAuthorization;
  const client = new GitHubClient('expected-token', {
    maxRetries: 0,
    fetchImpl: async (_url, options) => {
      observedAuthorization = options.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ full_name: 'example/repo' }) };
    }
  });
  await client.request('/repos/example/repo', { headers: { Authorization: 'Bearer attacker-token' } });
  assert.equal(observedAuthorization, 'Bearer expected-token');
});

test('GitHub client retries rate limits and does not treat a later-page 404 as a complete list', async () => {
  let attempts = 0;
  const delays = [];
  const client = new GitHubClient('fake-token', {
    maxRetries: 1,
    sleep: async milliseconds => delays.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, status: 429, headers: { get: name => name === 'retry-after' ? '0' : null } }
        : { ok: true, status: 200, json: async () => ({ full_name: 'example/repo' }) };
    }
  });
  assert.equal((await client.getRepository('example', 'repo')).full_name, 'example/repo');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [0]);

  let secondaryLimitAttempts = 0;
  const secondaryLimitClient = new GitHubClient('fake-token', {
    maxRetries: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      secondaryLimitAttempts += 1;
      return secondaryLimitAttempts === 1
        ? { ok: false, status: 403, headers: { get: name => name === 'retry-after' ? '0' : null } }
        : { ok: true, status: 200, json: async () => ({ full_name: 'example/repo' }) };
    }
  });
  assert.equal((await secondaryLimitClient.getRepository('example', 'repo')).full_name, 'example/repo');
  assert.equal(secondaryLimitAttempts, 2);

  let page = 0;
  const partialListClient = new GitHubClient('fake-token', {
    maxRetries: 0,
    fetchImpl: async url => {
      page += 1;
      return page === 1
        ? {
          ok: true, status: 200,
          headers: { get: name => name === 'link' ? `<${new URL(url).origin}${new URL(url).pathname}?per_page=100&page=2>; rel="next"` : null },
          json: async () => [{ name: 'branch-one' }]
        }
        : { ok: false, status: 404 };
    }
  });
  await assert.rejects(partialListClient.getBranches('example', 'repo'), /partial results/);
});

test('GitHub branch and tag lists follow Link pagination and deduplicate overlapping records', async () => {
  const requests = [];
  const client = new GitHubClient('fake-token', {
    fetchImpl: async url => {
      const request = new URL(url);
      requests.push(request);
      const isBranch = request.pathname.endsWith('/branches');
      const page = requests.filter(previous => previous.pathname === request.pathname).length;
      const nextUrl = `${request.origin}${request.pathname}?per_page=100&page=2`;
      return {
        ok: true,
        status: 200,
        headers: { get: name => name === 'link' && page === 1 ? `<${nextUrl}>; rel="next"` : null },
        json: async () => isBranch
          ? page === 1 ? [{ name: 'main' }, { name: 'release' }] : [{ name: 'release' }, { name: 'feature' }]
          : page === 1 ? [{ name: 'v1' }] : [{ name: 'v2' }]
      };
    },
    timeoutMs: 1000
  });
  const branches = await client.getBranches('example', 'repo');
  assert.deepEqual(branches.map(branch => branch.name), ['main', 'release', 'feature']);
  const tags = await client.getTags('example', 'repo');
  assert.deepEqual(tags.map(tag => tag.name), ['v1', 'v2']);
  assert.equal(requests.length, 4);
});

test('GitHub client throws on permission and server errors instead of treating them as missing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 403, ok: false });
  try {
    const client = new GitHubClient('fake-token');
    await assert.rejects(() => client.getRepository('example', 'repo'), /GitHub API request failed with status 403/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Git mirror rejects untrusted ADO and GitHub hosts before using credentials', async () => {
  const { mirrorRepository } = await import('../src/lib/git.mjs');
  let gitCalls = 0;
  const parameters = {
    adoOrgUrl: 'https://dev.azure.com/example',
    adoPat: 'dummy-source-token',
    githubToken: 'dummy-target-token',
    workDir: '/tmp/unused-gitbridge-test.git',
    gitExec: async () => { gitCalls += 1; throw new Error('must not execute'); }
  };
  await assert.rejects(() => mirrorRepository({
    ...parameters,
    sourceUrl: 'https://attacker.example/project/_git/repo',
    targetUrl: 'https://github.com/example/repo.git'
  }), /Azure DevOps URL host is not approved/);
  await assert.rejects(() => mirrorRepository({
    ...parameters,
    sourceUrl: 'https://dev.azure.com/other/project/_git/repo',
    targetUrl: 'https://github.com/example/repo.git'
  }), /does not match the configured organization/);
  await assert.rejects(() => mirrorRepository({
    ...parameters,
    sourceUrl: 'https://dev.azure.com/example/project/_git/repo',
    targetUrl: 'https://attacker.example/example/repo.git'
  }), /GitHub repository URL host is not approved/);
  assert.equal(gitCalls, 0);
});

test('Git clone authentication failures are redacted and remove temporary askpass files', async () => {
  const { access } = await import('node:fs/promises');
  const { cloneMirrorRepository } = await import('../src/lib/git.mjs');
  const pat = 'ado-auth-secret-do-not-print';
  let askpassPath;
  await assert.rejects(cloneMirrorRepository({
    sourceUrl: 'https://dev.azure.com/example/Project/_git/Repo',
    adoOrgUrl: 'https://dev.azure.com/example',
    adoPat: pat,
    workDir: '/tmp/gitbridge-auth-failure-test.git',
    gitExec: async (_command, _args, options) => {
      askpassPath = options.env.GIT_ASKPASS;
      assert.equal(options.env.GIT_AUTH_TOKEN, pat);
      throw Object.assign(new Error(`authentication failed: ${pat}`), { code: 128 });
    }
  }), error => {
    assert.equal(error.message, 'Git clone failed (exit 128).');
    assert.equal(error.message.includes(pat), false);
    return true;
  });
  await assert.rejects(access(askpassPath));
});

test('Git push authentication failure forwards only to askpass and cleans up', async () => {
  const { mkdtemp, mkdir, writeFile, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { pushMirrorRepository } = await import('../src/lib/git.mjs');
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'gitbridge-push-auth-test-'));
  const token = 'github-auth-secret-do-not-print';
  let askpassPath;
  try {
    const work = join(root, 'work');
    const repository = join(root, 'repo.git');
    await mkdir(work);
    await exec('git', ['init', '-b', 'main', work]);
    await exec('git', ['-C', work, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', work, 'config', 'user.name', 'GitBridge Test']);
    await writeFile(join(work, 'README.md'), 'fixture\n');
    await exec('git', ['-C', work, 'add', 'README.md']);
    await exec('git', ['-C', work, 'commit', '-m', 'initial']);
    await exec('git', ['clone', '--bare', work, repository]);

    await assert.rejects(pushMirrorRepository({
      targetUrl: 'https://github.com/example/repo.git',
      githubToken: token,
      workDir: repository,
      gitExec: async (_command, _args, options) => {
        askpassPath = options.env.GIT_ASKPASS;
        assert.equal(options.env.GIT_AUTH_TOKEN, token);
        throw Object.assign(new Error(`authentication failed: ${token}`), { code: 128 });
      }
    }), error => {
      assert.equal(error.message, 'Git push failed (exit 128).');
      assert.equal(error.message.includes(token), false);
      return true;
    });
    await assert.rejects(access(askpassPath));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git mirror engine transfers branches and tags between local bare repositories', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mirrorRepository, readMirrorRefs } = await import('../src/lib/git.mjs');
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'gitbridge-test-'));
  try {
    const work = join(root, 'work'); const source = join(root, 'source.git'); const target = join(root, 'target.git');
    await mkdir(work);
    await exec('git', ['init', '-b', 'main', work]);
    await exec('git', ['-C', work, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', work, 'config', 'user.name', 'GitBridge Test']);
    await (await import('node:fs/promises')).writeFile(join(work, 'README.md'), 'fixture\n');
    await exec('git', ['-C', work, 'add', 'README.md']);
    await exec('git', ['-C', work, 'commit', '-m', 'initial']);
    await exec('git', ['-C', work, 'tag', 'v1.0.0']);
    await (await import('node:fs/promises')).writeFile(join(work, 'README.md'), 'second commit\n');
    await exec('git', ['-C', work, 'add', 'README.md']);
    await exec('git', ['-C', work, 'commit', '-m', 'second']);
    await exec('git', ['-C', work, 'checkout', '-b', 'feature']);
    await (await import('node:fs/promises')).writeFile(join(work, 'feature.txt'), 'feature commit\n');
    await exec('git', ['-C', work, 'add', 'feature.txt']);
    await exec('git', ['-C', work, 'commit', '-m', 'feature']);
    await exec('git', ['-C', work, 'tag', 'v2.0.0']);
    for (let commitIndex = 0; commitIndex < 20; commitIndex += 1) {
      const path = join(work, `history-${commitIndex}.txt`);
      await (await import('node:fs/promises')).writeFile(path, `fixture commit ${commitIndex}\n`);
      await exec('git', ['-C', work, 'add', path]);
      await exec('git', ['-C', work, 'commit', '-m', `fixture ${commitIndex}`]);
    }
    await exec('git', ['clone', '--bare', work, source]);
    await exec('git', ['init', '--bare', target]);
    const mirrorDir = join(root, 'mirror.git');
    await mirrorRepository({ sourceUrl: source, targetUrl: target, adoPat: 'dummy-source-token', githubToken: 'dummy-target-token', workDir: mirrorDir });
    const refs = await readMirrorRefs(mirrorDir);
    const names = refs.map(x => x.ref);
    assert.ok(names.includes('refs/heads/main'));
    assert.ok(names.includes('refs/heads/feature'));
    assert.ok(names.includes('refs/tags/v1.0.0'));
    assert.ok(names.includes('refs/tags/v2.0.0'));
    const targetRefs = await exec('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname)']);
    assert.match(targetRefs.stdout, /refs\/heads\/main/);
    assert.match(targetRefs.stdout, /refs\/heads\/feature/);
    assert.match(targetRefs.stdout, /refs\/tags\/v1\.0\.0/);
    const sourceRefs = await exec('git', ['--git-dir', source, 'for-each-ref', '--format=%(refname) %(objectname)']);
    const pushedRefs = await exec('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname) %(objectname)']);
    assert.deepEqual(pushedRefs.stdout.trim().split('\n').sort(), sourceRefs.stdout.trim().split('\n').sort());
    const history = await exec('git', ['--git-dir', target, 'rev-list', '--all', '--count']);
    assert.equal(Number(history.stdout.trim()), 23);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git mirror handles an empty bare source and target', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mirrorRepository, readMirrorRefs } = await import('../src/lib/git.mjs');
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'gitbridge-empty-test-'));
  try {
    const source = join(root, 'empty-source.git');
    const target = join(root, 'empty-target.git');
    const mirror = join(root, 'mirror.git');
    await exec('git', ['init', '--bare', source]);
    await exec('git', ['init', '--bare', target]);
    await mirrorRepository({ sourceUrl: source, targetUrl: target, adoPat: 'dummy-source-token', githubToken: 'dummy-target-token', workDir: mirror });
    assert.deepEqual(await readMirrorRefs(mirror), []);
    const targetRefs = await exec('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname)']);
    assert.equal(targetRefs.stdout.trim(), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git mirror push failures are sanitized and do not update a rejecting local target', async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mirrorRepository } = await import('../src/lib/git.mjs');
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'gitbridge-reject-test-'));
  try {
    const work = join(root, 'work');
    const source = join(root, 'source.git');
    const target = join(root, 'target.git');
    await exec('git', ['init', '-b', 'main', work]);
    await exec('git', ['-C', work, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', work, 'config', 'user.name', 'GitBridge Test']);
    await (await import('node:fs/promises')).writeFile(join(work, 'README.md'), 'fixture\n');
    await exec('git', ['-C', work, 'add', 'README.md']);
    await exec('git', ['-C', work, 'commit', '-m', 'initial']);
    await exec('git', ['clone', '--bare', work, source]);
    await exec('git', ['init', '--bare', target]);
    const hook = join(target, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o700);

    await assert.rejects(
      mirrorRepository({ sourceUrl: source, targetUrl: target, adoPat: 'dummy-source-token', githubToken: 'dummy-target-token', workDir: join(root, 'mirror.git') }),
      error => {
        assert.equal(error.message, 'Git push failed (exit 1).');
        assert.equal(error.message.includes('dummy-target-token'), false);
        return true;
      }
    );
    const refs = await exec('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname)']);
    assert.equal(refs.stdout.trim(), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
