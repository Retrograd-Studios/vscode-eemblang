
import * as vscode from 'vscode';

import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';


import * as readline from "readline";

import * as os from "os";

import * as toolchain from './toolchain';

import * as cp from "child_process";
import Path = require('path');
import { Config } from './config';

import * as fs from 'fs';


export interface EasyDbgCfg extends DebugConfiguration {
  request: string,
  cmd: string;
}


async function checkDepencies(extName: string): Promise<boolean> {
  //let extName = "vadimcn.vscode-lldb";

  const debugEngine = vscode.extensions.getExtension(extName);

  if (debugEngine) {
    return true;
  }


  let buttons = ['Install', 'Not now'];
  let choice = await vscode.window.showWarningMessage(`Extension '${extName}' is not installed! It is required for debugging.\n Install now?`, ...buttons);

  if (choice === buttons[0]) {

    let result = false;

    await vscode.commands.executeCommand('workbench.extensions.installExtension', extName).then(() => {
      result = true;
      vscode.window.showInformationMessage(`Extension '${extName}' has been successfully installed`);
    },
      () => {
        vscode.window.showErrorMessage(`Extension '${extName}' has not been installed :(`);
      });

    return result;

  } else {

    vscode.window.showErrorMessage(`Extension '${extName}' has not been installed.\n Debugging is unreached :(`);
    return false;

  }
}




export async function runDebug(config: Config, isSimulator: boolean) {


  if (!(await toolchain.IsToolchainInstalled(config))) {
    return new Promise((resolve, reject) => { reject(); });
  }

  if (config.targetDevice.description == "[Device]") {
    await vscode.commands.executeCommand('eepl.command.setTargetDevice');
    if (config.targetDevice.description == "[Device]") {
      return new Promise((resolve, reject) => { reject(); });
    }
  }

  await toolchain.resolveTarget(config);


  let extName = "marus25.cortex-debug";

  if ((isSimulator) || config.targetDevice.devName.indexOf("windows") != -1) {
    extName = "ms-vscode.cpptools";
  }


  const isCanDebug = await checkDepencies(extName);

  if (!isCanDebug) {
    return;
  }

  const ws = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;

  if (!ws) {
    vscode.window.showErrorMessage('Workspace is not opened.');
    return false;
  }


  if ((isSimulator) || config.targetDevice.devName.indexOf('windows') != -1) {



    const presets = config.get<string>("build.presets");

    let addArgs: string[] = [];

    if (presets == "Debug") {
      addArgs = ["-g", "-O0"];
    } else if (presets == "OpDebug") {
      addArgs = ["-g", "-O3"];
    } else if (presets == "Release") {
      //addArgs = ["-O3", "-drtc"];
      return;
    } else if (presets == "Safe Release") {
      return;
      //addArgs = ["-O3"];
    } else if (presets == "Custom") {
      const opLevel = config.get<string>("build.optimization");
      const isGenDbgInfo = config.get<boolean>("build.generateDbgInfo");
      const isRunTimeChecks = config.get<boolean>("build.runtimeChecks");
      addArgs = [opLevel];
      if (isGenDbgInfo) {
        addArgs.push("-g");
      } else {
        return;
      }
      if (!isRunTimeChecks) {
        addArgs.push("-drtc");
      }
    }


    const targetFile = config.targetDevice.pathToFile;
    const devName = config.targetDevice.devName;

    const dbgArgs = isSimulator ?
      [
        "-target", `${targetFile}`,
        "-triplet", config.targetDevice.triplet,
        "-S", "-jit", "-emit-llvm",
      ].concat(addArgs)
      : [];

    const inputSourceFile = config.get<string>("build.inputFile");
    const outputPath = `${ws.uri.fsPath}/out/${devName}`;

    const dbgArgs2 = (isSimulator) ?
      [`${ws.uri.fsPath}/${inputSourceFile}`].concat(dbgArgs).concat(["-o", `${outputPath}`]) : dbgArgs;

    const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
    const exePath = isSimulator ? vscode.Uri.joinPath(vscode.Uri.file(homeDir),
      ".eec", "bin", os.type() === "Windows_NT" ? `eec.exe` : 'eec')
      : vscode.Uri.file(config.exePath);

    const gdbPath = vscode.Uri.joinPath(vscode.Uri.file(homeDir), '.ecc', 'bin', 'gdb');

    // const task = new vscode.Task(
    //   { type: 'eec', command: isSimulator ? 'simulate' : 'run' },
    //   ws ?? vscode.TaskScope.Workspace,
    //   isSimulator ? 'Run Simulator' : 'run',
    //   'eepl',
    //   new vscode.ProcessExecution(exePath.fsPath, dbgArgs2)
    // );

    let debugConfig: vscode.DebugConfiguration =
    os.platform().toString() === 'win32' ?
    {
      "name":  isSimulator ? `Simulator${config.hostTriplet}-dbg` : `${config.hostTriplet}-dbg`,
      "type": "cppvsdbg",
      "request": "launch",
      "program": exePath.fsPath,
      "args": dbgArgs2,
      "stopAtEntry": false,
      "cwd": "${fileDirname}",
      "environment": []
    }
    :
    {
      "name":  isSimulator ? `Simulator${config.hostTriplet}-dbg` : `${config.hostTriplet}-dbg`,
      "type": "cppdbg",
      "request": "launch",
      "program": exePath.fsPath,
      "args": dbgArgs2,
      "stopAtEntry": false,
      "cwd": "${fileDirname}",
      "environment": [],
      // "MIMode": "gdb",
      // "miDebuggerPath": gdbPath.fsPath
    };

  

    vscode.debug.startDebugging(ws, debugConfig);

    return;

  }



  const pathToArmToolchain = await toolchain.getPathForExecutable("arm-none-eabi-gdb");

  if (!pathToArmToolchain) {
    vscode.window.showErrorMessage("Can't find path to 'GNU Arm Embedded Toolchain'");
    return;
  }

  let progPath = config.exePath;


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

  const DirPathToArmToolchain = Path.dirname(pathToArmToolchain);


  const gdbServerPort = config.get<number>('gdbserver.port');

  const debugConfig: vscode.DebugConfiguration = {
    type: "cortex-debug",
    request: "attach",
    name: "Debug on PLC",
    cwd: "${workspaceFolder}",
    //svdFile: "./bin/target.svd",
    executable: progPath,
    runToEntryPoint: "__entryPoint__",
    servertype: "external",
    //gdbPath: "C:/Users/YouTooLife_PC/.eec/out/build/bin/arm-none-eabi-gdb.exe",
    armToolchainPath: DirPathToArmToolchain,
    gdbPath: pathToArmToolchain,
    gdbTarget: `localhost:${gdbServerPort}`,
    //gdbTarget: "localhost:4242",
    showDevDebugOutput: "raw"
    //preLaunchTask: "st-util"
  };


  vscode.debug.startDebugging(ws, debugConfig);

}


export class EasyConfigurationProvider implements vscode.DebugConfigurationProvider {

  /**
   * Massage a debug configuration just before a debug session is being launched,
   * e.g. add all missing attributes to the debug configuration.
   */
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

    // if launch.json is missing or empty

    console.log(config);

    let debugConfig: vscode.DebugConfiguration = {
      type: "cortex-debug",
      request: "attach",
      name: "Debug on PLC",
      cwd: "${workspaceFolder}",
      svdFile: "./bin/target.svd",
      executable: "./bin/target.o",
      runToEntryPoint: "__entryPoint__",
      servertype: "external",
      armToolchainPath: "D:\\Program Files (x86)\\GNU Arm Embedded Toolchain\\10 2020-q4-major\\bin",
      gdbPath: "D:\\Program Files (x86)\\GNU Arm Embedded Toolchain\\10 2020-q4-major\\bin\\arm-none-eabi-gdb.exe",
      gdbTarget: "localhost:3333",
      showDevDebugOutput: "raw",
      preLaunchTask: "eemblang: Build for Device"
    };


    let cfg = config as EasyDbgCfg;
    if (cfg.cmd == "simulate") {
      debugConfig.preLaunchTask = "eemblang: Run Simulator";
    }
    else {
      //checkDepencies();
    }

    // if (!config.type && !config.request && !config.name) {
    // 	const editor = vscode.window.activeTextEditor;
    // 	if (editor && editor.document.languageId === 'markdown') {
    // 		config.type = 'mock';
    // 		config.name = 'Launch';
    // 		config.request = 'launch';
    // 		config.program = '${file}';
    // 		config.stopOnEntry = true;
    // 	}
    // }

    // if (!config.program) {
    // 	return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
    // 		return undefined;	// abort launch
    // 	});
    // }
    //checkDepencies();


    return debugConfig;
  }
}


