

import * as os from "os";
import * as vscode from "vscode";
import { checkToolchain } from "./toolchain";
import { Config } from "./config";


export type ExampleInfo = {
    name: string;
    dir: string;
    description: string;
}



export async function getExamples(config: Config): Promise<ExampleInfo[]> {

    const isFoundToolchain = await checkToolchain(config);
    if (!isFoundToolchain)
    {
        vscode.window.showErrorMessage(`EEPL Compiler is not installed! Can't find toolchain`);
        return [];
    }

    let examples: ExampleInfo[] = [];

    const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

    const examplesDir = vscode.Uri.joinPath(
        vscode.Uri.file(homeDir),
        ".eec", "Samples"
    );

    await vscode.workspace.fs.readDirectory(examplesDir).then((files) => {

        files.forEach(element => {

            console.log("file: ", element[0]);

            if (element[1] != vscode.FileType.Directory) {
                return;
            }

            examples.push({
                name: element[0],
                dir: vscode.Uri.joinPath(
                    examplesDir,
                    element[0]
                ).path,
                description: ""
            });

        }, () => {
            console.log("Can't find Examples");
        });

    });

    return examples;

}



export async function selectExamples(config: Config) {

    const examples = await getExamples(config);

    let pickExamples: any[] = [];

    for (const example of examples) {
        //const isPicked = (prevVers == toolchainInfo.label);
        //const pickItem = isPicked ? '$(check)' : ' ';
        //const isLocal = (await toolchain.isFileAtUri(tmpFilePath));
        //const localItem = isLocal ? '$(folder-active)' : '$(cloud-download)';
        //const detail = ` ${pickItem}  $(info) [v${toolchainInfo.ver}]  ${localItem}`;
        pickExamples.push({
            label: example.name, detail: "", description: example.description, dir: example.dir
        });
    }

    const exampleQP = await vscode.window.showQuickPick(
        pickExamples,
        { placeHolder: 'Select example', title: "Example" }
    );

    if (exampleQP) {
        console.log(exampleQP.dir);

        const projectName = await vscode.window.showInputBox({
            placeHolder: "ProjectName",
            value: "Project",
            title: "Enter project name"
        });

        if (projectName == undefined) {
            return;
        }

        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: 'Select project dir',
            canSelectFiles: false,
            canSelectFolders: true
        };

        await vscode.window.showOpenDialog(options).then(fileUri => {
            if (fileUri && fileUri[0]) {
                console.log('Selected dir: ' + fileUri[0].fsPath);

                const newWorkspace = vscode.Uri.joinPath(
                    fileUri[0], projectName);
                    
                

                vscode.workspace.fs.copy(vscode.Uri.file(exampleQP.dir), newWorkspace).then(async () => { 
                    
                    const isWorkspace = vscode.workspace.workspaceFolders?.length ? true : false;

                    if (!vscode.workspace.updateWorkspaceFolders(0, isWorkspace ? vscode.workspace.workspaceFolders?.length : null, { uri: newWorkspace, name: projectName})) {
                        vscode.window.showErrorMessage(`Can't open project ${projectName}.`, "Ok");
                    } else {
                        await vscode.workspace.fs.readDirectory(newWorkspace).then(files => {
                            for (const file of files) {
                                console.log("File: "+file[0]);
                                const fileUri = vscode.Uri.joinPath(newWorkspace, file[0]);
                                if (file[1] == vscode.FileType.File) {
                                    vscode.workspace.openTextDocument(fileUri).then(async (doc)=>{
                                        await vscode.window.showTextDocument(doc, 1, false);
                                    }, e => {
                                        console.log("Error: "+e);
                                    })
                                }
                            }
                        }, (e) => {
                            console.log("Error: "+e);
                        });
                        
                    }

                    }, (e) => {
                        console.log("Error: "+e);
                        vscode.window.showErrorMessage(`Can't create new project. ${e}`, "Ok");
                    });
            }
        });
    }
}







export async function createNewProject(config: Config) {

    const isFoundToolchain = await checkToolchain(config);
    if (!isFoundToolchain)
    {
        vscode.window.showErrorMessage(`EEPL Compiler is not installed! Can't find toolchain`);
        return;
    }


    const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

    const templateDir = vscode.Uri.joinPath(
        vscode.Uri.file(homeDir),
        ".eec", "Templates", "Simple"
    );

        const projectName = await vscode.window.showInputBox({
            placeHolder: "ProjectName",
            value: "Project",
            title: "Enter project name"
        });

        if (projectName == undefined) {
            return;
        }

        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: 'Select project dir',
            canSelectFiles: false,
            canSelectFolders: true
        };

        await vscode.window.showOpenDialog(options).then(fileUri => {
            if (fileUri && fileUri[0]) {
                console.log('Selected dir: ' + fileUri[0].fsPath);

                const newWorkspace = vscode.Uri.joinPath(
                    fileUri[0], projectName);

                vscode.workspace.fs.copy(templateDir, newWorkspace).then(async () => { 

                    const isWorkspace = vscode.workspace.workspaceFolders?.length ? true : false;

                    if (!vscode.workspace.updateWorkspaceFolders(0, isWorkspace ? vscode.workspace.workspaceFolders?.length : null, { uri: newWorkspace, name: projectName})) {
                        vscode.window.showErrorMessage(`Can't open project ${projectName}`, "Ok");
                    } else {
     
                        await vscode.workspace.fs.readDirectory(newWorkspace).then(files => {
                            for (const file of files) {
                                console.log("File: "+file[0]);
                                const fileUri = vscode.Uri.joinPath(newWorkspace, file[0]);
                                if (file[1] == vscode.FileType.File) {
                                    vscode.workspace.openTextDocument(fileUri).then(async (doc)=>{
                                        await vscode.window.showTextDocument(doc, 1, false);
                                    }, e => {
                                        console.log("Error: "+e);
                                    })
                                }
                            }
                        }, (e) => {
                            console.log("Error: "+e);
                        });
                        
                    }

                    }, (e) => {
                        console.log("Error "+e);
                        vscode.window.showErrorMessage("Can't create new project", "Ok");
                    });
            }
        });
}

