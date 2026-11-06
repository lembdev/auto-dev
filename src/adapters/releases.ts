import type { Release, ReleasesPort } from "../ports/releases.js";
import { DEFAULT_GITHUB_API_URL, GITHUB_API_VERSION, type FetchLike } from "./github.js";

// The repository this Installation updates from; its releases are public, so no token is needed.
export const RELEASES_REPO = "lembdev/auto-dev";

export type GitHubReleasesOptions = {
  userAgent: string;
  repo?: string;
  fetch?: FetchLike;
  baseUrl?: string;
};

type ReleaseBody = { tag_name?: unknown; html_url?: unknown; published_at?: unknown };

export class ReleasesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReleasesError";
  }
}

// Tags are `vX.Y.Z`; the version compared with package.json has no `v`.
export const versionOfTag = (tag: string): string => tag.replace(/^v/, "");

// `GET /repos/{repo}/releases/latest`: the release marked latest, pre-releases excluded by GitHub itself.
export class GitHubReleasesAdapter implements ReleasesPort {
  private readonly _fetch: FetchLike;
  private readonly _url: string;
  private readonly _userAgent: string;

  constructor(options: GitHubReleasesOptions) {
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._url = `${options.baseUrl ?? DEFAULT_GITHUB_API_URL}/repos/${options.repo ?? RELEASES_REPO}/releases/latest`;
    this._userAgent = options.userAgent;
  }

  async findLatest(): Promise<Release | undefined> {
    const response = await this._fetch(this._url, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": GITHUB_API_VERSION, "user-agent": this._userAgent },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new ReleasesError(response.status, `GitHub answered ${response.status} to the release check`);
    const body = (await response.json()) as ReleaseBody;
    if (typeof body.tag_name !== "string") throw new ReleasesError(response.status, "release without a tag name");
    return {
      version: versionOfTag(body.tag_name),
      htmlUrl: typeof body.html_url === "string" ? body.html_url : `https://github.com/${RELEASES_REPO}/releases/tag/${body.tag_name}`,
      publishedAt: typeof body.published_at === "string" ? body.published_at : null,
    };
  }
}
