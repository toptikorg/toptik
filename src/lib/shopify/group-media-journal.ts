import type { GroupMediaSnapshot } from "./group-media-policy";
import type { GroupMediaPhaseRequest } from "./group-media-transport";

export type GroupMediaPhaseRef = { productGid: string; operationId: string; phaseIndex: number; owner: string };
export type GroupMediaPhaseStatus = "prepared" | "started" | "uncertain" | "verified" | "review";
export type GroupMediaPhaseArtifact = { mediaId?: string; jobId?: string; [key: string]: unknown };
/** A service-only immutable operation, not a request body or a caller-supplied receipt. */
export type GroupMediaJournalAttempt = { status: GroupMediaPhaseStatus; attemptId: string | null;
  request: GroupMediaPhaseRequest | null; before: GroupMediaSnapshot; ack?: GroupMediaPhaseArtifact;
  artifact?: GroupMediaPhaseArtifact; observedGraph?: GroupMediaSnapshot;
  leaseExpiresAt: string };
export type GroupMediaJournalRecord = { action: "begin" | "ack" | "uncertain" | "recovered" | "review";
  attemptId: string; requestHash: string; requestJson: GroupMediaPhaseRequest;
  observedGraph?: GroupMediaSnapshot; artifact?: GroupMediaPhaseArtifact };
export type GroupMediaJournalResult = { status: GroupMediaPhaseStatus; mayExecute: boolean; leaseExpiresAt?: string };
/** The SQL adapter must re-check the product lease after waiting, use a payload-bound operation ID,
 * and grant begin.mayExecute once only. Neither an ack nor an unchanged snapshot is verification.
 * recovered must validate the full graph and this exact frozen phase before advancing its cursor. */
export interface GroupMediaJournalPort {
  read(ref: GroupMediaPhaseRef, deadline: number): Promise<GroupMediaJournalAttempt>;
  record(ref: GroupMediaPhaseRef, record: GroupMediaJournalRecord, deadline: number): Promise<GroupMediaJournalResult>;
}
