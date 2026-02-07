import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { execute, log, memoizeAsync } from "./util";
import * as fsExtra from 'fs-extra';
import * as unzip from 'unzip-stream';

import * as fs from 'fs';
import * as https from 'https';


import fetch from 'node-fetch';
import { ClientRequest } from 'http';
import { Config } from "./config";


interface CompilationArtifact {
  fileName: string;
  name: string;
  kind: string;
  isTest: boolean;
}

export interface ArtifactSpec {
  easyArgs: string[];
  filter?: (artifacts: CompilationArtifact[]) => CompilationArtifact[];
}

export class Easy {
  constructor(readonly rootFolder: string, readonly output: vscode.OutputChannel) { }

  // Made public for testing purposes
  static artifactSpec(args: readonly string[]): ArtifactSpec {
    const easyArgs = [...args, "--message-format=json"];

    // arguments for a runnable from the quick pick should be updated.
    // see crates\rust-analyzer\src\main_loop\handlers.rs, handle_code_lens
    switch (easyArgs[0]) {
      case "run":
        easyArgs[0] = "build";
        break;
      case "test": {
        if (!easyArgs.includes("--no-run")) {
          easyArgs.push("--no-run");
        }
        break;
      }
    }

    const result: ArtifactSpec = { easyArgs: easyArgs };
    if (easyArgs[0] === "test" || easyArgs[0] === "bench") {
      // for instance, `crates\rust-analyzer\tests\heavy_tests\main.rs` tests
      // produce 2 artifacts: {"kind": "bin"} and {"kind": "test"}
      result.filter = (artifacts) => artifacts.filter((it) => it.isTest);
    }

    return result;
  }

  private async getArtifacts(spec: ArtifactSpec): Promise<CompilationArtifact[]> {
    const artifacts: CompilationArtifact[] = [];

    try {
      await this.runEasy(
        spec.easyArgs,
        (message) => {
          if (message.reason === "compiler-artifact" && message.executable) {
            const isBinary = message.target.crate_types.includes("bin");
            const isBuildScript = message.target.kind.includes("custom-build");
            if ((isBinary && !isBuildScript) || message.profile.test) {
              artifacts.push({
                fileName: message.executable,
                name: message.target.name,
                kind: message.target.kind[0],
                isTest: message.profile.test,
              });
            }
          } else if (message.reason === "compiler-message") {
            this.output.append(message.message.rendered);
          }
        },
        (stderr) => this.output.append(stderr)
      );
    } catch (err) {
      this.output.show(true);
      throw new Error(`Easy invocation has failed: ${err}`);
    }

    return spec.filter?.(artifacts) ?? artifacts;
  }

  async executableFromArgs(args: readonly string[]): Promise<string> {
    const artifacts = await this.getArtifacts(Easy.artifactSpec(args));

    if (artifacts.length === 0) {
      throw new Error("No compilation artifacts");
    } else if (artifacts.length > 1) {
      throw new Error("Multiple compilation artifacts are not supported.");
    }

    return artifacts[0].fileName;
  }

  private async runEasy(
    easyArgs: string[],
    onStdoutJson: (obj: any) => void,
    onStderrString: (data: string) => void
  ): Promise<number> {
    const path = await easyPath();
    return await new Promise((resolve, reject) => {
      const easy = cp.spawn(path, easyArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: this.rootFolder,
      });

      easy.on("error", (err) => reject(new Error(`could not launch EEmbLang compiler: ${err}`)));

      easy.stderr.on("data", (chunk) => onStderrString(chunk.toString()));

      const rl = readline.createInterface({ input: easy.stdout });
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        onStdoutJson(message);
      });

      easy.on("exit", (exitCode, _) => {
        if (exitCode === 0) resolve(exitCode);
        else reject(new Error(`exit code: ${exitCode}.`));
      });
    });
  }
}

/** Mirrors `project_model::sysroot::discover_sysroot_dir()` implementation*/
export async function getSysroot(dir: string): Promise<string> {
  const easyPath = await getPathForExecutable("eec");

  // do not memoize the result because the toolchain may change between runs
  return await execute(`${easyPath} --print sysroot`, { cwd: dir });
}

export async function getEasyId(dir: string): Promise<string> {
  const easyPath = await getPathForExecutable("eec");

  // do not memoize the result because the toolchain may change between runs
  const data = await execute(`${easyPath} -V -v`, { cwd: dir });
  const rx = /commit-hash:\s(.*)$/m;

  return rx.exec(data)![1];
}

/** Mirrors `toolchain::cargo()` implementation */
export function easyPath(): Promise<string> {
  return getPathForExecutable("eec");
}

export function linkerPath(): Promise<string> {
  return getPathForExecutable("ld.lld");
}

export function ebuildPath(): Promise<string> {
  return getPathForExecutable("ebuild");
}

export function flasherPath(): Promise<string> {
  return getPathForExecutable("eflash");
}




export type ToolchainInfo = {
  label: string;
  file: string;
  description: string;
  ver: string;
  url: string;
  api: number;
}

export type ToolchainsFile = {
  toolchains: ToolchainInfo[];
}


export type EECompilerOutput = {
  libs: string[];
  productName: string;
}



// export let LastToolchain: ToolchainInfo | undefined = undefined;

async function installStdLibs(config: Config, targetDevice: TargetInfo): Promise<boolean> {

  let homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

  const tmpDir = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec-tmp"
  );

  const tmpFilePath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec-tmp", `stdlib_${targetDevice.devName}.zip`
  );

  // const toolchainDirPath = vscode.Uri.joinPath(
  //   vscode.Uri.file(homeDir),
  //   "lib"
  // );

  const libsRootDirPath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec"
  );

  if (!(await isDirAtUri(tmpDir))) {
    await vscode.workspace.fs.createDirectory(tmpDir).then(() => { }, () => {
      console.log('Create dir error!');
    });
  }

  let result = false;

  const prog = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Downloading...",
    cancellable: true
  }, async (progress, token) => {

    progress.report({ message: "0 Mbyte", increment: 0 });

    let totalSize = 1;
    let prevSize = 0;
    let currentSize = 0;

    let request: ClientRequest;

    let isTerminated = false;

    async function download(url: string | URL /*| https.RequestOptions*/, targetFile: fs.PathLike): Promise<boolean> {
      return new Promise((resolve, reject) => {

        request = https.get(url, /*{ headers: { responseType: 'arraybuffer'} } ,*/ response => {

          const code = response.statusCode ?? 0

          if (code >= 400) {
            isTerminated = true;
            reject(new Error(response.statusMessage));
          }

          // handle redirects
          if (code > 300 && code < 400 && !!response.headers.location) {
            resolve(download(response.headers.location, targetFile));
            return;
          }

          totalSize = response.headers['content-length'] ? Number(response.headers['content-length']) : 1;
          console.log(totalSize);

          response.on('data', (chunk) => {
            const buffer = chunk as Buffer;
            prevSize = currentSize;

            if (totalSize == 1) {
              console.log("Compressed size:", buffer.readInt32LE(20));
              console.log("Uncompressed size:", buffer.readInt32LE(24));
              console.log("Extra field length:", buffer.readInt16LE(30));
              totalSize = 2;
            }
            //currentSize += 1024*1024;//buffer.byteLength;
            currentSize += buffer.byteLength;
          });

          response.on('error', (err) => {
            console.log(err);
            isTerminated = true;
            resolve(false);
            response.unpipe();
          });


          try {

            let isAborted = false;
            const fileWriter = fs.createWriteStream(targetFile, {})
              .on('finish', async () => {


                if (isAborted) {
                  return;
                }

                console.log("done");
                progress.report({ message: "Installing...", increment: -100 });
                try {

                  totalSize = fsExtra.statSync(tmpFilePath.fsPath).size;
                  currentSize = 0;

                  const unZipStream = fsExtra.createReadStream(tmpFilePath.fsPath).on('data', (chunk: Buffer) => {
                    const buffer = chunk as Buffer;
                    currentSize += buffer.length;
                  }).on('error', (err: Error) => {
                    throw err;
                  });

                  unZipStream.pipe(unzip.Extract({ path: libsRootDirPath.fsPath })).on('finish', async () => {

                    vscode.window.showInformationMessage(`STD libs have been successuly installed!`, ...['Ok']);
                    isTerminated = true;
                  }).on('error', (err: Error) => {
                    throw err;
                  });

                } catch (err) {
                  console.log();
                  (async () => {
                    vscode.window.showErrorMessage(`Invalid STD libs archive!`, ...['Ok']);
                  })();
                }

                progress.report({ message: "Installing...", increment: 100 });
                //isTerminated = true;
                resolve(true);

              }).on('error', () => {
                console.log("err");
                isTerminated = true;
                resolve(false);
                fileWriter.close();
              }).on('unpipe', () => {
                isAborted = true;
                fileWriter.close();
              });

            response.pipe(fileWriter);

          } catch (err) {
            console.log(err);
          }


        }).on('error', error => {
          console.log(error);
          isTerminated = true;
          vscode.window.showErrorMessage(`Unknown error while downloading or installing`, ...['Ok']);
          resolve(false);
        }).setTimeout(10000).on('timeout', () => {
          vscode.window.showErrorMessage(`Connection timeout.`, ...['Ok']);
          console.log("Request timeout");
          isTerminated = true;
          resolve(false);
        });

        //resolve(true);
      });
    }

    const result0 = download(targetDevice.stdlibUrl, tmpFilePath.fsPath);

    token.onCancellationRequested(() => {
      //console.log("User canceled the long running operation");
      request.destroy();
    });

    let prevPer = 0;
    while (!isTerminated) {
      await new Promise(f => setTimeout(f, 100));
      totalSize = totalSize ? totalSize : 1;
      const inPerc = Math.round(((currentSize)) * 100 / totalSize);
      let inc = inPerc - prevPer;
      prevPer = inPerc;
      const currentSizeInMb = Math.round((currentSize / 1024) / 1024);
      const totalSizeInMb = Math.round((totalSize / 1024) / 1024);
      console.log("[" + currentSizeInMb + "/" + totalSizeInMb + " Mbytes]", inPerc);
      progress.report({ message: "[" + currentSizeInMb + "/" + totalSizeInMb + " Mbytes]", increment: inc });

      if (token.isCancellationRequested) {
        return false;
      }

    }

    result = await result0;

    return;
  });

  const stdlibPath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec",
    config.targetDevice.stdlibPath
  );

  return await isDirAtUri(stdlibPath);
}


export async function installToolchain(config: Config, toolchainInfo: ToolchainInfo): Promise<boolean> {

  if (toolchainInfo.api !== undefined && config.api < toolchainInfo.api) {
    await vscode.window.showErrorMessage(`The selected Toolchain requires v${toolchainInfo.api} API, but VSCode extension has v${config.api} API.
Please update your VSCode extension for EEPL!`, {modal: true});
      return false;
  }


  let homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

  const tmpDir = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec-tmp"
  );

  const tmpFilePath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec-tmp", `${toolchainInfo.file}.zip`
  );


  const toolchainDirPath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir)
  );

  if (!(await isDirAtUri(tmpDir))) {
    await vscode.workspace.fs.createDirectory(tmpDir).then(() => { }, () => {
      console.log('Create dir error!');
    });
  }

  const isExist = fs.existsSync(tmpFilePath.fsPath);// ( ( await isFileAtUri(tmpFilePath) ) ) ;

  let result = false;

  const prog = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: !isExist ? "Downloading..." : "Installing...",
    cancellable: true
  }, async (progress, token) => {

    progress.report({ message: "0 Mbyte", increment: 0 });

    let totalSize = 1;
    let prevSize = 0;
    let currentSize = 0;

    let request: ClientRequest;

    let isTerminated = false;

    async function download(url: string | URL /*| https.RequestOptions*/, targetFile: fs.PathLike): Promise<boolean> {
      return new Promise((resolve, reject) => {


        request = https.get(url, /*{ headers: { responseType: 'arraybuffer'} } ,*/ response => {

          const code = response.statusCode ?? 0

          if (code >= 400) {
            isTerminated = true;
            reject(new Error(response.statusMessage));
          }

          // handle redirects
          if (code > 300 && code < 400 && !!response.headers.location) {
            resolve(download(response.headers.location, targetFile));
            return;
          }

          totalSize = response.headers['content-length'] ? Number(response.headers['content-length']) : 1;
          console.log(totalSize);

          response.on('data', (chunk) => {
            const buffer = chunk as Buffer;
            prevSize = currentSize;

            if (totalSize == 1) {
              console.log("Compressed size:", buffer.readInt32LE(20));
              console.log("Uncompressed size:", buffer.readInt32LE(24));
              console.log("Extra field length:", buffer.readInt16LE(30));
              totalSize = 2;
            }
            //currentSize += 1024*1024;//buffer.byteLength;
            currentSize += buffer.byteLength;
          });

          response.on('error', (err) => {
            console.log(err);
            isTerminated = true;
            resolve(false);
            response.unpipe();
          });


          try {

            let isAborted = false;
            const fileWriter = fs.createWriteStream(targetFile, {})
              .on('finish', async () => {


                if (isAborted) {
                  return;
                }

                console.log("done");
                progress.report({ message: "Installing...", increment: -100 });
                try {
                  // let buttons = ['Yes', 'No'];
                  // let choice = await vscode.window.showInformationMessage(`Do you want to use clear install?`, { modal: true }, ...buttons);
                  // if (choice === buttons[0]) {
                  //   fs.rmSync(vscode.Uri.joinPath(toolchainDirPath, '.eec').fsPath, { recursive: true, force: true });
                  // }
                  fs.rmSync(vscode.Uri.joinPath(toolchainDirPath, '.eec').fsPath, { recursive: true, force: true });

                  totalSize = fsExtra.statSync(tmpFilePath.fsPath).size;
                  currentSize = 0;

                  const unZipStream = fsExtra.createReadStream(tmpFilePath.fsPath).on('data', (chunk: Buffer) => {
                    const buffer = chunk as Buffer;
                    currentSize += buffer.length;
                  }).on('error', (err: Error) => {
                    throw err;
                  });

                  unZipStream.pipe(unzip.Extract({ path: toolchainDirPath.fsPath })).on('finish', async () => {

                    if (os.platform().toString() != 'win32') {
                      let binPath = vscode.Uri.joinPath(toolchainDirPath, ".eec", "bin");

                      await vscode.workspace.fs.readDirectory(binPath).then((files) => {
                        files.forEach(element => {
                          const subFile = vscode.Uri.joinPath(binPath, element[0]).fsPath;

                          try {
                            const fd = fs.openSync(subFile, 'r+');
                            fs.fchmodSync(fd, 0o777);
                            fs.closeSync(fd);
                            if (element[0] != 'lld' && element[0].indexOf("lld") != -1) {
                              fs.rmSync(subFile, { force: true });
                              fs.symlinkSync('lld', subFile, 'file');
                            }
                          } catch (e) {
                            vscode.window.showErrorMessage(`Can't open file ${subFile} to set file permission`, ...['Ok']);
                            return;
                          }

                        });
                      }, () => {
                        console.log("err");
                      });
                    }


                    vscode.window.showInformationMessage(`Toolchain has been successuly installed!`, ...['Ok']);
                    isTerminated = true;
                  }).on('error', (err: Error) => {
                    throw err;
                  });

                } catch (err) {
                  console.log();
                  (async () => {
                    let buttons = ['Yes', 'No'];
                    let choice = await vscode.window.showErrorMessage(`Invalid toolcahin archive!\nDo you want to delete this file?`, ...buttons);
                    if (choice === buttons[0]) {
                      fs.rm(tmpFilePath.fsPath, () => {
                      });
                    }
                  })();
                }

                progress.report({ message: "Installing...", increment: 100 });
                //isTerminated = true;
                resolve(true);

              }).on('error', () => {
                console.log("err");
                isTerminated = true;
                resolve(false);
                fileWriter.close();
              }).on('unpipe', () => {
                isAborted = true;
                fileWriter.close();
              });

            response.pipe(fileWriter);

          } catch (err) {
            console.log(err);
          }


        }).on('error', error => {
          console.log(error);
          isTerminated = true;
          vscode.window.showErrorMessage(`Unknown error while downloading or installing`, ...['Ok']);
          resolve(false);
        }).setTimeout(10000).on('timeout', () => {
          vscode.window.showErrorMessage(`Connection timeout.`, ...['Ok']);
          console.log("Request timeout");
          isTerminated = true;
          resolve(false);
        });

        //resolve(true);
      });
    }

    const result0 = !isExist ? download(toolchainInfo.url, tmpFilePath.fsPath) : true;

    if (isExist) {
      progress.report({ message: "Installing...", increment: 0 });
      try {
        // let buttons = ['Yes', 'No'];
        // let choice = await vscode.window.showInformationMessage(`Do you want to use clear install?`, { modal: true }, ...buttons);
        // if (choice === buttons[0]) {
        //   fs.rmSync(vscode.Uri.joinPath(toolchainDirPath, '.eec').fsPath, { recursive: true, force: true });
        // }
        fs.rmSync(vscode.Uri.joinPath(toolchainDirPath, '.eec').fsPath, { recursive: true, force: true });

        totalSize = fsExtra.statSync(tmpFilePath.fsPath).size;

        const unZipStream = fsExtra.createReadStream(tmpFilePath.fsPath).on('data', (chunk: Buffer) => {
          const buffer = chunk as Buffer;
          currentSize += buffer.length;
        }).on('error', (err: Error) => {
          throw err;
        });

        unZipStream.pipe(unzip.Extract({ path: toolchainDirPath.fsPath })).on('finish', async () => {

          if (os.platform().toString() != 'win32') {
            let binPath = vscode.Uri.joinPath(toolchainDirPath, ".eec", "bin");
            let ldPath = vscode.Uri.joinPath(binPath, 'lld').fsPath;

            await vscode.workspace.fs.readDirectory(binPath).then((files) => {
              files.forEach(element => {
                const subFile = vscode.Uri.joinPath(binPath, element[0]).fsPath;

                try {
                  const fd = fs.openSync(subFile, 'r+');
                  fs.fchmodSync(fd, 0o777);
                  fs.closeSync(fd);
                  if (element[0] != 'lld' && element[0].indexOf("lld") != -1) {
                    fs.rmSync(subFile, { force: true });
                    fs.symlinkSync(ldPath, subFile, 'file');
                  }
                } catch (e) {
                  vscode.window.showErrorMessage(`Can't open file ${subFile} to set file permission`, ...['Ok']);
                  return;
                }

              });
            }, () => {
              console.log("err");
            });
          }

          vscode.window.showInformationMessage(`Toolchain has been successuly installed!`, ...['Ok']);
          isTerminated = true;
        }).on('error', (err: Error) => {
          throw err;
        });


      } catch (err) {
        console.log();
        (async () => {
          let buttons = ['Yes', 'No'];
          let choice = await vscode.window.showErrorMessage(`Invalid toolcahin archive!\nDo you want to delete this file?`, ...buttons);
          if (choice === buttons[0]) {
            fs.rm(tmpFilePath.fsPath, () => {
            });
          }
        })();
        isTerminated = true;
      }

    }

    token.onCancellationRequested(() => {
      //console.log("User canceled the long running operation");
      request.destroy();
    });



    let prevPer = 0;
    while (!isTerminated) {
      await new Promise(f => setTimeout(f, 100));
      totalSize = totalSize ? totalSize : 1;
      const inPerc = Math.round(((currentSize)) * 100 / totalSize);
      let inc = inPerc - prevPer;
      prevPer = inPerc;
      const currentSizeInMb = Math.round((currentSize / 1024) / 1024);
      const totalSizeInMb = Math.round((totalSize / 1024) / 1024);
      console.log("[" + currentSizeInMb + "/" + totalSizeInMb + " Mbytes]", inPerc);
      progress.report({ message: "[" + currentSizeInMb + "/" + totalSizeInMb + " Mbytes]", increment: inc });

      if (token.isCancellationRequested) {
        return false;
      }

    }

    result = await result0;

    return;
  });

  //console.log("Alarm");

  if (result == false && !isExist && fs.existsSync(tmpFilePath.fsPath)) {  // ( ( await isFileAtUri(tmpFilePath) ) ) ) {
    fs.rm(tmpFilePath.fsPath, () => {
    });
  }



  if (result) {
    const toolchainInfoFile = vscode.Uri.joinPath(toolchainDirPath, ".eec", "toolchain.json");
    const json = JSON.stringify(toolchainInfo).toString();
    fs.writeFileSync(toolchainInfoFile.fsPath, json, { flag: "w" });
    //}
    const toolchainTmpInfoFile = vscode.Uri.joinPath(
      vscode.Uri.file(homeDir),
      ".eec-tmp", `ToolchainInfo.${toolchainInfo.file}.json`
    );
    fs.copyFileSync(toolchainInfoFile.fsPath, toolchainTmpInfoFile.fsPath);

    await setCurrentToolchain(config, toolchainInfo);
  }

  return result;
}

type TargetPeriphInfo = {
  aoCount: number;
  relayCount: number;
  uartCount: number;
  uiCount: number;
  flashSize: number;
  ramSize: number;
  flashPageSize: number;
  isDesktop: boolean;
  isResourcesInternal: boolean;
}

export type TargetInfoOld = {
  description: string;
  devManId: number;
  devName: string;
  frameWorkVerA: number;
  frameWorkVerB: number;
  triplet: string;
  pathToFile: string;
  stdlib: string;
  runtime: string;
  stdlibs: string[];
  includePaths: string[];
  periphInfo: TargetPeriphInfo;
}

export type TargetInfo = {
  description: string;
  devManId: number;
  devName: string;
  frameWorkVerA: number;
  frameWorkVerB: number;
  frameworkSize: number;
  periphInfo: TargetPeriphInfo;
  triplet: string;
  pathToFile: string;
  stdlibPath: string;
  stdlibUrl: string;
  linkArgs: string[];
  isAlfSupport: boolean;
}

export const targetInfoDefaultValue: TargetInfo = {
  description: "[Device]",
  devManId: -1,
  devName: "Select Target",
  frameWorkVerA: 0,
  frameWorkVerB: 0,
  frameworkSize: 0,
  triplet: "thumbv7m-none-none-eabi",
  pathToFile: "",
  periphInfo: {
    aoCount: 0,
    relayCount: 0,
    uartCount: 0,
    uiCount: 0,
    flashSize: 0,
    ramSize: 0,
    flashPageSize: 256,
    isDesktop: false,
    isResourcesInternal: false
  },
  stdlibPath: "lib/arm-none-eabi/picolibc/arm-none-eabi/lib/release/thumb/v7-m/nofp",
  stdlibUrl: "https://getfile.dokpub.com/yandex/get/https://disk.yandex.ru/d/TxwaYTSgJD-9cw",
  linkArgs: [
    "ld.lld",
    "@out_obj",
    "-L",
    "${eec_path}/lib/arm-none-eabi/picolibc/arm-none-eabi/lib/release/thumb/v7-m/nofp",
    "-nostdlib",
    "-lc",
    "-lm",
    "-L",
    "${eec_path}/lib/clang_rt",
    "-lclang_rt.builtins-armv7m",
    "--format=elf",
    "@out_link_map",
    "@in_link_map",
    "-o",
    "@out_exe"
  ],
  isAlfSupport: true
};


function resolveTargetInfo(config: Config, targetInfo: TargetInfo) {

  if (targetInfo.linkArgs !== undefined) {
    return;
  }

  targetInfo.stdlibPath = targetInfoDefaultValue.stdlibPath;
  targetInfo.stdlibUrl = targetInfoDefaultValue.stdlibUrl;
  targetInfo.linkArgs = targetInfoDefaultValue.linkArgs;
  targetInfo.isAlfSupport = targetInfoDefaultValue.isAlfSupport;

}


export async function getTargets(config: Config): Promise<TargetInfo[]> {

  let targetsInfo: Array<TargetInfo> = [];

  const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
  const targetsDir = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir), ".eec", "targets");

  await vscode.workspace.fs.readDirectory(targetsDir).then(async (files: [string, vscode.FileType][]) => {

    for (let element of files) {

      console.log("file: ", element[0]);

      if (element[1] != vscode.FileType.Directory) {
        //console.log("is not dir");
        continue;
      }

      const targetInfoFile = vscode.Uri.joinPath(targetsDir, element[0], "targetInfo.json");
      const isExist = await isFileAtUri(targetInfoFile);

      if (!isExist) {
        continue;
      }

      const raw = fs.readFileSync(targetInfoFile.fsPath).toString();
      let targetInfo = JSON.parse(raw) as TargetInfo;
      targetInfo.pathToFile = targetInfoFile.fsPath;
      resolveTargetInfo(config, targetInfo);
      targetsInfo.push(targetInfo);
    }

  }, () => {
    console.log("can't find toolchain dir");
  });


  return targetsInfo;
}



export async function checkAndSetCurrentTarget(config: Config, sbSelectTargetDev: vscode.StatusBarItem) {

  const cfgTarget = config.get<TargetInfo>('target.device');

  const targets = await getTargets(config);
  let sTarget = targetInfoDefaultValue;

  if (cfgTarget != undefined && cfgTarget.pathToFile !== undefined) {
    for (const target of targets) {
      if (target.pathToFile == cfgTarget.pathToFile) {
        sTarget = cfgTarget;
        break;
      }
    }
  }

  //sbSelectTargetDev.text = `$(chip)[${sTarget.devName}]`;
  await setCurrentTarget(sTarget, config, sbSelectTargetDev);

  resolveTarget(config);
}



export async function setCurrentTarget(target: TargetInfo, config: Config, sbSelectTargetDev: vscode.StatusBarItem) {
  resolveTargetInfo(config, target);
  config.targetDevice = target;

  let platformIcon = '$(device-mobile)';
  if (target.periphInfo.isDesktop) {
    if (target.devName.indexOf('windows') != -1) {
      platformIcon = '$(terminal-powershell)'
    } else if (target.devName.indexOf('linux') != -1) {
      platformIcon = '$(terminal-linux)'
    }
  }
  sbSelectTargetDev.text = `${platformIcon}[${target.devName}]`;

  await config.set("target.device", target);
}


export async function checkAndSetCurrentToolchain(config: Config, sbSelectToolchain: vscode.StatusBarItem) {

  const result = await checkToolchain(config, true, false);
  const currentToolchain = result ? config.currentToolchain : undefined;

  if (currentToolchain !== undefined && currentToolchain.label !== undefined) {
    sbSelectToolchain.text = `$(extensions)`;
    sbSelectToolchain.tooltip = `Toolchain: ${currentToolchain.label}`;
    if (config.latestToolchain != undefined && config.latestToolchain.ver != currentToolchain.ver) {
      sbSelectToolchain.tooltip += "(old version)";
    }

    await setCurrentToolchain(config, currentToolchain);
    return true;
  }

  sbSelectToolchain.text = "Not installed!";
  sbSelectToolchain.tooltip = "Select toolchain";
  await config.setGlobal('toolchain.version', undefined);

  return false;
}


async function setCurrentToolchain(config: Config, toolchainInfo: ToolchainInfo) {
  config.currentToolchain = toolchainInfo;
  const currentVer = getVerToInt(toolchainInfo.ver);
  config.isOldToolchain = currentVer < getVerToInt('0.9.0');
  config.isInternalLinker = currentVer >= getVerToInt('0.9.25');

  await config.setGlobal("toolchain.version", config.currentToolchain);
}


function getVerToInt(str: string): number {
  let nums = str.split('.', 3);
  return (parseInt(nums[0]) << 16) | (parseInt(nums[1]) << 8) | (parseInt(nums[2]));
}


async function getLastToolchainInfo(config: Config): Promise<ToolchainInfo | undefined> {

  let lastToolchain: ToolchainInfo | undefined = undefined;

  const response = await fetch(`https://github.com/Retrograd-Studios/eemblangtoolchain/raw/master/toolchain_${config.hostTriplet}.json`).catch((e) => {
    console.log(e);
    return undefined;
  });

  if (response === undefined) {
    return undefined;
  }

  const data = await response.json() as ToolchainsFile;

  for (var toolchainInfo of data.toolchains) {
    // if ( lastToolchain == undefined ) {
    //   lastToolchain = toolchainInfo;
    //   continue;
    // }
    if (lastToolchain == undefined || getVerToInt(toolchainInfo.ver) > getVerToInt(lastToolchain.ver)) {
      lastToolchain = toolchainInfo;
    }
  }

  config.latestToolchain = lastToolchain;

  return lastToolchain;
}


export async function getToolchains(config: Config): Promise<ToolchainInfo[] | undefined> {

  let lastToolchain: ToolchainInfo | undefined = undefined;

  const response = await fetch(`https://github.com/Retrograd-Studios/eemblangtoolchain/raw/master/toolchain_${config.hostTriplet}.json`).catch((e) => {
    console.log(e);
    return undefined;
  });

  if (response === undefined) {
    return undefined;
  }

  const data = await response.json() as ToolchainsFile;

  for (var toolchainInfo of data.toolchains) {
    if (lastToolchain == undefined || getVerToInt(toolchainInfo.ver) > getVerToInt(lastToolchain.ver)) {
      lastToolchain = toolchainInfo;
    }
  }

  if (lastToolchain == undefined) {
    return undefined;
  }

  const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
  const verFile = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir), ".eec", "toolchain.json");

  const isLocal = (await isFileAtUri(verFile));
  if (isLocal) {
    const raw = fs.readFileSync(verFile.fsPath).toString();
    const currentVer = JSON.parse(raw);
  }

  return data.toolchains;

}


export async function IsToolchainInstalled(config: Config): Promise<boolean> {

  if (await checkToolchain(config, false, true)) {
    return true;
  }

  await vscode.window.showErrorMessage(`EEPL Compiler is not installed! Can't find toolchain`, { modal: true });
  return false;
}


async function checkToolchain(config: Config, isCheckLatest: boolean, isSyncCheckLatest: boolean): Promise<boolean> {

  const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
  const verFile = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir), ".eec", "toolchain.json");

  const toolchainFile = await isFileAtUri(verFile);

  if (!toolchainFile) {
    config.currentToolchain = undefined;

    let buttons = ['Install', 'Not now'];
    let choice = await vscode.window.showWarningMessage(`EEPL Toolchain is not installed!\nDo you want Download and Install now?`, { modal: true }, ...buttons);
    if (choice === buttons[0]) {
      const toolchainInfo = await getLastToolchainInfo(config);
      let res = toolchainInfo != undefined ? await installToolchain(config, toolchainInfo) : false;
      if (!res) {
        vscode.window.showErrorMessage(`Error: EEmbLang Toolchain is not installed!\nCan't download file`);
      }
      return res;
    }
    return false;
  }

  if (config.currentToolchain === undefined) {
    const raw = fs.readFileSync(verFile.fsPath).toString();
    config.currentToolchain = JSON.parse(raw) as ToolchainInfo;
  }

  if (!isCheckLatest || config.latestToolchain !== undefined) {
    return true;
  }

  const checkLatestToolchain = async () => {
    const lastToolchain = await getLastToolchainInfo(config);

    if (config.currentToolchain === undefined) {
      return false;
    }

    if (lastToolchain === undefined) {
      return true;
    }

    if (getVerToInt(config.currentToolchain.ver) >= getVerToInt(lastToolchain.ver)) {
      return true;
    }

    let buttons = ['Install', 'Not now'];
    let choice = await vscode.window.showInformationMessage(`New  EEPL Toolchain (v${lastToolchain.ver}) is available!\nDo you want Download and Install now?`, ...buttons);
    if (choice === buttons[0]) {
      const res = await installToolchain(config, lastToolchain);
      return res;
    }

    return true;
  };

  if (isSyncCheckLatest) {
    return await checkLatestToolchain();
  } else {
    config.toolchainInstallerResult = checkLatestToolchain();
  }

  return true;
}

// export async function getCurrentToolchain(): Promise<ToolchainInfo | undefined> {

//   const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();

//   const verFile = vscode.Uri.joinPath(
//     vscode.Uri.file(homeDir), ".eec", "toolchain.json");

//   const toolchainFile = await isFileAtUri(verFile);

//   if (!toolchainFile) {
//     return undefined;
//   }

//   const raw = fs.readFileSync(verFile.fsPath).toString();

//   const currentToolchain: ToolchainInfo = JSON.parse(raw);

//   return currentToolchain;

// }


async function resolveStdLibs(config: Config): Promise<boolean> {

  let homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
  const stdlibPath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir),
    ".eec",
    config.targetDevice.stdlibPath
  );

  if (await isDirAtUri(stdlibPath)) {
    return true;
  }

  let buttons = ['Install', 'Not now'];
  let choice = await vscode.window.showWarningMessage(
    `STD Libs for triplet '${config.targetDevice.triplet}' is not installed!
Do you want Download and Install now?`, { modal: true }, ...buttons);

  if (choice === buttons[1]) {
    return false;
  }

  return installStdLibs(config, config.targetDevice);
}


export async function resolveTarget(config: Config): Promise<boolean> {

  let workspaceTarget: vscode.WorkspaceFolder | undefined = undefined;

  for (const workspaceTarget0 of vscode.workspace.workspaceFolders || []) {
    workspaceTarget = workspaceTarget0;
    break;
  }

  if (config.targetDevice.devManId === targetInfoDefaultValue.devManId) {
    await vscode.commands.executeCommand('eepl.command.setTargetDevice');
    if (config.targetDevice.devManId === targetInfoDefaultValue.devManId) {
      return false;
    }
  }

  if (!await resolveStdLibs(config)) {
    return false;
  }

  const devName = config.targetDevice.devName;

  const isOldToolchain = config.isOldToolchain;

  const outputPath = isOldToolchain ? `${workspaceTarget!.uri.fsPath}/out/${devName}/output` : `${workspaceTarget!.uri.fsPath}/out/${devName}`;

  let productName = 'output';
  let productPath = `${outputPath}`;

  if (!isOldToolchain) {

    if (config.isInternalLinker) {

      const packageInfoPath = `${workspaceTarget!.uri.fsPath}/PackageInfo.es`;
      if (fs.existsSync(packageInfoPath)) {

        const rowFile = fs.readFileSync(packageInfoPath).toString();

        const regex = /\s*(BuildApp|BuildLib)\s*\(\s*(\S+)\s*\)/;
        const dateString = rowFile;

        const match = dateString.match(regex);
        if (match) {
          productName = match[2];
        } else {
          productName = "main";
        }

      } else {
        productName = "main";
      }

      productPath = `${productPath}/${productName}`;

    } else {
      const compilerOutputPath = `${outputPath}/.eec_cache/EECompilerOutput.json`;

      if (fs.existsSync(compilerOutputPath)) {

        const rowFile = fs.readFileSync(compilerOutputPath).toString();
        const eecOutput: EECompilerOutput = JSON.parse(rowFile);

        productName = eecOutput.productName;
        productPath = `${productPath}/${productName}`;

      } else {
        productPath = `${productPath}/output`;
      }
    }
  }

  if (isOldToolchain) {
    const cwd = "${cwd}";
    config.uploadingFilePath = `${cwd}/out/${devName}/prog.alf`;
    config.exePath = `${cwd}/out/${devName}/output.elf`;
    config.productPath = `${productPath}/output`;
    config.productName = productName;
  } else {

    config.uploadingFilePath = `${productPath}.alf`;
    config.productPath = `${productPath}`;
    config.productName = productName;


    if (config.targetDevice.devName.indexOf("windows") != -1) {

      config.exePath = `${productPath}.exe`;


    } else {

      config.exePath = `${productPath}.elf`;
    }

  }

  if (config.isInternalLinker) {
    return true;
  }

  const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
  const eecPath = vscode.Uri.joinPath(
    vscode.Uri.file(homeDir), ".eec");

  config.targetDevice.linkArgs = [
    `${config.productPath}.o`,
    "-L",
    `${eecPath.fsPath}/lib/arm-none-eabi/picolibc/arm-none-eabi/lib/release/thumb/v7-m/nofp`,
    "-nostdlib",
    "-lc",
    "-lm",
    "-L",
    `${eecPath.fsPath}/lib/clang_rt`,
    "-lclang_rt.builtins-armv7m",
    "--format=elf",
    `--Map=${config.productPath}.map`,
    `${eecPath.fsPath}/targets/${devName}/target_out.ld`,
    "-o",
    config.exePath
  ];

  return true;
}





/** Mirrors `toolchain::get_path_for_executable()` implementation */
export const getPathForExecutable = memoizeAsync(
  // We apply caching to decrease file-system interactions
  async (executableName: "eec" | "EEcompiler" | "easy" | "st-util" | "ld.lld" | "ebuild" | "eflash" | "arm-none-eabi-gdb" | "egdb_server"): Promise<string> => {
    {
      const envVar = process.env[executableName.toUpperCase()];
      if (envVar) return envVar;
    }

    if (await lookupInPath(executableName)) return executableName;

    const homeDir = os.type() === "Windows_NT" ? os.homedir() : os.homedir();
    const eecPath = vscode.Uri.joinPath(
      vscode.Uri.file(homeDir),
      ".eec",
      "bin",
      os.type() === "Windows_NT" ? `${executableName}.exe` : executableName
    );
    const armToolchainPath = vscode.Uri.joinPath(
      vscode.Uri.file(homeDir),
      ".eec",
      "arm-toolchain",
      os.type() === "Windows_NT" ? `${executableName}.exe` : executableName
    );

    try {
      if (await isFileAtUri(eecPath)) return eecPath.fsPath;
    } catch (err) {
      log.error("Failed to read the fs info", err);
      return "notFound";
    }

    try {
      if (await isFileAtUri(armToolchainPath)) return armToolchainPath.fsPath;
    } catch (err) {
      log.error("Failed to read the fs info", err);
      return "notFound";
    }

    return "notFound";

  }
);

async function lookupInPath(exec: string): Promise<boolean> {
  const paths = process.env.PATH ?? "";

  console.log(os.type());

  const candidates = paths.split(path.delimiter).flatMap((dirInPath) => {
    const candidate = path.join(dirInPath, exec);
    return os.type() === "Windows_NT" ? [candidate, `${candidate}.exe`] : [candidate];
  });

  for await (const isFile of candidates.map(isFileAtPath)) {
    if (isFile) {
      return true;
    }
  }
  return false;
}

export async function isFileAtPath(path: string): Promise<boolean> {
  return isFileAtUri(vscode.Uri.file(path));
}

export async function isFileAtUri(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

export async function isDirAtUri(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}