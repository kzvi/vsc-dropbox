import * as vscode from 'vscode';
import * as dropbox from 'dropbox';
import { Mutex } from 'async-mutex';

const APP_KEY = 'zw6j93gdix6ar6d';

// todo: handle symlinks
// todo: respect create flag in writeFile
// todo: make sure parent folder exists before writing file or directory
// todo: handle insufficient permissions

// todo: implement watch, and then:
// todo: respect "backoff" response in watch
// todo: respect excludes parameter in watch
// todo: handle "reset" response in watch
// todo: correctly set file change type for onDidChangeFile

export class DropboxFSP implements vscode.FileSystemProvider {
    onDidChangeFileEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]>;
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;

    extensionContext: vscode.ExtensionContext;

    cachedDropboxAuth?: dropbox.DropboxAuth;
    userDeniedAuth: boolean;
    authMutex: Mutex;

    constructor(context: vscode.ExtensionContext) {
        this.onDidChangeFileEmitter = new vscode.EventEmitter();
        this.onDidChangeFile = this.onDidChangeFileEmitter.event;
        context.subscriptions.push(this.onDidChangeFileEmitter);

        this.extensionContext = context;

        this.userDeniedAuth = false;
        this.authMutex = new Mutex();
    }

    async _getDropboxInstance(): Promise<dropbox.Dropbox> {
        return await this.authMutex.runExclusive(async () => {
            let auth;
            if (this.cachedDropboxAuth) {
                auth = this.cachedDropboxAuth;
            } else {
                let accessToken = await this.extensionContext.secrets.get('dropbox.accessToken');
                let refreshToken = await this.extensionContext.secrets.get('dropbox.refreshToken');
                if (!accessToken || !refreshToken) {
                    if (this.userDeniedAuth) {
                        throw new Error('Dropbox not authenticated');
                    }
                    let resp = await vscode.window.showErrorMessage(
                        'Dropbox not authenticated. Authenticate now?',
                        { modal: true },
                        'Yes',
                        'No'
                    );
                    if (resp == 'Yes') {
                        await this.doAuthenticationUI();
                    } else {
                        this.userDeniedAuth = true;
                        throw new Error('Dropbox not authenticated');
                    }
                    accessToken = await this.extensionContext.secrets.get('dropbox.accessToken');
                    refreshToken = await this.extensionContext.secrets.get('dropbox.refreshToken');
                }
                auth = new dropbox.DropboxAuth({
                    clientId: APP_KEY,
                    accessToken,
                    refreshToken,
                });
                this.cachedDropboxAuth = auth;
            }
            await auth.checkAndRefreshAccessToken();
            return new dropbox.Dropbox({ auth });
        });
    }

    async doAuthenticationUI() {
        let auth = new dropbox.DropboxAuth({ clientId: APP_KEY });
        // @ts-ignore
        let url: string = await auth.getAuthenticationUrl(null, null, 'code', 'offline', null, 'none', true);
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
        let code = await vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Enter access code from Dropbox:' });
        if (!code)
            return;
        let response: any;
        try {
            // @ts-ignore
            response = (await auth.getAccessTokenFromCode(null, code)).result;
        } catch (e) {
            vscode.window.showErrorMessage(`Error in Dropbox authentication: ${e}`);
            throw e;
        }
        await this.extensionContext.secrets.store('dropbox.accessToken', response.access_token);
        await this.extensionContext.secrets.store('dropbox.refreshToken', response.refresh_token);
        this.cachedDropboxAuth = undefined;
    }

    async unauthenticate() {
        return await this.authMutex.runExclusive(async () => {
            await this.extensionContext.secrets.delete('dropbox.accessToken');
            await this.extensionContext.secrets.delete('dropbox.refreshToken');
            this.cachedDropboxAuth = undefined;
        });
    }

    watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => { });
        // let path = uri.path === '/' ? '' : uri.path;
        // let stop = true;
        // (async () => {
        //     let cursor;
        //     {
        //         let args = {
        //             path,
        //             include_mounted_folders: true,
        //             recursive: options.recursive
        //         };
        //         let response;
        //         try {
        //             response = (await wrapApiCall(this.dropbox.filesListFolderGetLatestCursor(args), { fnf: true })).result;
        //         } catch (e) {
        //             vscode.window.showInformationMessage(`watching ${uri}: error ${e}`);
        //             return;
        //         }
        //         cursor = response.cursor;
        //     }
        //     while (!stop) {
        //         let longpollResponse = (await wrapApiCall(this.dropbox.filesListFolderLongpoll({ cursor }))).result;
        //         if (stop)
        //             return;
        //         if (longpollResponse.changes) {
        //             let response: dropbox.files.ListFolderResult = (await wrapApiCall(this.dropbox.filesListFolderContinue({ cursor }), { fnf: true })).result;
        //             let events = [];
        //             for (let entry of response.entries) {
        //                 if (!entry.path_lower) {
        //                     continue;
        //                 }
        //                 let uri = vscode.Uri.joinPath(vscode.Uri.parse('dropbox:/'), entry.path_lower);
        //                 let type;
        //                 if (entry['.tag'] == 'deleted') {
        //                     type = vscode.FileChangeType.Deleted;
        //                 } else {
        //                     type = vscode.FileChangeType.Changed;
        //                 }
        //                 events.push({ uri, type });
        //             }
        //             this.onDidChangeFileEmitter.fire(events);
        //             cursor = response.cursor;
        //         }
        //     }
        // })();
        // return new vscode.Disposable(() => { stop = true; });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        let db = await this._getDropboxInstance();
        if (uri.path === '/') {
            let now = Date.now();
            return {
                ctime: now,
                mtime: now,
                size: 0,
                type: vscode.FileType.Directory,
            };
        }
        let response = (await wrapApiCall(db.filesGetMetadata({ path: uri.path }), { fnf: true })).result;
        if (response['.tag'] === 'file') {
            let mtime = Date.parse(response.server_modified);
            return {
                ctime: mtime,
                mtime: mtime,
                size: response.size,
                type: vscode.FileType.File,
            };
        } else if (response['.tag'] === 'folder') {
            let now = Date.now();
            return {
                ctime: now,
                mtime: now,
                size: 0,
                type: vscode.FileType.Directory,
            };
        } else {
            throw new Error();
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        let db = await this._getDropboxInstance();
        let path = uri.path === '/' ? '' : uri.path;
        let responses = [];
        responses.push((await wrapApiCall(db.filesListFolder({ path, include_mounted_folders: true }), { fnf: true })).result);
        while (responses[responses.length - 1].has_more) {
            let cursor: string = responses[responses.length - 1].cursor;
            responses.push((await wrapApiCall(db.filesListFolderContinue({ cursor }))).result);
        }
        let result: [string, vscode.FileType][] = [];
        for (let response of responses) {
            for (let entry of response.entries) {
                if (entry['.tag'] === 'file') {
                    result.push([entry.name, vscode.FileType.File]);
                } else if (entry['.tag'] === 'folder') {
                    result.push([entry.name, vscode.FileType.Directory]);
                } else {
                    throw new Error();
                }
            }
        }
        return result;
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        let db = await this._getDropboxInstance();
        let response: any = (await wrapApiCall(db.filesDownload({ path: uri.path }), { fnf: true })).result;
        let reader = new FileReader();
        let p: Promise<ArrayBuffer> = new Promise(resolve => {
            reader.addEventListener("loadend", () => {
                // @ts-ignore
                resolve(reader.result);
            });
        });
        reader.readAsArrayBuffer(response.fileBlob);
        return new Uint8Array(await p);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }) {
        let db = await this._getDropboxInstance();
        let requestArg = {
            contents: content,
            path: uri.path,
            mode: { '.tag': options.overwrite ? 'overwrite' : 'add' },
        };
        // @ts-ignore
        await wrapApiCall(db.filesUpload(requestArg), { exists: true });
    }

    async createDirectory(uri: vscode.Uri) {
        let db = await this._getDropboxInstance();
        await wrapApiCall(db.filesCreateFolderV2({ path: uri.path })), { exists: true };
    }

    async delete(uri: vscode.Uri, options: { readonly recursive: boolean; }) {
        let db = await this._getDropboxInstance();
        await wrapApiCall(db.filesDeleteV2({ path: uri.path }), { fnf: true });
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }) {
        let db = await this._getDropboxInstance();
        if (options.overwrite) {
            try {
                await wrapApiCall(db.filesDeleteV2({ path: newUri.path }), { fnf: true });
            } catch (e) {
                if (!(e instanceof vscode.FileSystemError)) {
                    throw e;
                }
            }
        }
        await wrapApiCall(db.filesMoveV2({ from_path: oldUri.path, to_path: newUri.path }), { fnf: true, exists: true });
    }
}

async function wrapApiCall<T>(f: Promise<T>, options: any = {}): Promise<T> {
    try {
        return await f;
    } catch (e) {
        if (e instanceof dropbox.DropboxResponseError) {
            if (options.fnf && e.error?.error_summary?.startsWith('path/not_found')) {
                throw vscode.FileSystemError.FileNotFound();
            }
            if (options.exists && e.error?.error_summary?.startsWith('path/conflict')) {
                throw vscode.FileSystemError.FileExists();
            }
            // @ts-ignore
            let msg = `Dropbox error: ${e.message}`;
            if (e.error?.error_summary) {
                msg += `\nSummary: ${e.error.error_summary}`;
            }
            vscode.window.showErrorMessage(msg);
        }
        throw e;
    }
}