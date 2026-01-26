
//import { SerialPort } from 'serialport'

import * as toolchain from '../toolchain';
import * as cp from "child_process";
import * as readline from "readline";

import * as vscode from 'vscode';
import { getNonce } from '../util';
import * as fs from 'fs';
import { Config } from '../config';
import internal = require('stream');

import * as nodePath from 'path';

import net = require('net');
import { runDebug } from '../dbg';
import { EFlasherClient } from '../EFlasher/eflasher';



//const posixPath = nodePath.posix || nodePath;


export enum EFlashCmd {
    GET_PORT_LIST = 0,
    ERASE,
    FLASH
}


export class EGDBServer {


    //private portList: string[] = [];

    private egdbServer: cp.ChildProcessByStdio<null, internal.Readable, internal.Readable> | undefined = undefined;

    private isBusy = false;

    public isReady = false;

    private panel: vscode.WebviewPanel | undefined = undefined;

    private eGdbTerminal = new EEmbGdbBridgeTaskTerminal("");

    constructor(
        private readonly config: Config,
        private readonly context: vscode.ExtensionContext,
        private readonly eflasher: EFlasherClient
    ) { }


    private async executeSever(): Promise<boolean> {


        if (this.isBusy) {
            return false;
        }

        await toolchain.resolveTarget(this.config);

        this.isBusy = true;

        if (this.egdbServer && this.egdbServer.exitCode == null) {
            this.egdbServer.kill();
        }

        const path = await toolchain.getPathForExecutable("egdb_server");


        if (!path) {
            vscode.window.showErrorMessage("Can't find path to 'egdb_server'");
            this.isBusy = false;
            return false;
        }


        const portId = this.config.get<string>('eflash.port');

        // const isResetToDef = this.config.get<boolean>('eflash.isSetDefauls');
        // const isForceErase = this.config.get<boolean>('eflash.isForceErase');

        let baudRateId = this.config.get<string>('eflash.baudrate');
        let parityId = this.config.get<string>('eflash.parity');
        let stopBitsId = this.config.get<string>('eflash.stopbits');
        

        const gdbServerPort = this.config.get<number>('gdbserver.port');
        let gdbBaudrate = this.config.get<string>('gdbserver.baudrate');
        let gdbParity = this.config.get<string>('gdbserver.parity');
        let gdbStopbits = this.config.get<string>('gdbserver.stopbits');

        const baudratesMap = new Map<string, string>([
            ["9600",  "0"],
            ["19200", "1"],
            ["38400", "2"],
            ["115200", "3"],
            ["921600", "4"],
        ]);

        const paritiesMap = new Map<string, string>([
            ["no",  "0"],
            ["even", "1"],
            ["odd", "2"]
        ]);

        const stopbitsMap = new Map<string, string>([
            ["1",  "0"],
            ["2", "1"]
        ]);


        baudRateId = baudratesMap.get(baudRateId)!;
        parityId = paritiesMap.get(parityId)!;
        stopBitsId = stopbitsMap.get(gdbStopbits)!;

        gdbBaudrate = baudratesMap.get(gdbBaudrate)!;
        gdbParity = paritiesMap.get(gdbParity)!;
        gdbStopbits = stopbitsMap.get(gdbStopbits)!;


        const client  = new net.Socket();

        client.on('connect', ()=> {
            console.log("EGDB Client: Client is connected");
            client.write(this.playloadToMsg(`u2:${portId};${baudRateId}${parityId}${stopBitsId}${gdbBaudrate}${gdbParity}${gdbStopbits}`));
        });


        let result: boolean | undefined = undefined;

        client.on('close', (hadError) => {
            result = !hadError; 
            console.log("EGDB Client: Client is destroyed");
        });

        client.on('error', (error) => {
            console.log("EGDB Client: error");
            console.log(error);
            vscode.window.showErrorMessage(`EGDB Server: ${error.message}`);
            result = false;
        });

        client.on('timeout', () => {
            console.log("EGDB Client: timeout");
            vscode.window.showErrorMessage(`EGDB Server: Timeout connection`);
            result = false;
        });

        let bufRx = ""
        let rxResult = ""
        client.on('data', (data)=> {

            const msg = data.toString();
            console.log(msg);

            for (const c of data.toString()) {
                // if (!bufRx.length && (c == '+' || c == '-')) {
                //     continue;
                // }
                    
                if (c == '$') {
                    bufRx = "";
                    continue;
                }

                if (c == '#') {

                    rxResult = bufRx;

                    console.log(rxResult);

                    client.write("+");

                    if (rxResult == "OK") {
                        //vscode.window.showInformationMessage(`EGDB Server: Successfully connected to the Device`);
                        this.isReady = true;
                        result = true;
                    } else {
                        vscode.window.showErrorMessage(`EGDB Server: Failed connected to the Device`);
                        result = false;
                    }

                    continue;
                }
                bufRx += c;
            }
            
        });

        // console.log(`Path raw: ${path}`);
        // console.log(`Path norm: ${nodePath.normalize(path)}`);
        // console.log(`Path base: ${nodePath.basename(path)}`);
        // console.log(`Path: ${nodePath.dirname(path)}`);
        // console.log(`Path norm: ${nodePath.dirname(nodePath.normalize(path))}`);

        const promiseExec = new Promise((resolve, reject) => {

            const terminal = vscode.window.createTerminal({ name: 'EEmbGdbBridge', pty: this.eGdbTerminal });
            

            this.egdbServer = cp.spawn(path, ["-p", gdbServerPort.toString(10)], {
                stdio: ["ignore", "pipe", "pipe"], cwd: nodePath.dirname(path)
            }).on("error", (err) => {
                this.isReady = false;
                console.log("Error: ", err);
                terminal.dispose();
                reject(new Error(`could not launch EEmbGdb Server: ${err}`));
                //return false;
            }).on("exit", (exitCode, _) => {
                console.log("eGdbServer is closed");
                terminal.dispose();
                this.isReady = false;
                if (exitCode == 0) {   
                    resolve("Done");
                }
                else {
                    reject(new Error(`exit code: ${exitCode}.`));
                }
            }).on('spawn', ()=>{
                terminal.show();
                this.eGdbTerminal.clear();
            });



            this.egdbServer.stdout.on("data", (chunk) => {
                console.log(chunk.toString());
                this.eGdbTerminal.log(`stdout: ${chunk.toString()}`);
            });

            // this.egdbServer.stdout.on("data", (chunk) => {
            //     console.log(chunk.toString());
            // });

            const rl = readline.createInterface({ input: this.egdbServer.stderr });
            rl.on("line", (line) => {

                console.log(line);
                this.eGdbTerminal.log(line);

                if (line.indexOf("INFO gdb-server.c: Listening at") != -1) {
                    if (result == undefined && !client.connecting) {
                        client.connect({
                            port: gdbServerPort
                        });
                    }
                }

            });

        });

            promiseExec.then(() => {
                //result = true;
            }, () => {
                result = false;
            }).catch(() => {
                result = false;
            });

        

        const prog = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "EGDB Server",
            cancellable: true
        }, async (progress, token) => {

            progress.report({ message: "Connecting to the Device...", increment: -1 });

            token.onCancellationRequested(() => {
                result = false;
            });

            while (result == undefined) {

                if (token.isCancellationRequested) {
                    result = false;                    
                }

                await new Promise(f => setTimeout(f, 500));
            }

            return;

        });

        if (!client.destroyed) {
            client.end();
            //client.destroy();
        }

        if (!result) {
            if (this.egdbServer && this.egdbServer.exitCode == null) {
                this.egdbServer.kill();
            }
        }

        this.isBusy = false;

        return result!;

    }

    private playloadToMsg(payload: string) {

        let result = "$";
        let cksum = 0;

        for (const c of payload) {
            cksum = (c.charCodeAt(0) + cksum) % 256;
            result += c
        }

        result += '#'
        result += cksum.toString(16).toLowerCase();

        return result;
    }


    // private async getPortList(): Promise<string[]> {

    //     this.portList = [];

    //     const result = await this.executeSever();
    //     if (!result) {
    //         return [];
    //     }

    //     return this.portList;
    // }


    private async openWebView() {

        if (this.panel) {
            const columnToShowIn = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
            this.panel.reveal(columnToShowIn);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'egdb_server', // Identifies the type of the webview. Used internally
                'EEmbGDB Server Settings', // Title of the panel displayed to the user
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
                            const portList = await this.eflasher.getPortList();
                            if (this.panel) {
                                this.panel.webview.postMessage({ command: 'setPortList', data: { 'ports': portList } });
                            }
                        }
                        )();
                        return;
                    }
                    case 'attach': {
                        (async () => {

                            const portId = message.data.portId;

                            if (portId == '') {
                                vscode.window.showErrorMessage('Invalid SerialPort Name');
                                return;
                            }

                            const serverPortId = message.data.serverPortId;

                            if (serverPortId == '') {
                                vscode.window.showErrorMessage('Invalid Server Port');
                                return;
                            }

                            const baudRateId = message.data.baudRateId;
                            const parityId = message.data.parityId;
                            const stopBitsId = message.data.stopBitsId;

                            await this.config.set('eflash.port', portId);
                            await this.config.set('eflash.baudrate', baudRateId);
                            await this.config.set('eflash.parity', parityId);
                            await this.config.set('eflash.stopbits', stopBitsId);

                            
                            
                            const baudRateGdbId = message.data.baudRateGdbId;
                            const parityGdbId = message.data.parityGdbId;
                            const stopBitsGdbId = message.data.stopBitsGdbId;

                            await this.config.set('gdbserver.port', Number.parseInt(serverPortId, 10));
                            await this.config.set('gdbserver.baudrate', baudRateGdbId);
                            await this.config.set('gdbserver.parity', parityGdbId);
                            await this.config.set('gdbserver.stopbits', stopBitsGdbId);

                            if (this.panel) {
                                this.panel.dispose();
                            }

                            const result = this.runGdbServer();//this.executeSever();
                            
                            // result.then((val) => {
                            //     if (!val) {
                            //         this.openWebView();
                            //     }
                            // });
                        })();
                        return;
                    }
                }
            },
            undefined,
            this.context.subscriptions
        );


        const portList = await this.eflasher.getPortList();
        if (!portList.length) {
            console.log("wtf");
        }

        const portId = this.config.get<string>('eflash.port');

        const baudRateId = this.config.get<string>('eflash.baudrate');
        const parityId = this.config.get<string>('eflash.parity');
        const stopBitsId = this.config.get<string>('eflash.stopbits');

        const gdbServerPort = this.config.get<number>('gdbserver.port');
        const gdbBaudrate = this.config.get<string>('gdbserver.baudrate');
        const gdbParity = this.config.get<string>('gdbserver.parity');
        const gdbStopbits = this.config.get<string>('gdbserver.stopbits');

        this.panel.webview.postMessage({
            command: 'setPortParams', data: {
                'ports': portList,
                'portId': portId,
                'baudRateId': baudRateId, 'parityId': parityId, 'stopBitsId': stopBitsId,
                'serverPortId':gdbServerPort, 
                'baudRateGdbId': gdbBaudrate, 'parityGdbId': gdbParity, 'stopBitsGdbId': gdbStopbits
            }
        });

    }


    public async runGdbServer() {


        const result = await this.executeSever();
        if (result) {
            runDebug(this.config, false);
            return;
        }

        this.openWebView();

    }

    public dropGdbServer() {
        if (this.egdbServer && this.egdbServer.exitCode == null) {
            this.egdbServer.kill();
        }
    }


    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {

        const htmlUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'EGDB_Server', 'index.html'));

        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'EGDB_Server', 'gdbServer.js'));

        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'EGDB_Server', 'gdbServer.css'));

        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'vscode.css'));


        const htmlBody = fs.readFileSync(htmlUri.fsPath).toString();

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

				<title>EEmbGDB Server Settings</title>
			</head>
			<body>
                ${htmlBody}
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
    }


}


class EEmbGdbBridgeTaskTerminal implements vscode.Pseudoterminal {

    private defaultLine = "→ ";
    private keys = {
        enter: "\r",
        backspace: "\x7f",
    };

    private actions = {
        cursorBack: "\x1b[D",
        deleteChar: "\x1b[P",
        clear: "\x1b[2J\x1b[3J\x1b[;H",
    };

	private writeEmitter = new vscode.EventEmitter<string>();
	onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	private closeEmitter = new vscode.EventEmitter<number>();
	onDidClose?: vscode.Event<number> = this.closeEmitter.event;

	//private fileWatcher: vscode.FileSystemWatcher | undefined;

	// constructor(private workspaceRoot: string, private flavor: string, private flags: string[], private getSharedState: () => string | undefined, private setSharedState: (state: string) => void) {
	// }

	// open(initialDimensions: vscode.TerminalDimensions | undefined): void {
	// 	// At this point we can start using the terminal.
	// 	if (this.flags.indexOf('watch') > -1) {
	// 		const pattern = nodePath.join(this.workspaceRoot, 'customBuildFile');
	// 		this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
	// 		this.fileWatcher.onDidChange(() => this.doBuild());
	// 		this.fileWatcher.onDidCreate(() => this.doBuild());
	// 		this.fileWatcher.onDidDelete(() => this.doBuild());
	// 	}
	// 	//this.doBuild();
	// }

    constructor(private workspaceRoot: string) {
    }

    onDidOverrideDimensions?: vscode.Event<vscode.TerminalDimensions | undefined> | undefined;
    onDidChangeName?: vscode.Event<string> | undefined;

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        throw new Error('Method not implemented.');
    }
    handleInput?(data: string): void {
        console.log(data);
        //throw new Error('Method not implemented.');
    }
    setDimensions?(dimensions: vscode.TerminalDimensions): void {
        //throw new Error('Method not implemented.');
    }

	close(): void {
		// The terminal has been closed. Shutdown the build.
		// if (this.fileWatcher) {
		// 	this.fileWatcher.dispose();
		// }
	}

    log(data: string): void {
        this.writeEmitter.fire(`${data}\r\n`);
    }

    clear(): void {
		this.writeEmitter.fire(this.actions.clear);
	}

}