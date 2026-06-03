import { z } from "zod";

// The 9 live token_workflows states. The 3 dead ones (fees_pending,
// imperial_deposit_pending, profit_realize_pending) were removed. This is the
// app-side source of truth for inbound validation; it must stay in lockstep with
// keeper/src/workflow.js `State` and the token_workflows.state CHECK constraint.
export const WORKFLOW_STATES = [
  "idle",
  "fees_claimed",
  "split_reserved",
  "imperial_deposited",
  "position_open_pending",
  "position_open",
  "topup_pending",
  "blocked",
  "error",
] as const;

export const WorkflowState = z.enum(WORKFLOW_STATES);
