import type { CommentId, IssueNumber } from "../ids.js";
import type { GitHubPort, IssueComment } from "../ports/github.js";
import { defineIntent, type IntentJournal } from "./intents.js";

// Every comment the Orchestrator writes carries this marker, so its own comments are never read as Answers.
export const AUTO_DEV_MARKER = "<!-- auto-dev -->";

// A second marker with a key unique to the occasion (request, verdict, final comment) makes posting idempotent.
export const commentMarker = (key: string): string => `<!-- auto-dev:${key} -->`;

export const isMarkedComment = (body: string, key?: string): boolean =>
  body.includes(AUTO_DEV_MARKER) && (key === undefined || body.includes(commentMarker(key)));

export const markedCommentBody = (key: string, text: string): string => `${text}\n\n${AUTO_DEV_MARKER}\n${commentMarker(key)}`;

export type PostCommentPayload = { key: string; body: string };
export type PostCommentResult = { commentId: CommentId };

export const POST_COMMENT = defineIntent<PostCommentPayload, PostCommentResult>("post-comment");

export type CommentsOptions = {
  github: GitHubPort;
  journal: IntentJournal;
};

// Comments of the Orchestrator in issues: requests to the human, verdicts, final notes.
export class Comments {
  private readonly _github: GitHubPort;
  private readonly _journal: IntentJournal;

  constructor(options: CommentsOptions) {
    this._github = options.github;
    this._journal = options.journal;
    this._journal.handle(POST_COMMENT, (payload, intent) => this._post(intent.issueNumber, payload));
  }

  // Posts `text` once per `key` in the issue; a repeated call returns the comment already there.
  async post(issueNumber: IssueNumber, key: string, text: string): Promise<IssueComment> {
    const existing = await this.find(issueNumber, key);
    if (existing) return existing;
    const { commentId } = await this._journal.run(POST_COMMENT, issueNumber, { key, body: markedCommentBody(key, text) });
    const posted = (await this._github.listIssueComments(issueNumber)).find((comment) => comment.id === commentId);
    if (!posted) throw new Error(`comment ${commentId} vanished right after posting in issue #${issueNumber}`);
    return posted;
  }

  async find(issueNumber: IssueNumber, key: string): Promise<IssueComment | undefined> {
    const comments = await this._github.listIssueComments(issueNumber);
    return comments.find((comment) => isMarkedComment(comment.body, key));
  }

  private async _post(issueNumber: IssueNumber, payload: PostCommentPayload): Promise<PostCommentResult> {
    const existing = await this.find(issueNumber, payload.key);
    const comment = existing ?? (await this._github.createIssueComment(issueNumber, payload.body));
    return { commentId: comment.id };
  }
}
