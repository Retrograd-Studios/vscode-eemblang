import * as vscode from 'vscode';

import {
    Executable,
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
    State,
    StreamInfo,
    TransportKind
} from 'vscode-languageclient/node';

import * as cp from "child_process";
import * as readline from "readline";
import * as net from 'net';

import * as toolchain from './../toolchain';


class EEmbGdbBridgeTaskTerminal2 implements vscode.Pseudoterminal {

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

let client: LanguageClient;
const outputChannel = vscode.window.createOutputChannel("EEPL LSP");
const traceOutputChannel = vscode.window.createOutputChannel("EEPL LSP Trace");

import internal = require('stream');
import { stdin, stdout } from 'process';
import { resolve } from 'path';
import { rejects } from 'assert';
import { Config } from '../config';

async function executeLsp(): Promise<boolean> {


    const path = await toolchain.getPathForExecutable("eec");


    if (!path) {
        vscode.window.showErrorMessage("Can't find path to 'eec'");
        return false;
    }


    let eGdbTerminal = new EEmbGdbBridgeTaskTerminal2("");

    let eflash: cp.ChildProcessByStdio<internal.Writable, internal.Readable, internal.Readable> | undefined = undefined;

    const promiseExec = new Promise((resolve, reject) => {

        const terminal = vscode.window.createTerminal({ name: 'EEPL TERM', pty: eGdbTerminal });

        eflash = cp.spawn(path, ["./", "-lsp", "-o", "./"], {
            stdio: ["pipe", "pipe", "pipe"]
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
            eGdbTerminal.log(`stderr: ${chunk.toString()}`);
        });

        eflash.stdout.on("data", (chunk) => {
            console.log(chunk.toString());
            eGdbTerminal.log(`stdout: ${chunk.toString()}`);
        });

        const rl = readline.createInterface({ input: eflash.stdout });
        rl.on("line", (line) => {

            console.log(line);
            eGdbTerminal.log(`line stdout: ${line}`);

        });


        const serverOptions = () => {
            const result: StreamInfo = {
                writer: eflash!.stdin,
                reader: eflash!.stdout
            };
            return Promise.resolve(result);
        };

        let clientOptions: LanguageClientOptions = {
            // Register the server for plain text documents
            documentSelector: [{ scheme: 'file', language: 'eepl' }],
            synchronize: {
                fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
            },
            outputChannel: outputChannel,
            // revealOutputChannelOn: RevealOutputChannelOn.Never,
            traceOutputChannel: traceOutputChannel
            // synchronize: {
            //   // Notify the server about file changes to '.clientrc files contained in the workspace
            //   fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
            // }
        };

        // Create the language client and start the client.
        client = new LanguageClient(
            'eepl-vscode-lsclient',
            'EEPL LS Client',
            serverOptions,
            clientOptions
        );

        client.start();

    });


    eGdbTerminal.log(`Test`);

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
        title: "waiting",
        cancellable: true
    }, async (progress, token) => {

        progress.report({ message: "Waiting...", increment: -1 });

        token.onCancellationRequested(() => {
            result = false;
            if (eflash && eflash.exitCode == null) {
                eflash.kill();
            }
        });

        while (result == undefined) {

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

    return result!;
}


function StartLsp(config: Config) {
    
      // let serverModule = context.asAbsolutePath(vscode.Uri.joinPath(vscode.Uri.file('server'), 'server', 'out', 'server.js').fsPath);
      // The debug options for the server
      // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
      // let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    
      const serverPort: string = config.get("lsp.port"); // Получаем порт из настроек окружения vscode
      // vscode.window.showInformationMessage(`Starting LSP client on port: ` + serverPort);  // Отправим пользователю информацию о запуске расширения
      
      // executeLsp();
    
      const connectionInfo = {
        port: Number(serverPort),
        host: "localhost"
      };
      const serverOptions = () => {
        // Подключение по сокету
        const socket = net.connect(connectionInfo);
        socket.addListener("error", (err) => {
          console.log(err.message);
        })
        socket.addListener("timeout", () => {
          console.log("timout");
        })
        socket.addListener("connect", () => {
          console.log("conecteed");
        })
        const result: StreamInfo = {
          writer: socket,
          reader: socket
        };
        return Promise.resolve(result);
      };
    
      // outputChannel.show(true);
      // traceOutputChannel.show(true);
    
    
    
    
      // const run: Executable = {
      //   command: serverPath,
      //   transport: TransportKind.stdio,
      //   args: [ "-lsp" ],
      //   options: {
      //     env: {
      //       ...process.env,
      //     },
      //   },
      // };
    
      // // // If the extension is launched in debug mode then the debug server options are used
      // // // Otherwise the run options are used
      // let serverOptions: ServerOptions = {
      //   // run: { command: serverModule, transport: TransportKind.stdio  },
      //   // // debug: run
      //   // debug: {
      //   //   module: serverModule,
      //   //   transport: TransportKind.stdio,
      //   //   // options: debugOptions
      //   // }
      //   run,
      //   debug: run
      // };
    
      // // Options to control the language client
      let clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: [{ scheme: 'file', language: 'eepl' }],
        synchronize: {
          fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        },
        outputChannel: outputChannel,
        // revealOutputChannelOn: RevealOutputChannelOn.Never,
        traceOutputChannel: traceOutputChannel
        // synchronize: {
        //   // Notify the server about file changes to '.clientrc files contained in the workspace
        //   fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        // }
      };
    
      // // Create the language client and start the client.
      client = new LanguageClient(
        'eepl-vscode-lsclient',
        'EEPL LS Client',
        serverOptions,
        clientOptions
      );
    
      // // const disposeDidChange = client.onDidChangeState(
      // //   (stateChangeEvent) => {
      // //     if (stateChangeEvent.newState === State.Stopped) {
      // //       vscode.window.showErrorMessage(
      // //         "Failed to initialize the extension"
      // //       );
      // //     } else if (stateChangeEvent.newState === State.Running) {
      // //       vscode.window.showInformationMessage(
      // //         "Extension initialized successfully!"
      // //       );
      // //     }
      // //   }
      // // );
    
      // let disposable = client.start();
      // context.subscriptions.push(disposable);
    
      //   this.languageClient.onReady().then(() => {
      //     disposeDidChange.dispose();
      //     this.context!.subscriptions.push(disposable);
      //   });
      // } catch (exception) {
      //   return Promise.reject("Extension error!");
      // }
}
