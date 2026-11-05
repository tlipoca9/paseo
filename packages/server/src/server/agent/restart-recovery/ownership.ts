interface RecoveryFailure {
  reason: "unavailable" | "superseded" | "scope_conflict" | "missing_execution";
  agentId?: string;
  runId?: string;
}

const messages: Record<RecoveryFailure["reason"], string> = {
  unavailable: "Execution recovery requires a durable agent record.",
  superseded: "The captured execution has been superseded.",
  scope_conflict: "The execution already belongs to another delivery scope.",
  missing_execution: "A captured execution is required.",
};

export class ExecutionRecoveryError extends Error {
  readonly reason: RecoveryFailure["reason"];
  readonly agentId: string | undefined;
  readonly runId: string | undefined;
  constructor(failure: RecoveryFailure) {
    super(messages[failure.reason]);
    this.name = "ExecutionRecoveryError";
    this.reason = failure.reason;
    this.agentId = failure.agentId;
    this.runId = failure.runId;
  }
}
