function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function config(value) {
  const parsed = object(value, "config");
  if (typeof parsed.repository !== "string" || !/^[^/]+\/[^/]+$/.test(parsed.repository)) {
    throw new TypeError("config.repository must be owner/name");
  }
  return {
    repository: parsed.repository,
    apiBaseUrl: typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl.replace(/\/$/u, "") : "https://api.github.com",
    perPage: Number.isInteger(parsed.perPage) && parsed.perPage >= 1 && parsed.perPage <= 100 ? parsed.perPage : 100,
  };
}

function cursorPage(value) {
  if (value === null) return 1;
  const parsed = object(value, "cursor");
  if (!Number.isInteger(parsed.page) || parsed.page < 1) throw new TypeError("cursor.page is invalid");
  return parsed.page;
}

function commitEvent(repository, commit, observedAt) {
  const author = commit.author?.login ?? commit.commit?.author?.name ?? null;
  const authoredAt = commit.commit?.author?.date;
  const occurredAt = commit.commit?.committer?.date;
  if (typeof commit.sha !== "string" || typeof occurredAt !== "string") throw new TypeError("GitHub commit is invalid");
  return {
    id: `github.commit:${repository}:${commit.sha}`,
    externalId: commit.sha,
    type: "github.commit.created",
    schemaVersion: 1,
    occurredAt,
    observedAt,
    payload: {
      repository,
      sha: commit.sha,
      message: typeof commit.commit?.message === "string" ? commit.commit.message : "",
      author,
      authoredAt: typeof authoredAt === "string" ? authoredAt : null,
      url: typeof commit.html_url === "string" ? commit.html_url : null,
    },
  };
}

export async function execute(ctx, input) {
  const settings = config(input.config);
  const page = cursorPage(input.cursor);
  const result = await ctx.run(`github-commits-page-${page}`, async () => {
    const url = new URL(`/repos/${settings.repository}/commits`, settings.apiBaseUrl);
    url.searchParams.set("since", input.from);
    url.searchParams.set("until", input.to);
    url.searchParams.set("per_page", String(settings.perPage));
    url.searchParams.set("page", String(page));
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "event-hub" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    const commits = await response.json();
    if (!Array.isArray(commits)) throw new TypeError("GitHub API response is invalid");
    return { commits, hasMore: commits.length === settings.perPage };
  });
  return {
    events: result.commits.map((commit) => commitEvent(settings.repository, commit, input.to)),
    nextCursor: result.hasMore ? { page: page + 1 } : null,
    hasMore: result.hasMore,
  };
}
