// A published release of auto-dev itself, as the daily check sees it.
export type Release = {
  // Semantic version without the `v` of the tag.
  version: string;
  htmlUrl: string;
  publishedAt: string | null;
};

// Where new versions of the Installation come from: the GitHub Releases of this repository.
export interface ReleasesPort {
  // The release marked latest; undefined when none is published yet.
  findLatest(): Promise<Release | undefined>;
}
