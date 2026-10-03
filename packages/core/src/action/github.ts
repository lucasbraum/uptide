export interface PullEvent {
  action: string;
  number: number;
  repository: { full_name: string };
  pull_request: {
    user: { login: string };
    head: { sha: string; ref: string; repo: { full_name: string } | null };
    base: { sha: string; repo: { full_name: string } };
  };
}
export const MARKER = '<!-- uptide:dependency-migration -->';
export function eligible(event: PullEvent, repository: string): string | undefined {
  if (!['opened', 'synchronize', 'reopened'].includes(event.action))
    return 'event is not a pull request update';
  if (!['renovate[bot]', 'dependabot[bot]'].includes(event.pull_request.user.login))
    return 'PR author is not Renovate or Dependabot';
  if (
    event.repository.full_name !== repository ||
    event.pull_request.base.repo.full_name !== repository ||
    event.pull_request.head.repo?.full_name !== repository
  )
    return 'fork PRs are not eligible for authenticated migration';
  if (
    !/^[\da-f]{40}$/.test(event.pull_request.head.sha) ||
    !/^[\da-f]{40}$/.test(event.pull_request.base.sha)
  )
    throw new Error('invalid PR commit');
  return undefined;
}
export interface PullComments {
  comment(body: string): Promise<void>;
  head(): Promise<string>;
}
export function githubComments(
  repository: string,
  number: number,
  token: string,
  api = 'https://api.github.com',
  fetcher = fetch,
): PullComments {
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetcher(`${api}/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok)
      throw new Error(
        `GitHub ${method} ${path}: HTTP ${r.status} (comment/push credentials need write permission)`,
      );
    return r.status === 204 ? undefined : await r.json();
  };
  let identity: Promise<string | undefined> | undefined;
  const login = () =>
    (identity ??= fetcher(`${api}/user`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    }).then(async (r) => (r.ok ? ((await r.json()) as { login?: string }).login : undefined)));
  return {
    async head() {
      return ((await request(`/pulls/${number}`)) as { head: { sha: string } }).head.sha;
    },
    async comment(body) {
      const author = await login();
      let existing: { id: number } | undefined;
      for (let page = 1; ; page++) {
        const items = (await request(`/issues/${number}/comments?per_page=100&page=${page}`)) as {
          id: number;
          body: string;
          user: { type: string; login?: string };
        }[];
        existing = items.find(
          (c) =>
            c.body.startsWith(MARKER) && (author ? c.user.login === author : c.user.type === 'Bot'),
        );
        if (existing || items.length < 100) break;
      }
      const content = { body: `${MARKER}\n${body}` };
      if (existing) await request(`/issues/comments/${existing.id}`, 'PATCH', content);
      else await request(`/issues/${number}/comments`, 'POST', content);
    },
  };
}
