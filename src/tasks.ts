import * as vscode from "vscode";
import * as toolchain from "./toolchain";
import { Config } from "./config";
import * as os from "os";
import { log } from "./util";

export const TASK_TYPE = "eec";
export const TASK_SOURCE = "eepl";


import * as fs from 'fs';

import * as nodePath from 'path';

const posixPath = nodePath.posix || nodePath;

export enum EasyTaskId {
    Build = 0,
    Simulate, 
    Link,
    EBuild,
    Flush
}


export interface EasyTaskDefinition extends vscode.TaskDefinition {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: { [key: string]: string };
    overrideEasy?: string;
    dependsOn?: string;
    envCfg: Config;
}


class EasyTaskProvider implements vscode.TaskProvider {
    private readonly config: Config;

    constructor(config: Config) {
        this.config = config;
    }

    async provideTasks(): Promise<vscode.Task[]> {
        // Detect Rust tasks. Currently we do not do any actual detection
        // of tasks (e.g. aliases in .cargo/config) and just return a fixed
        // set of tasks that always exist. These tasks cannot be removed in
        // tasks.json - only tweaked.

        const pathToEec  = await toolchain.easyPath();
        const pathToLinker  = await toolchain.linkerPath();
        const pathToEbuild  = await toolchain.ebuildPath();


        const defs = [
            { command: "build", name: "Build for Device", args: ["-triplet", "thumbv7m-none-none-eabi", "-emit-llvm", "-g", "-O3"], group: vscode.TaskGroup.Build },
            { command: "simulate", name: "Run Simulator", args: ["-jit", "-S", "-emit-llvm", "-g", "-O3"], group: undefined },
            { command: "link", name: "linker", args: toolchain.targetInfoDefaultValue.linkArgs.slice(1), group: undefined, /*dependsOn: "eemblang: Build for Device"*/ },
            { command: "ebuild", name: "buildAELF", args: [
                "-f", "${cwd}\\out\\target_out.o",
                "-o", "${cwd}\\out\\prog.alf",
                "-m", "${cwd}\\out\\output.map",
                "-c", "${cwd}\\out\\test.cpp_CFG.bin",
                "-r", "${cwd}\\out\\test.cpp_RES.bin" ]
                , group: undefined }
        ];

        const tasks: vscode.Task[] = [];
        for (const workspaceTarget of vscode.workspace.workspaceFolders || []) {
            for ( const def of defs ) {
                var args0;
                
                if ( def.command == "link" || def.command == "ebuild"  )
                {
                    args0 = def.args;
                }
                else
                {
                    args0 = [`${workspaceTarget.uri.fsPath}/PackageInfo.es`].concat(def.args);
                }
                const vscodeTask = await buildEasyTask2(
                workspaceTarget,
                { type: TASK_TYPE, command: def.command, args: args0, envCfg: this.config },
                def.name,
                args0,
                this.config
                );
                vscodeTask.group = def.group;
                tasks.push( vscodeTask ); 
            }
        }
        return tasks;
    }


   



    async resolveTask( task: vscode.Task ): Promise<vscode.Task | undefined> {
        // VSCode calls this for every cargo task in the user's tasks.json,
        // we need to inform VSCode how to execute that command by creating
        // a ShellExecution for it.
        if (!(await toolchain.IsToolchainInstalled(this.config))) {
            return new Promise((resolve, reject) => { reject(); });
        }

        const definition = task.definition as EasyTaskDefinition;

        if ( definition.type === TASK_TYPE && definition.command ) {
            return await buildEasyTask2(
                task.scope,
                definition,
                task.name,
                definition.args ?? [],
                this.config
            );
        }

        return undefined;
    }
}


export async function createTask(idx: EasyTaskId, config: Config): Promise<vscode.Task | undefined> {

    if (config.isInternalLinker && idx >= EasyTaskId.Link && idx <= EasyTaskId.EBuild) {
        return undefined;
    }

    if (!(await toolchain.IsToolchainInstalled(config))) {
        return new Promise((resolve, reject) => { reject(); });
    }

    let workspaceTarget: vscode.WorkspaceFolder | undefined = undefined; 

    for (const workspaceTarget0 of vscode.workspace.workspaceFolders || []) {
        workspaceTarget = workspaceTarget0;
        break;
    }

    if (!(await toolchain.resolveTarget(config))) {
        return new Promise((resolve, reject) => { reject(); });
    }

    const targetFile = config.targetDevice.pathToFile;

    let ldPath = targetFile;
    const pIdx = ldPath.lastIndexOf("targetInfo.json");
    if (pIdx !== -1)
    {
        ldPath = ldPath.substring(0, pIdx-1) + "/target_out.ld";
    }

    const devName = config.targetDevice.devName;
    const cwd = "${cwd}";

    const isOldToolchain = config.isOldToolchain;

    let toolcahinPath = await toolchain.easyPath();
    const pIdx2 = toolcahinPath.lastIndexOf("bin");

    const outputPath = isOldToolchain? `${workspaceTarget!.uri.fsPath}/out/${devName}/output` : `${workspaceTarget!.uri.fsPath}/out/${devName}`;

    //const productName = config.productName;
    const productPath = config.productPath;
    const uploadingFilePath = config.uploadingFilePath;
    const exePath = config.exePath;

    const presets = config.get<string>("build.presets");

    let addArgs: string[] = [];

    let isGenDbgInfo = false;

    if (presets == "Debug") {
        addArgs = ["-g", "-O0"];
        isGenDbgInfo = true;
    } else if (presets == "OpDebug") {
        addArgs = ["-g", "-O3"];
        isGenDbgInfo = true;
    } else if (presets == "Release") {
        addArgs = ["-O3", "-drtc"];
    } else if (presets == "Safe Release") {
        addArgs = ["-O3"];
    } else if (presets == "Custom") {
        const opLevel = config.get<string>("build.optimization");
        isGenDbgInfo = config.get<boolean>("build.generateDbgInfo");
        const isRunTimeChecks = config.get<boolean>("build.runtimeChecks");
        addArgs = [opLevel];
        if (isGenDbgInfo) {
            addArgs.push("-g");
        }
        if (!isRunTimeChecks) {
            addArgs.push("-drtc");
        }
    }
    
    let ebuildArgs: string[] = [];
    if (isOldToolchain) {
        ebuildArgs = [
            "-f", `${exePath}`,
            "-o", `${uploadingFilePath}`,
            "-m", `${productPath}.map`,
            "-c", `${productPath}_CFG.bin`,
            "-r", `${productPath}_RES.bin`
        ];
    } else {
        ebuildArgs = [
            "-f", `${productPath}.elf`,
            "-o", `${productPath}.alf`,
            "-m", `${productPath}.map`,
            "-d", `${productPath}ROM_MEMORY_DEFAULTS.bin`,
            "-c", `${productPath}CONFIG.bin`,
            "-r", `${productPath}RESOURCES.bin`
        ];
    }
    
    const inputSourceFile = isOldToolchain ? 'main.es' : config.get<string>("build.inputFile");

    const defs = [
        { command: "build", name: "Build for Device", args: ["-target", `${targetFile}`, "-triplet", config.targetDevice.triplet, "-S", "-emit-llvm"].concat(addArgs), group: vscode.TaskGroup.Build },
        { command: "simulate", name: "Run Simulator", args: ["-target", `${targetFile}`, "-jit", "-S", "-emit-llvm"].concat(addArgs), group: undefined },
        { command: "link", name: "linker", args: config.targetDevice.linkArgs, group: undefined },
        { command: "ebuild", name: "buildAELF", args: ebuildArgs, group: undefined },
        { command: "flaher", name: "EEmbFlasher", args: [`${uploadingFilePath}`], group: undefined }
    ];

    const def = defs[idx];

    const args0 = (idx == 0 || idx == 1) ? 
        [`${workspaceTarget!.uri.fsPath}/${inputSourceFile}`].concat(def.args).concat(["-o", `${outputPath}`]) : def.args;

    const vscodeTask = await buildEasyTask2(
        //workspaceTarget,
        vscode.TaskScope.Workspace,
        { type: TASK_TYPE, command: def.command, args: args0, envCfg: config },
        def.name,
        args0,
        config
        );
        vscodeTask.group = def.group;
        vscodeTask.presentationOptions.showReuseMessage = false;

    return vscodeTask;
}


export async function buildEasyTask2(
    scope: vscode.WorkspaceFolder | vscode.TaskScope | undefined,
    definition: EasyTaskDefinition,
    name: string,
    args: string[],
    config: Config
): Promise<vscode.Task> {

    const exeMap = new Map<string, string>([
        ["build",  "eec"],
        ["simulate", "eec"],
        ["ebuild", "ebuild"],
        ["flaher", "eflash"],
    ]);

    if (config.targetDevice.devName.indexOf("windows") != -1) {
        exeMap.set("link","lld-link");
    } else {
        exeMap.set("link","ld.lld");
    }

    const exeName = exeMap.get(definition.command!);

    const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
    const exePath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir), ".eec", "bin", os.type() === "Windows_NT" ? `${exeName!}.exe` : exeName!);

    const task = new vscode.Task(
     //definition,
    {type: definition.type, command: definition.command!},
      scope ?? vscode.TaskScope.Workspace,
      name,
      TASK_SOURCE,
      new vscode.ProcessExecution(exePath.fsPath, args)
    );

    const index = args.lastIndexOf("-o");
    if (index != -1) {
        //const outDirUri = vscode.Uri.file(args[0]);
        //const outDir = posixPath.dirname(outDirUri.path);
        const uri = vscode.Uri.file(posixPath.dirname(args[index+1]));

        (await (vscode.workspace.fs.stat(uri)).then(()=>{}, () => {
            vscode.workspace.fs.createDirectory(uri);
        }));
    }
    
    return task;

}



// export async function buildEasyTask(
//     scope: vscode.WorkspaceFolder | vscode.TaskScope | undefined,
//     definition: EasyTaskDefinition,
//     name: string,
//     args: string[],
//     config: Config
// ): Promise<vscode.Task> {
//     let exec: vscode.ProcessExecution | vscode.ShellExecution | undefined = undefined;

//     //if ( task.group === vscode.TaskGroup.Build ) {
//     if ( definition.command == "build" ) {
//         for (const file of vscode.workspace.textDocuments) {
//             if (file.isDirty) {
//                 console.log("changes: ", file.fileName, file.version);
//                 file.save();
//             } else {
//                 console.log("no changes: ", file.fileName, file.version);
//             }
//         }
//     }

// console.log( "command: ", definition.command );

//     const devName = definition.command == "simulate" ? "Simulator" : config.targetDevice.devName;

//     if ( definition.command == "link"  || definition.command == "ebuild" || definition.command == "flaher" )
//     {
//         if ( !exec ) {
//             // Check whether we must use a user-defined substitute for cargo.
//             // Split on spaces to allow overrides like "wrapper cargo".
//             const overrideEasy= definition.overrideEasy ?? definition.overrideEasy;

//             var easyPath  = await toolchain.linkerPath();
            
//             if ( definition.command == "ebuild" )
//             {
//                 easyPath = await toolchain.ebuildPath();
//             }
//             else if ( definition.command == "flaher" )
//             {
//                 easyPath = await toolchain.flasherPath();
//             }

//             const easyCommand = overrideEasy?.split(" ") ?? [easyPath];
    
//             const fullCommand = [...easyCommand, ...args];
    
//             exec = new vscode.ProcessExecution( fullCommand[0], fullCommand.slice(1), definition );
//         }
//     }
//     else
//     {
//     if ( !exec ) {
//         // Check whether we must use a user-defined substitute for cargo.
//         // Split on spaces to allow overrides like "wrapper cargo".
//         const overrideEasy= definition.overrideEasy ?? definition.overrideEasy;
//         const easyPath = await toolchain.easyPath();
//         const easyCommand = overrideEasy?.split(" ") ?? [easyPath];

//         const index = args.indexOf("-o", 0);
//         if (index == -1) {
//             let uri = vscode.Uri.file(args[0]);
//             let path = "";
//             try {
//                 let stat = (await vscode.workspace.fs.stat(uri));
//                 if (stat.type == vscode.FileType.File) {
//                     path = posixPath.dirname(uri.path);
//                     path = path.concat(`/out/${devName}/output`);
//                     if (os.type() === "Windows_NT" && path[0] == '/') {
//                         path = path.slice(1);
//                     }
//                 }
//                 else {
//                     path = args[0].concat(`/out/${devName}/output`);
//                 }
//             } catch {
//                 vscode.window.showErrorMessage(`Can't compile file '${args[0]}'`);
//                 return new Promise(function(resolve, reject) {
//                     reject("Error");
//                 });
//             }
//             args = args.concat(["-o", path]);
//             uri = vscode.Uri.file(posixPath.dirname(path));
//             (await (vscode.workspace.fs.stat(uri)).then(()=>{}, () => {
//                 vscode.workspace.fs.createDirectory(uri);
//             }));
//         }
        
//         const fullCommand = [...easyCommand, ...args];

//         exec = new vscode.ProcessExecution( fullCommand[0], fullCommand.slice(1), definition );
//     }
//     }
//     return new vscode.Task( 
//         definition,
//         // scope can sometimes be undefined. in these situations we default to the workspace taskscope as
//         // recommended by the official docs: https://code.visualstudio.com/api/extension-guides/task-provider#task-provider)
//         scope ?? vscode.TaskScope.Workspace,
//         name,
//         TASK_SOURCE,
//         exec,
//         ["$eec"]
//     );
// }

export function activateTaskProvider(config: Config): vscode.Disposable {
    const provider = new EasyTaskProvider(config);
    return vscode.tasks.registerTaskProvider(TASK_TYPE, provider);
}