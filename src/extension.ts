import * as vscode from 'vscode';


import * as fs from 'fs';
import * as https from 'https';
import * as tasks from './tasks';
import * as toolchain from './toolchain';

import * as cp from "child_process";

import { Config } from "./config";
import { activateTaskProvider, createTask } from "./tasks";
import { isEasyDocument } from "./util";

import * as readline from "readline";

import { EasyConfigurationProvider, runDebug } from "./dbg";

import * as os from "os";



import { checkPackages } from './packages';
import { createNewProject, selectExamples } from './examples';
import { EFlasherClient } from './EFlasher/eflasher';
import { EGDBServer } from './EGDB_Server/egdbServer';


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

import * as net from 'net';
import { log } from 'console';








export type Workspace =
  | { kind: "Empty" }
  | {
    kind: "Workspace Folder";
  }
  | {
    kind: "Detached Files";
    files: vscode.TextDocument[];
  };


export function fetchWorkspace(): Workspace {
  const folders = (vscode.workspace.workspaceFolders || []).filter(
    (folder) => folder.uri.scheme === "file"
  );
  const rustDocuments = vscode.workspace.textDocuments.filter((document) =>
    isEasyDocument(document)
  );

  return folders.length === 0
    ? rustDocuments.length === 0
      ? { kind: "Empty" }
      : {
        kind: "Detached Files",
        files: rustDocuments,
      }
    : { kind: "Workspace Folder" };
}


async function checkDepencies() {


  let extName = "marus25.cortex-debug";
  //let extName = "vadimcn.vscode-lldb";

  let debugEngine = vscode.extensions.getExtension(extName);

  if (!debugEngine) {
    let buttons = ['Install', 'Not now'];
    let choice = await vscode.window.showWarningMessage(`Extension '${extName}' is not installed! It is required for debugging.\n Install now?`, ...buttons);
    if (choice === buttons[0]) {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', extName).then(() => {
        vscode.window.showInformationMessage(`Extension '${extName}' has been successfully installed`);
      }, () => {
        vscode.window.showErrorMessage(`Extension '${extName}' has not been installed :(`);
        return;
      });
    } else if (choice == buttons[1]) {
      vscode.window.showErrorMessage(`Extension '${extName}' has not been installed.\n Debugging is unreached :(`);
      return;
    }
  }




  //    const definition: tasks.EasyTaskDefinition = {
  //     type: tasks.TASK_TYPE,
  //     command: "", // run, test, etc...
  //     args: [],
  //     cwd: vscode.workspace.getWorkspaceFolder ,
  //     env: prepareEnv(runnable, config.runnableEnv),
  //     overrideCargo: runnable.args.overrideCargo,
  // };

  //    const target = vscode.workspace.workspaceFolders![0]; // safe, see main activate()
  //     const cargoTask = await tasks.buildCargoTask(
  //         target,
  //         definition,
  //         runnable.label,
  //         args,
  //         config.cargoRunner,
  //         true
  //     );

  //     cargoTask.presentationOptions.clear = true;
  //     // Sadly, this doesn't prevent focus stealing if the terminal is currently
  //     // hidden, and will become revealed due to task exucution.
  //     cargoTask.presentationOptions.focus = false;


  const path = await toolchain.getPathForExecutable("st-util");

  if (!path) {
    vscode.window.showErrorMessage("Can't find path to 'st-util'");
    return;
  }

  let workspace = vscode.workspace.workspaceFolders![0];

  //const exec = cp.spawn(path, [], {});

  const exec = new Promise((resolve, reject) => {
    const cargo = cp.spawn(path, [], {
      stdio: ["ignore", "pipe", "pipe"],
      //       cwd: workspace.name
    });

    cargo.on("error", (err) => {
      reject(new Error(`could not launch cargo: ${err}`))
    });

    cargo.stderr.on("data", (chunk) => {
      console.log(chunk.toString());
    });

    const rl = readline.createInterface({ input: cargo.stdout });
    rl.on("line", (line) => {
      console.log(line);
      //const message = JSON.parse(line);
      //onStdoutJson(message);
    });

    cargo.on("exit", (exitCode, _) => {
      if (exitCode === 0) {
        resolve(exitCode);
      }
      else {
        reject(new Error(`exit code: ${exitCode}.`));
      }
    });
  });

  await new Promise(f => setTimeout(f, 1000));


  // const exec =  execute(path, {}).then(() => {
  //   vscode.window.showInformationMessage("Success");
  // }, () => {
  //   vscode.window.showErrorMessage("Error");
  // }); //cp.exec(path);


  debugEngine = vscode.extensions.getExtension(extName);

  let debugConfig: vscode.DebugConfiguration = {
    type: "cortex-debug",
    request: "attach",
    name: "Debug on PLC",
    cwd: "${workspaceFolder}",
    svdFile: "./bin/target.svd",
    executable: "./bin/target.o",
    runToEntryPoint: "__entryPoint__",
    servertype: "external",
    armToolchainPath: "C:\\Program Files (x86)\\GNU Arm Embedded Toolchain\\10 2020-q4-major\\bin",
    gdbPath: "C:/Users/YouTooLife_PC/.eec/out/build/bin/arm-none-eabi-gdb.exe",
    gdbTarget: "localhost:4242",
    showDevDebugOutput: "raw"
    //preLaunchTask: "st-util"
  };


  vscode.debug.startDebugging(undefined, debugConfig);

}


let EEPL_stackOfCommands: string[] = []



let EEPL_isFlashFailed = true;
let EEPL_isBuildFailed = true;
let EEPL_isReqRebuild = true;




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

async function executeLsp(): Promise<boolean> {


  const path = await toolchain.getPathForExecutable("eec");


  if (!path) {
    vscode.window.showErrorMessage("Can't find path to 'eec'");
    return false;
  }


  // const portId = this.config.get<string>('eflash.port');

  // let eflashArgs: string[] = [ "-lsp" ]
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


class EEPLColorProvider implements vscode.DocumentColorProvider {
  provideColorPresentations(color: vscode.Color,
    context: { readonly document: vscode.TextDocument; readonly range: vscode.Range; },
    token: vscode.CancellationToken): vscode.ProviderResult<vscode.ColorPresentation[]> {

    const clR = 255 * color.red;
    const clG = 255 * color.green;
    const clB = 255 * color.blue;

    const result: vscode.ColorPresentation[] = [

      {
        label: `GET_COLOR(${clR}, ${clG}, ${clB})`
      }

    ];



    return result;
  }


  public provideDocumentColors(
    document: vscode.TextDocument, token: vscode.CancellationToken):
    Thenable<vscode.ColorInformation[]> {


    return new Promise<vscode.ColorInformation[]>((resolve, reject) => {

      let result: vscode.ColorInformation[] = [];

      for (let i = 0; i < document.lineCount; ++i) {

        const line = document.lineAt(i);
        let range = line.range;
        let text = line.text;

        let isMatching = true;
        while (isMatching) {

          const regex: RegExp = /(GET_COLOR)\s*\(\s*((?:0x)?[0-9,a-f,A-F]+)\s*,\s*((?:0x)?[0-9,a-f,A-F]+)\s*,\s*((?:0x)?[0-9,a-f,A-F]+)\s*\)/;
          // const word = document.getWordRangeAtPosition(line.range.start, regex);
          const words = regex.exec(text);
          if (words === null) {
            isMatching = false;
            continue;
          }

          const clR = 1.0 / 255 * Number.parseInt(words[2]);
          const clG = 1.0 / 255 * Number.parseInt(words[3]);
          const clB = 1.0 / 255 * Number.parseInt(words[4]);

          const endIndex = text.indexOf(")", words.index) + 1;

          range = range.with(
            range.start.translate(0, words.index),
            range.end.with(undefined, range.start.character + endIndex)
          );

          result.push({ range: range, color: { red: clR, green: clG, blue: clB, alpha: 1.0 } });

          range = range.with(
            range.end,
            range.end
          );

          text = text.substring(endIndex);

        }


      }

      return resolve(result);
    });
  }

}


export function activate(context: vscode.ExtensionContext) {

  let extation = vscode.extensions.getExtension("Retrograd-Studios.moderon-logic");

  console.log(extation);

  let config = new Config(context);
  if (os.platform().toString() === "win32") {
    config.hostTriplet = `${os.arch()}-windows`;
  } else {
    config.hostTriplet = `${os.arch()}-${os.platform()}`;
  }

  console.log(`os.platform: ${os.platform().toString()}`);
  console.log(`os.arch: ${os.arch()}`);
  console.log(`triplet: ${config.hostTriplet}`);

  const supportedTriplet = ['x64-windows', 'x64-linux'];

  let isSupportedHost = false;
  for (const tripletName of supportedTriplet) {
    if (tripletName === config.hostTriplet) {
      isSupportedHost = true;
      break;
    }
  }

  if (!isSupportedHost) {
    vscode.window.showErrorMessage(`This extension not support current host machine (${config.hostTriplet})!`, ...['OK']);
    return;
  }

  let eflashClient = new EFlasherClient(config, context);
  let eGdbServer = new EGDBServer(config, context, eflashClient);


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


  let sbSelectTargetDev: vscode.StatusBarItem;
  sbSelectTargetDev = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
  sbSelectTargetDev.command = 'eepl.command.setTargetDevice';
  context.subscriptions.push(sbSelectTargetDev);
  sbSelectTargetDev.text = "$(chip) Select Target";
  sbSelectTargetDev.tooltip = "Select target Device/Platform";
  sbSelectTargetDev.show();
  toolchain.checkAndSetCurrentTarget(config, sbSelectTargetDev);

  //const currentToolchain = await toolchain.getCurrentToolchain(); //config.get<string>('toolchain.version');
  let sbSelectToolchain: vscode.StatusBarItem;
  sbSelectToolchain = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
  sbSelectToolchain.command = 'eepl.command.setToolchain';
  context.subscriptions.push(sbSelectToolchain);
  sbSelectToolchain.text = `$(extensions)`;
  sbSelectToolchain.tooltip = "Select toolchain";
  sbSelectToolchain.show();

  let sbSelectBuildPreset: vscode.StatusBarItem;
  sbSelectBuildPreset = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  sbSelectBuildPreset.command = 'eepl.command.setBuildPreset';
  context.subscriptions.push(sbSelectBuildPreset);
  sbSelectBuildPreset.text = config.get<string>('build.presets');
  sbSelectBuildPreset.tooltip = "Select build preset";
  sbSelectBuildPreset.show();

  let sbOpenSettings: vscode.StatusBarItem;
  sbOpenSettings = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
  sbOpenSettings.command = 'eepl.command.settings';
  context.subscriptions.push(sbOpenSettings);
  sbOpenSettings.text = '$(settings-gear)'
  sbOpenSettings.tooltip = "Open extension settings";
  sbOpenSettings.show();


  // let sbClearCache: vscode.StatusBarItem;
  // sbClearCache = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  // sbClearCache.command = 'eepl.command.clearCache';
  // context.subscriptions.push(sbSelectToolchain);
  // sbClearCache.text = "$(terminal-kill)";
  // sbClearCache.tooltip = "Clear cache";
  // sbClearCache.show();

  let sbDropDebugger: vscode.StatusBarItem;
  sbDropDebugger = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  sbDropDebugger.command = 'eepl.command.dropDebugger';
  context.subscriptions.push(sbDropDebugger);
  sbDropDebugger.text = "[$(debug)$(close-all)]";
  sbDropDebugger.tooltip = "Drop Debugger and GDB Server";
  sbDropDebugger.hide();


  (async () => {
    toolchain.checkAndSetCurrentToolchain(config, sbSelectToolchain);
  })();

  (async () => {
    checkPackages(config);
  })();


  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.progress', async config => {

    const ws = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;

    // const debugConfig: vscode.DebugConfiguration = {
    //   "name": "SimulatorWin64",
    // 	"type": "cppvsdbg",
    // 	"request": "launch",
    // 	"program": "c:/Users/Cpt. Eg1r/.eec/bin/eec.exe",
    // 	"args": [`${ws?.uri.fsPath}/PackageInfo.es`, "-target", "c:/Users/Cpt. Eg1r/.eec/targets/M72OD20R/targetInfo.json", "-jit", "-emit-llvm", "-g", "-O0", "-o", "./output"],
    // 	"stopAtEntry": false,
    // 	"cwd": "${fileDirname}",
    // 	"environment": []
    //  };

    const debugConfig: vscode.DebugConfiguration = {
      // "type": "lldb-dap",
      // "request": "launch",
      // "name": "LLDSimulatorWin64",
      // "program": "c:/Users/Cpt. Eg1r/.eec/bin/eec.exe",
      // "args": ["${workspaceFolder}/PackageInfo.es", "-target", "c:/Users/Cpt. Eg1r/.eec/targets/M72OD20R/targetInfo.json", "-jit", "-emit-llvm", "-g", "-O0", "-o", "./out/M72OD20R/output"],
      // "cwd": "${fileDirname}"
      "name": "SimulatorWin64",
      "type": "lldb",
      "request": "launch",
      "program": "c:/Users/Cpt. Eg1r/.eec/bin/eec.exe",
      "args": [`${ws?.uri.fsPath}/PackageInfo.es`, "-target", "c:/Users/Cpt. Eg1r/.eec/targets/M72OD20R/targetInfo.json", "-jit", "-emit-llvm", "-g", "-O0", "-o", "./out/M72OD20R/output"],
      "stopAtEntry": true,
      "cwd": `${ws?.uri.fsPath}`,
      "sourceLanguages": ["eepl", "es"]
      // "environment": []
    };

    vscode.debug.startDebugging(ws, debugConfig);

    // vscode.window.withProgress({
    //   location: vscode.ProgressLocation.Notification,
    //   title: "Downloading...",
    //   cancellable: true
    // }, async (progress, token) => {
    //   token.onCancellationRequested(() => {
    //     console.log("User canceled the long running operation");
    //   });
    //   progress.report({ message: "Download...", increment: 0 });

    //   for (var _i = 0; _i < 100; _i++) {
    //     await new Promise(f => setTimeout(f, 100));
    //     progress.report({ message: "Download...", increment: 1 });
    //   }

    // });
  })

  );


  vscode.debug.onDidStartDebugSession((e) => {
    console.log(e);
    //checkDepencies();
  });


  vscode.tasks.onDidEndTaskProcess(async (e) => {

    console.log(e.execution.task.name);
    const tsk: tasks.EasyTaskDefinition = (e.execution.task.definition as tasks.EasyTaskDefinition);

    if (!(tsk as tasks.EasyTaskDefinition)) {
      return;
    }

    if (e.exitCode != 0) {
      EEPL_stackOfCommands = [];
      return;
    }

    if (tsk.command == "build") {

      if (config.isInternalLinker) {

        EEPL_isBuildFailed = false;
        const cmd = EEPL_stackOfCommands.pop();
        if (cmd) {
          vscode.commands.executeCommand(cmd);
          return;
        }

        if (config.targetDevice.periphInfo.isDesktop) {
          vscode.window.showInformationMessage(`The App '${config.exePath}' has been successfully compiled`);
        }

        return;
      }

      const task = await createTask(tasks.EasyTaskId.Link, config);
      if (task !== undefined) {
        const exec = await vscode.tasks.executeTask(task);
      }

    } else if (tsk.command == "link") {

      if (!config.targetDevice.periphInfo.isDesktop) {
        const task = await createTask(tasks.EasyTaskId.EBuild, config);
        if (task !== undefined) {
          const exec = await vscode.tasks.executeTask(task);
        }
      } else {
        EEPL_isBuildFailed = false;
        const cmd = EEPL_stackOfCommands.pop();
        if (cmd) {
          vscode.commands.executeCommand(cmd);
        } else {
          vscode.window.showInformationMessage(`The App '${config.exePath}' has been successfully compiled`);
        }
      }

    } else if (tsk.command == "ebuild") {
      EEPL_isBuildFailed = false;
      const cmd = EEPL_stackOfCommands.pop();
      if (cmd) {
        vscode.commands.executeCommand(cmd);
      }
    }

  });

  vscode.workspace.onDidSaveTextDocument((e) => {
    if (e.fileName.indexOf("settings.json") == -1) {
      EEPL_isReqRebuild = true;
    }

  });

  vscode.workspace.onDidSaveNotebookDocument((e) => {
    EEPL_isReqRebuild = true;
  });

  vscode.workspace.onDidCreateFiles((e) => {
    EEPL_isReqRebuild = true;
  });

  vscode.workspace.onDidDeleteFiles((e) => {
    EEPL_isReqRebuild = true;
  });

  vscode.workspace.onDidRenameFiles((e) => {
    EEPL_isReqRebuild = true;
  });


  // vscode.workspace.onDidOpenTextDocument((e) => {
  //   if (e.languageId != 'EEPL') {
  //     console.log('Deavivate');
  //   } else {
  //     console.log('Activate');
  //   }
  // });

  context.subscriptions.push(activateTaskProvider(config));


  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.compileProject', async () => {


    EEPL_isBuildFailed = true;

    for (const file of vscode.workspace.textDocuments) {
      if (file.isDirty) {
        console.log("changes: ", file.fileName, file.version);
        await file.save();
      } else {
        console.log("no changes: ", file.fileName, file.version);
      }
    }

    EEPL_isReqRebuild = false;

    const task = await createTask(tasks.EasyTaskId.Build, config).catch(() => { });
    if (!task) {
      return;
    }
    const exec = await vscode.tasks.executeTask(task);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.runSimulator', async () => {

    for (const file of vscode.workspace.textDocuments) {
      if (file.isDirty) {
        console.log("changes: ", file.fileName, file.version);
        await file.save();
      } else {
        console.log("no changes: ", file.fileName, file.version);
      }
    }

    const cPreset = config.get<string>('build.presets');
    const isGenDbgInfo = config.get<string>('build.generateDbgInfo');

    //EEPL_isReqRebuild = true;

    if (cPreset == 'Debug' || cPreset == 'OpDebug'
      || (cPreset == 'Custom' && isGenDbgInfo)) {
      runDebug(config, true);
      return;
    }

    const task = await createTask(tasks.EasyTaskId.Simulate, config).catch(() => { });
    if (!task) {
      return;
    }
    const exec = await vscode.tasks.executeTask(task);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.buildAndDebug', async () => {

    const cPreset = config.get<string>('build.presets');
    const isGenDbgInfo = config.get<string>('build.generateDbgInfo');

    if (cPreset == 'Custom') {
      if (!isGenDbgInfo) {
        const buttons = ['Open settings'];
        const choice = await vscode.window.showWarningMessage(`Start Debug session is aborted.\nThe App has't debug information.\nEnable 'eepl.build.generateDbgInfo' in extension settings`, { modal: true }, ...buttons);
        if (choice == buttons[0]) {
          vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', `@ext:${extation?.id} eepl.build.generateDbgInfo`);
        }
        return;
      }
    } else if (cPreset.indexOf('Debug') == -1) {
      const buttons = ['Select preset', 'Open settings'];
      const choice = await vscode.window.showWarningMessage(`Start Debug session is aborted.\nThe App has't debug information.\nChange build preset to 'Debug' or Enable 'eepl.build.generateDbgInfo' in extension settings`, { modal: true }, ...buttons);
      if (choice == buttons[0]) {
        vscode.commands.executeCommand('eepl.command.setBuildPreset');
      } else if (choice == buttons[1]) {
        vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', `@ext:${extation?.id} eepl.build.generateDbgInfo`);
      }
      return;
    }


    //cPreset.indexOf('Debug') != -1) {}


    let runRebuild = false;
    for (const file of vscode.workspace.textDocuments) {
      if (file.isDirty) {
        runRebuild = true;
        break;
      }
    }

    if (EEPL_isReqRebuild || EEPL_isBuildFailed || runRebuild) {
      EEPL_stackOfCommands.push('eepl.command.buildAndDebug');
      EEPL_stackOfCommands.push('eepl.command.buildAndFlash');
      vscode.commands.executeCommand('eepl.command.compileProject');
      return;
    }

    if (config.targetDevice.periphInfo.isDesktop) {
      runDebug(config, false);
      return;
    }

    if (EEPL_isFlashFailed) {
      EEPL_stackOfCommands.push('eepl.command.buildAndDebug');
      vscode.commands.executeCommand('eepl.command.buildAndFlash');
      return;
    }

    eGdbServer.runGdbServer();

  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.openFlasher', async () => {
    const task = await createTask(tasks.EasyTaskId.Flush, config).catch(() => { });
    if (!task) {
      return;
    }
    const exec = await vscode.tasks.executeTask(task);
    //return vscode.window.showInformationMessage("Flush", "Ok");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.attach', () => {

    if (config.targetDevice.periphInfo.isDesktop) {
      runDebug(config, false);
      return;
    }

    eGdbServer.runGdbServer();

  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.buildAndFlash', () => {

    let runRebuild = false;
    for (const file of vscode.workspace.textDocuments) {
      if (file.isDirty) {
        runRebuild = true;
        break;
      }
    }



    if (EEPL_isReqRebuild || EEPL_isBuildFailed || runRebuild) {
      EEPL_stackOfCommands.push('eepl.command.buildAndFlash');
      vscode.commands.executeCommand('eepl.command.compileProject');
      return;
    }


    if (config.targetDevice.periphInfo.isDesktop) {

      const cmd = EEPL_stackOfCommands.pop();

      if (cmd === 'eepl.command.buildAndDebug') {
        vscode.commands.executeCommand(cmd);
        return;
      } else if (cmd) {
        EEPL_stackOfCommands.push(cmd);
      }

      const task = new vscode.Task(
        { type: 'eec', command: 'run' },
        vscode.TaskScope.Workspace,
        'run',
        'eepl',
        new vscode.ProcessExecution(config.exePath, [])
      );

      vscode.tasks.executeTask(task);

      return;

    }

    EEPL_isFlashFailed = true;

    eflashClient.flash((err) => {
      if (!err) {
        const cmd = EEPL_stackOfCommands.pop();
        if (cmd) {
          EEPL_isFlashFailed = false;
          vscode.commands.executeCommand(cmd);
        }
      } else {
        if (EEPL_stackOfCommands.length) {
          EEPL_isFlashFailed = true;
          EEPL_stackOfCommands = [];
        }
      }

    });

  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.dropDebugger', async config => {

    eGdbServer.dropGdbServer();
    vscode.debug.stopDebugging();

  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.settings', () => {
    vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', `@ext:${extation?.id}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.setBuildPreset', async () => {
    const pickTargets: any[] = [
      { label: "Debug", detail: "Generate debug information. Disable all optimizations. Enable Runtime checks.", picked: false, description: " $(debug-alt)" },
      { label: "OpDebug", detail: "Generate debug information. Enable -O3 level optimizations. Enable Runtime checks.", picked: false, description: " $(debug-alt) $(symbol-event)" },
      { label: "Release", detail: "Discard debug information. Enable -O3 level optimizations. Disable Runtime checks.", picked: false, description: " $(check-all)" },
      { label: "Safe Release", detail: "Discard debug information. Enable -O3 level optimizations. Enable Runtime checks.", picked: false, description: " $(workspace-trusted)" },
      { label: "Custom", detail: "User defined optimization level, on/off generate debug information, on/off Runtime checks. ", picked: false, description: " $(edit)" },
      { label: "Settings", detail: "Open build settings", picked: false, description: " $(settings)" }
    ];




    const curentPreset = config.get<string>('build.presets');

    for (const variant of pickTargets) {

      const isPicked = (curentPreset == variant.label);
      const pickItem = isPicked ? '$(pass-filled)' : (variant.label != 'Settings' ? '$(circle-large-outline)' : "\t");
      const detail = ` ${pickItem} ${variant.detail}`;
      variant.detail = detail;
      variant.picked = isPicked;
    }

    const target = await vscode.window.showQuickPick(
      pickTargets,
      { placeHolder: 'Select build preset', title: "Build preset" }
    );

    if (target) {
      if (target.label != 'Settings') {
        config.set('build.presets', target.label);
      } else {
        vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', `@ext:${extation?.id} eepl.build`);
      }
    }


  }));

  context.subscriptions.push(vscode.commands.registerCommand('eepl.command.installToolchain', async () => {
    toolchain.checkAndSetCurrentToolchain(config, sbSelectToolchain);
  }));


  vscode.debug.onDidStartDebugSession((e) => {
    sbDropDebugger.show();
  });

  vscode.debug.onDidTerminateDebugSession((e) => {
    sbDropDebugger.hide();
    eGdbServer.dropGdbServer();
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {

    if (e.affectsConfiguration('eepl.target.device')) {
      EEPL_isReqRebuild = true;
      if (config.targetDevice != config.get<toolchain.TargetInfo>("target.device")) {
        toolchain.checkAndSetCurrentTarget(config, sbSelectTargetDev);
      }
    }


    if (e.affectsConfiguration('eepl.toolchain.version')) {
      EEPL_isReqRebuild = true;
      if (config.currentToolchain != config.get<toolchain.ToolchainInfo>("target.version")) {
        toolchain.checkAndSetCurrentToolchain(config, sbSelectToolchain);
      }
    }

    if (e.affectsConfiguration('eepl.build')) {
      EEPL_isReqRebuild = true;
      if (e.affectsConfiguration('eepl.build.presets')) {
        sbSelectBuildPreset.text = config.get<string>('build.presets');
      } else {
        config.set('build.presets', 'Custom');
      }
    }
  }));

  vscode.commands.registerCommand('eepl.command.clearCache', async () => {

    const devName = config.targetDevice.devName;

    const cwd = vscode.workspace.workspaceFolders![0].uri.path;
    const cachePath = `${cwd}/out/${devName}/.eec_cache`;
    const cacheSimPath = `${cwd}/out/Simulator/.eec_cache`;

    fs.rm(vscode.Uri.file(cachePath).fsPath, { recursive: true, force: true }, () => {
    });
    fs.rm(vscode.Uri.file(cacheSimPath).fsPath, { recursive: true, force: true }, () => {
    });

  });

  vscode.commands.registerCommand('eepl.command.setTargetDevice', async () => {


    let pickTargets: any[] = [];

    const prevDev = config.targetDevice; //.get<string>('target.device');

    const targets = await toolchain.getTargets(config);

    targets.forEach(element => {
      const isPicked = (prevDev.description == element.description);
      const pickItem = isPicked ? '$(pass-filled)' : '$(circle-large-outline)';

      let deviceIcon = '$(device-mobile)';

      if (element.periphInfo.isDesktop) {
        if (element.devName.indexOf('windows') != -1) {
          deviceIcon = '$(vm)'
        } else if (element.devName.indexOf('linux') != -1) {
          deviceIcon = '$(vm)'
        }
      }

      let platformIcon = '$(device-mobile)';

      if (element.periphInfo.isDesktop) {
        if (element.devName.indexOf('windows') != -1) {
          platformIcon = '$(terminal-powershell)'
        } else if (element.devName.indexOf('linux') != -1) {
          platformIcon = '$(terminal-linux)'
        }
      }

      const periphInfo = element.periphInfo.isDesktop ? '' : `[${element.periphInfo.uiCount} UIs, ${element.periphInfo.relayCount} Relays, ${element.periphInfo.aoCount} AOs, ${element.periphInfo.uartCount} COMs]`;
      const detail = ` ${pickItem}   ${deviceIcon} ${periphInfo}   $(extensions) framework v${element.frameWorkVerA}.${element.frameWorkVerB}`;
      pickTargets.push({ label: element.devName, detail: detail, devName: element.devName, picked: isPicked, description: `${element.description} ${platformIcon}`, _target: element });
    });

    const target = await vscode.window.showQuickPick(
      pickTargets,
      // [
      //   { label: 'M72001', description: 'M72001 basic', devName: 'M72IS20C01D', target: vscode.ConfigurationTarget.Workspace },
      //   { label: 'M72002', description: 'M72002 medium', devName: 'M72IS20C02D', target: vscode.ConfigurationTarget.Workspace },
      //   { label: 'M72003', description: 'M72003 perfomance', devName: 'M72IS20C03D', target: vscode.ConfigurationTarget.Workspace }
      // ],
      { placeHolder: 'Select the target Device/Platform', title: "Target Device/Platform" }
    );

    if (target) {
      toolchain.setCurrentTarget(target._target, config, sbSelectTargetDev);
    }

  });

  vscode.commands.registerCommand('eepl.command.setToolchain', async () => {


    let pickTargets: any[] = [];

    const currentToolchain = config.currentToolchain;

    const toolchains = await toolchain.getToolchains(config);

    if (toolchains != undefined) {

      for (var toolchainInfo of toolchains) {

        const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

        const tmpFilePath = vscode.Uri.joinPath(
          vscode.Uri.file(homeDir),
          ".eec-tmp", `${toolchainInfo.file}.zip`
        );

        const isPicked = (currentToolchain ? currentToolchain.label == toolchainInfo.label : false);
        const pickItem = isPicked ? '$(pass-filled)' : '$(circle-large-outline)';//'$(check)' : ' ';
        const isLocal = (await toolchain.isFileAtUri(tmpFilePath));
        const localItem = isLocal ? '$(folder-active)' : '$(cloud-download)';
        const detail = ` ${pickItem}  $(info) [v${toolchainInfo.ver}]  ${localItem}`;
        pickTargets.push({ label: toolchainInfo.label, detail: detail, picked: isPicked, description: toolchainInfo.description, toolchain: toolchainInfo });
      }

    } else {

      const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

      const tmpDir = vscode.Uri.joinPath(
        vscode.Uri.file(homeDir),
        ".eec-tmp"
      );

      await vscode.workspace.fs.readDirectory(tmpDir).then((files) => {
        files.forEach(element => {

          console.log("file: ", element[0]);

          if (element[1] != vscode.FileType.File || element[0].lastIndexOf(".json") == -1 || element[0].lastIndexOf("ToolchainInfo.") == -1) {
            return;
          }

          const rowFile = fs.readFileSync(vscode.Uri.joinPath(tmpDir, element[0]).fsPath).toString();
          const toolchainInfo: toolchain.ToolchainInfo = JSON.parse(rowFile);

          const isPicked = (currentToolchain ? currentToolchain.label == toolchainInfo.label : false);
          const pickItem = isPicked ? '$(pass-filled)' : '$(circle-large-outline)';//'$(check)' : ' ';
          //const isLocal = true;
          const localItem = '$(file-zip)';// isLocal ? '$(folder-active)' : '$(cloud-download)';
          const detail = ` ${pickItem}  $(info) [v${toolchainInfo.ver}]  ${localItem}`;
          pickTargets.push({ label: toolchainInfo.label, detail: detail, picked: isPicked, description: toolchainInfo.description, toolchain: toolchainInfo });
        });
      }, () => {
        console.log("Can't find toolchains");
      });

    }

    const target = await vscode.window.showQuickPick(
      pickTargets,
      // [
      //   { label: 'M72001', description: 'M72001 basic', devName: 'M72IS20C01D', target: vscode.ConfigurationTarget.Workspace },
      //   { label: 'M72002', description: 'M72002 medium', devName: 'M72IS20C02D', target: vscode.ConfigurationTarget.Workspace },
      //   { label: 'M72003', description: 'M72003 perfomance', devName: 'M72IS20C03D', target: vscode.ConfigurationTarget.Workspace }
      // ],
      { placeHolder: 'Select toolchain version', title: "Toolchain" }
    );

    if (target) {
      await toolchain.installToolchain(config, target.toolchain);
    }

  });


  vscode.commands.registerCommand('eepl.command.createNewProject', async () => {
    createNewProject(config);
  });

  vscode.commands.registerCommand('eepl.command.createProjectFromExample', async () => {
    selectExamples(config);
  });

  const provider = new EasyConfigurationProvider();
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('eembdbg', provider));

}



export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}