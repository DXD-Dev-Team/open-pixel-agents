import * as vscode from 'vscode';
import { PixelAgentsViewProvider } from './PixelAgentsViewProvider.js';
import { VIEW_ID, COMMAND_SHOW_PANEL, COMMAND_EXPORT_DEFAULT_LAYOUT } from './constants.js';
import type { OfficeBridgeApi } from './officeBridge.js';

let providerInstance: PixelAgentsViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): OfficeBridgeApi {
	const provider = new PixelAgentsViewProvider(context);
	providerInstance = provider;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } })
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
			vscode.commands.executeCommand(`${VIEW_ID}.focus`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
			provider.exportDefaultLayout();
		})
	);

	return {
		version: 1,
		getServer: () => provider.getServerConnection(),
		createAgent: (input) => provider.createManagedAgent(input),
		listAgents: () => provider.listManagedAgents(),
		focusAgent: (agentId) => provider.focusManagedAgent(agentId),
		closeAgent: (agentId) => provider.closeManagedAgent(agentId),
	};
}

export function deactivate() {
	providerInstance?.dispose();
}
