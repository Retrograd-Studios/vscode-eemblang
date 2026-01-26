
//import { SerialPort } from 'serialport'

import * as toolchain from './../toolchain';
import * as cp from "child_process";
import * as readline from "readline";

import * as vscode from 'vscode';
import { getNonce } from './../util';
import * as fs from 'fs';
import { Config } from '../config';
import internal = require('stream');

import * as nodePath from 'path';

//const posixPath = nodePath.posix || nodePath;


export enum EFlashCmd {
    GET_PORT_LIST = 0,
    ERASE,
    FLASH
}


export class EFlasherClient {


    private portList: string[] = [];

    private execArgs: string[] = [];

    private currentProgress: number = 0;

    private isBusy = false;

    private panel: vscode.WebviewPanel | undefined = undefined;

    constructor(
        private readonly config: Config,
        private readonly context: vscode.ExtensionContext
    ) { }


    private async executeFlasher(cmdId: EFlashCmd): Promise<boolean> {

        if (this.isBusy) {
            return false;
        }

        await toolchain.resolveTarget(this.config);

        this.isBusy = true;

        const path = await toolchain.getPathForExecutable("eflash");


        const notificationLabels = [

            'Waiting...',
            'Waiting...',
            'Flashing...'

        ];

        const cmdArgs = [

            'portlist',
            'fast_erase',
            'flash'

        ];

        if (!path) {
            vscode.window.showErrorMessage("Can't find path to 'eflash'");
            this.isBusy = false;
            return false;
        }

        this.currentProgress = 0;

        const portId = this.config.get<string>('eflash.port');

        const isResetToDef = this.config.get<boolean>('eflash.isSetDefauls');
        const isForceErase = this.config.get<boolean>('eflash.isForceErase');

        const baudRateId = this.config.get<string>('eflash.baudrate');
        const parityId = this.config.get<string>('eflash.parity');
        const stopBitsId = this.config.get<string>('eflash.stopbits');

        let eflashArgs: string[] = cmdId == EFlashCmd.GET_PORT_LIST ? []
            : ['-port', portId, '-speed', baudRateId, '-parity', parityId, '-stopbits', stopBitsId];

        if (isForceErase) {
            eflashArgs.push('-fe');
        }

        if (isResetToDef) {
            eflashArgs.push('-sd');
        }

        let progPath = "./";

        if (cmdId == EFlashCmd.FLASH) {

            if (this.config.targetDevice.description == "[Device]") {
                    await vscode.commands.executeCommand('eepl.command.setTargetDevice');
                    if (this.config.targetDevice.description == "[Device]")
                    {
                        vscode.window.showErrorMessage('Target Device/Platform is not set.');
                        return false;
                    }
                }

            const ws = vscode.workspace.workspaceFolders? vscode.workspace.workspaceFolders[0] : undefined;
            if (!ws) {
                vscode.window.showErrorMessage('Workspace is not opened.');
                return false;
            }

            const cwd = ws.uri.fsPath;//"${cwd}";
            const devName = this.config.targetDevice.devName;
            progPath = this.config.uploadingFilePath;//  //`${cwd}/out/${devName}/prog.alf`;

            if (!fs.existsSync(progPath)) {
                const options: vscode.OpenDialogOptions = {
                    canSelectMany: false,
                    openLabel: 'Select App to Flash',
                    canSelectFiles: true,
                    canSelectFolders: false
                };
        
                await vscode.window.showOpenDialog(options).then(fileUri => {
                    if (fileUri && fileUri[0]) {
                        //console.log('Selected dir: ' + fileUri[0].fsPath);
                        progPath = fileUri[0].fsPath;
                    } else {
                        vscode.window.showErrorMessage(`File "${progPath} is not found.`);
                        return new Promise((resolve, reject) => {
                            reject(new Error(`File "${progPath} is not found.`));
                        });
                    }
                });
            } 

            eflashArgs.push(progPath);
            
        }

        // console.log(`Path raw: ${progPath}`);
        // console.log(`Path norm: ${posixPath.normalize(progPath)}`);
        // console.log(`Path: ${posixPath.dirname(progPath)}`);
        // console.log(`Path norm: ${posixPath.dirname(posixPath.normalize(progPath))}`);



        let eflash: cp.ChildProcessByStdio<null, internal.Readable, internal.Readable> | undefined = undefined;
        const promiseExec = new Promise((resolve, reject) => {

            eflash = cp.spawn(path, ["-nogui", "-cmd", cmdArgs[cmdId]].concat(eflashArgs), {
                stdio: ["ignore", "pipe", "pipe"], cwd: nodePath.dirname(progPath)
            }).on("error", (err) => {
                console.log("Error: ", err);
                reject(new Error(`could not launch eflash: ${err}`));
                //return false;
            }).on("exit", (exitCode, _) => {
                if (exitCode == 0) {
                    resolve("Done");
                }
                else {
                    //reject(exitCode);
                    reject(new Error(`exit code: ${exitCode}.`));
                }
            });


            eflash.stderr.on("data", (chunk) => {
                console.log(chunk.toString());
            });

            const rl = readline.createInterface({ input: eflash.stdout });
            rl.on("line", (line) => {

                const message = line.split(": ");

                if (message[0] == "Info") {
                    vscode.window.showInformationMessage("EFlasher: " + message[1]);
                } else if (message[0] == "Progress") {
                    this.currentProgress = Number.parseInt(message[1], 10);
                    //console.log("My Progress: "+this.currentProgress);
                } else if (message[0] == "Error") {
                    vscode.window.showErrorMessage("EFlasher: " + message[1]);
                } else if (message[0] == "PortName") {
                    this.portList.push(message[1]);
                }
            });

        });

            promiseExec.then(() => {
                result = true;
            }, () => {
                result = false;
            }).catch(() => {
                result = false;
            });

        let result: boolean | undefined = undefined;

        const prog = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: notificationLabels[cmdId],
            cancellable: true
        }, async (progress, token) => {

            progress.report({ message: "Waiting...", increment: -1 });

            token.onCancellationRequested(() => {
                result = false;
                if (eflash && eflash.exitCode == null) {
                    eflash.kill();
                }
            });
            


            let prevProgress = this.currentProgress;

            while (result == undefined) {

                if (cmdId >= EFlashCmd.FLASH) {
                    const stepProg = this.currentProgress - prevProgress;
                    prevProgress = this.currentProgress;
                    progress.report({ message: `${this.currentProgress}%`, increment: stepProg });
                    //console.log("Increment: "+stepProg);
                }

                if (token.isCancellationRequested) {
                    result = false;
                    if (eflash && eflash.exitCode == null) {
                        eflash.kill();
                    }
                    
                }

                await new Promise(f => setTimeout(f, 100));

            }

            return;

        });

        this.isBusy = false;

        return result!;

    }


    public async getPortList(): Promise<string[]> {

        this.portList = [];

        const result = await this.executeFlasher(EFlashCmd.GET_PORT_LIST);
        if (!result) {
            return [];
        }

        return this.portList;
    }


    private async openWebView() {

        if (this.panel) {
            const columnToShowIn = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
            this.panel.reveal(columnToShowIn);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'eflash', // Identifies the type of the webview. Used internally
                'EFlash config', // Title of the panel displayed to the user
                vscode.ViewColumn.One, // Editor column to show the new webview panel in.
                {
                    enableScripts: true
                } // Webview options. More on these later.
            );
        }

        this.panel.webview.html = await this.getHtmlForWebview(this.panel.webview);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'updatePortList': {
                        //vscode.window.showErrorMessage(message.text);

                        (async () => {
                            const portList = await this.getPortList();
                            if (this.panel) {
                                this.panel.webview.postMessage({ command: 'setPortList', data: { 'ports': portList } });
                            }
                        }
                        )();
                        return;
                    }
                    case 'flash': {
                        (async () => {

                            const portId = message.data.portId;

                            if (portId == '') {
                                vscode.window.showErrorMessage('Invalid SerialPort Name');
                                return;
                            }

                            const isResetToDef = message.data.isResetToDef;
                            const isForceErase = message.data.isForceErase;

                            const baudRateId = message.data.baudRateId;
                            const parityId = message.data.parityId;
                            const stopBitsId = message.data.stopBitsId;

                            await this.config.set('eflash.port', portId);
                            await this.config.set('eflash.isSetDefauls', isResetToDef);
                            await this.config.set('eflash.isForceErase', isForceErase);
                            await this.config.set('eflash.baudrate', baudRateId);
                            await this.config.set('eflash.parity', parityId);
                            await this.config.set('eflash.stopbits', stopBitsId);

                            const result = this.executeFlasher(EFlashCmd.FLASH);
                            if (this.panel) {
                                this.panel.dispose();
                            }

                            result.then((val) => {
                                if (!val) {
                                    this.openWebView();
                                }
                            });
                        })();
                        return;
                    }
                }
            },
            undefined,
            this.context.subscriptions
        );


        const portList = await this.getPortList();

        const portId = this.config.get<string>('eflash.port');

        const isResetToDef = this.config.get<boolean>('eflash.isSetDefauls');
        const isForceErase = this.config.get<boolean>('eflash.isForceErase');

        const baudRateId = this.config.get<string>('eflash.baudrate');
        const parityId = this.config.get<string>('eflash.parity');
        const stopBitsId = this.config.get<string>('eflash.stopbits');

        this.panel.webview.postMessage({
            command: 'setPortParams', data: {
                'ports': portList,
                'portId': portId, 'isResetToDef': isResetToDef, 'isForceErase': isForceErase,
                'baudRateId': baudRateId, 'parityId': parityId, 'stopBitsId': stopBitsId
            }
        });

    }


    public async flash(cb: (err: boolean) => any ) {


        const result = await this.executeFlasher(EFlashCmd.FLASH);
        if (result) {
            cb(false);
            return;
        }

        cb(true);
        this.openWebView();

    }


    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        // Local path to script and css for the webview

        const htmlUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'eflasher', 'index.html'));

        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'eflasher', 'eflash.js'));

        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'eflasher', 'eflash.css'));

        // const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(
        // 	this.context.extensionUri, 'media', 'reset.css'));

        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'vscode.css'));

        //let htmlBody: string = "";

        //console.log(htmlUri.path);

        const htmlBody = fs.readFileSync(htmlUri.fsPath).toString();

        // await vscode.workspace.fs.readFile(htmlUri).then(value => {

        //         htmlBody = value.toString();

        //     },  (e) => {
        //         console.log(e);
        //         console.log("Can't load index.html");
        //     });


        // Use a nonce to whitelist which scripts can be run
        const nonce = getNonce();

        console.log(webview.cspSource);

        return /* html */`
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
                
				
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                -->

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleVSCodeUri}" rel="stylesheet" />
				<link href="${styleMainUri}" rel="stylesheet" />

				<title>EFlash config</title>
			</head>
			<body>
                ${htmlBody}
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
    }


}