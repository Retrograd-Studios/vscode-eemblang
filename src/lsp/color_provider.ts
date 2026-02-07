import * as vscode from 'vscode';


export class EEPLColorProvider implements vscode.DocumentColorProvider {

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
