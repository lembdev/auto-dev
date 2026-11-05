// Branded identifiers shared by ports, the runtime index and the API.
// The brand name equals the type name; raw values are converted with `as` at the boundary.

export type IssueNumber = number & { __brand: "IssueNumber" };
export type IssueId = number & { __brand: "IssueId" };
export type CommentId = number & { __brand: "CommentId" };
export type PullNumber = number & { __brand: "PullNumber" };
export type MilestoneNumber = number & { __brand: "MilestoneNumber" };
export type SessionId = string & { __brand: "SessionId" };
export type Pid = number & { __brand: "Pid" };
export type AgentId = number & { __brand: "AgentId" };
export type IntentId = number & { __brand: "IntentId" };
