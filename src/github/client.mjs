const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function retryDelay(response, attempt) {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(60_000, Math.max(0, reset * 1000 - Date.now()));
  return Math.min(8_000, 250 * (2 ** attempt));
}

export class GitHubClient {
  #token;
  #fetch;
  #timeoutMs;
  #maxRetries;
  #sleep;

  constructor(token, { fetchImpl, timeoutMs = 30_000, maxRetries = 3, sleep = pause } = {}) {
    if (!token) throw new Error('GH_MIGRATION_TOKEN is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Error('Invalid GitHub API timeout or retry limit.');
    }
    this.#token = token;
    this.#fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
    this.#sleep = sleep;
  }
  #url(path) {
    let url;
    try { url = new URL(path, 'https://api.github.com'); }
    catch { throw new Error('GitHub API path is invalid.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password || url.port || url.hash) {
      throw new Error('GitHub API URL host is not approved.');
    }
    return url;
  }
  async #send(url, init = {}) {
    return this.#fetch(url.toString(), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs)
    });
  }
  async #sendWithRetry(url, init = {}) {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      let response;
      try { response = await this.#send(url, init); }
      catch {
        if (attempt === this.#maxRetries) throw new Error('GitHub API request failed or timed out.');
        await this.#sleep(Math.min(8_000, 250 * (2 ** attempt)));
        continue;
      }
      const secondaryRateLimit = response.status === 403 && Boolean(response.headers?.get?.('retry-after'));
      if ((retryableStatuses.has(response.status) || secondaryRateLimit) && attempt < this.#maxRetries) {
        await this.#sleep(retryDelay(response, attempt));
        continue;
      }
      return response;
    }
    throw new Error('GitHub API request failed.');
  }
  async request(path, init = {}) {
    const url = this.#url(path);
    const response = await this.#sendWithRetry(url, init);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}.`);
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new Error('GitHub API returned an invalid response.'); }
  }
  async #list(path) {
    let url = this.#url(path);
    const seenPages = new Set();
    const seenRecords = new Set();
    const items = [];
    for (let pageNumber = 0; url && pageNumber < 10_000; pageNumber += 1) {
      const currentUrl = url.toString();
      if (seenPages.has(currentUrl)) throw new Error('GitHub pagination returned a repeated page URL.');
      seenPages.add(currentUrl);

      const response = await this.#sendWithRetry(url);
      if (response.status === 404) {
        if (items.length === 0) return items;
        throw new Error('GitHub pagination failed with status 404 after returning partial results.');
      }
      if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}.`);

      let data;
      try { data = await response.json(); }
      catch { throw new Error('GitHub API returned an invalid response.'); }
      if (!Array.isArray(data)) throw new Error('GitHub API returned a malformed list response.');
      for (const item of data) {
        const key = item?.id ?? item?.node_id ?? item?.name;
        if (key !== undefined && key !== null && seenRecords.has(String(key))) continue;
        if (key !== undefined && key !== null) seenRecords.add(String(key));
        items.push(item);
      }

      const linkHeader = response.headers?.get?.('link') ?? '';
      const nextLink = linkHeader.split(',').find(link => /;\s*rel="?next"?/i.test(link));
      const nextUrl = nextLink?.match(/<([^>]+)>/)?.[1];
      url = nextUrl ? this.#url(nextUrl) : null;
    }
    if (url) throw new Error('GitHub pagination exceeded the configured page limit.');
    return items;
  }
  getRepository(owner, repo) { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`); }
  async assertRepositoryDoesNotExist(owner, repo) {
    const existing = await this.getRepository(owner, repo);
    if (existing) throw new Error(`Destination ${owner}/${repo} already exists. Refusing mirror push.`);
  }
  async createRepository(owner, name, isPrivate = true) {
    const result = await this.request(`/orgs/${encodeURIComponent(owner)}/repos`, {
      method: 'POST', body: JSON.stringify({ name, private: isPrivate, auto_init: false })
    });
    if (!result) throw new Error(`Could not create ${owner}/${name}; verify organization and token permissions.`);
    return result;
  }
  async getBranches(owner, repo) { return this.#list(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`); }
  async getTags(owner, repo) { return this.#list(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=100`); }
}
