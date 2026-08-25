import type { AgentFloatingPosition } from "../../agent-floating-position";
import type { AgentDatabaseReadResult, AgentDatabaseSqlSuggestion, AgentSshCommandSuggestion, AgentSshDiagnosticResult, AgentSshScriptSuggestion, AgentVironToolApprovalSuggestion } from "../../../shared/agent";

export interface AgentOverlayDragState {
    startX: number;
    startY: number;
    origin: AgentFloatingPosition;
}

export type AgentSshSuggestionState = AgentSshCommandSuggestion & {
    id: string;
    runId?: string;
    executing?: boolean;
    cancelling?: boolean;
    result?: AgentSshDiagnosticResult;
    error?: string;
};

export type AgentDatabaseSuggestionState = AgentDatabaseSqlSuggestion & {
    id: string;
    runId?: string;
    executing?: boolean;
    cancelling?: boolean;
    result?: AgentDatabaseReadResult;
    error?: string;
};

export type AgentSshScriptSuggestionState = AgentSshScriptSuggestion & {
    id: string;
};

export type AgentVironApprovalState = Omit<AgentVironToolApprovalSuggestion, "input"> & {
    input: unknown;
    id: string;
    executing?: boolean;
    error?: string;
};

