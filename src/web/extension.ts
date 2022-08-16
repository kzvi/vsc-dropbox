import * as vscode from 'vscode';
import { DropboxFSP } from './fsprovider';

export function activate(context: vscode.ExtensionContext) {
	let fsp = new DropboxFSP(context);

	context.subscriptions.push(vscode.commands.registerCommand('dropbox.open', () => {
		vscode.workspace.updateWorkspaceFolders(0, Infinity, { uri: vscode.Uri.parse('dropbox:/'), name: 'Dropbox' });
	}));

	context.subscriptions.push(vscode.commands.registerCommand('dropbox.authenticate', () => {
		fsp.doAuthenticationUI();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('dropbox.unauthenticate', () => {
		fsp.unauthenticate();
	}));

	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('dropbox', fsp, { isCaseSensitive: false }));
}

export function deactivate() { }
