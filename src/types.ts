import type * as vscode from 'vscode';

export interface AgentState {
	id: number;
	terminalRef: vscode.Terminal;
	sessionId?: string;
	projectDir: string;
	serverPort?: number;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
}

export interface PersistedAgent {
	id: number;
	terminalName: string;
	sessionId?: string;
	projectDir: string;
	serverPort?: number;
}
