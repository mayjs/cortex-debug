
import * as vscode from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';

export interface RTOSStackInfo {
    stackStart: number;
    stackTop: number;
    stackEnd?: number;
    stackSize?: number;
    stackUsed?: number;
    stackFree?: number;
    stackPeak?: number;
    bytes?: Uint8Array;
}

export interface DisplayItem {
    width: number;
    headerRow1: string;
    headerRow2: string;
    fieldName?: string;
}
export interface FreeRTOSThreadInfo {
    display: {[key: string]: string};       // Each key is the string of the enum value
    stackInfo: RTOSStackInfo;
}

export abstract class RTOSBase {
    public progStatus: 'started' | 'stopped' | 'running' | 'exited';
    public status: 'failed' | 'initialized' | 'none';
    protected exprValues: Map<string, RTOSVarHelper> = new Map<string, RTOSVarHelper>();
    protected failedWhy: any;   // For debug

    protected constructor(public session: vscode.DebugSession, public readonly name) {
        this.status = 'none';
        this.progStatus = 'started';
    }

    //
    // When the promise resolves, check the 'status' property which starts out as 'none'
    // 1. status set to 'initialized' to indicate RTOS has been detected
    // 2. Could not detect an RTOS because session is busy (caller to try again). Status is unmodified. This may
    //    happen because user did a continue or a step
    // 3. Failed to detect an RTOS in which case, status is 'failed' and the host should no longer try use this instance.
    //
    public abstract tryDetect(useFrameId: number): Promise<RTOSBase>;

    public onStopped(frameId: number): Promise<void> {
        this.progStatus = 'stopped';
        return this.refresh(frameId);
    }

    public onContinued(): void {
        this.progStatus = 'running';
    }

    public onExited(): void {
        this.progStatus = 'exited';
    }

    // Refresh the RTOS structures
    public abstract refresh(frameId: number): Promise<void>;

    // Return a string that represents the RTOS state. Ideally, it should return a grid/table that is
    // hosted in an upper level structure
    public abstract getHTML(): string;

    // UTILITY functions for all RTOSes
    protected async evalForVarRef(
        prevValue: number, useFrameId: number, expr: string, optional?: boolean): Promise<number | undefined> {
        if (prevValue !== undefined) {
            return prevValue;
        } else if (this.progStatus !== 'stopped') {
            return undefined;
        }
        const arg: DebugProtocol.EvaluateArguments = {
            frameId: useFrameId,
            expression: expr,
            context: 'hover'
        };
        try {
            const result = await this.session.customRequest('evaluate', arg);
            if (!result || (!optional && (result.variablesReference === 0))) {
                throw new Error(`Failed to evaluate ${expr}`);
            }
            return result ? result.variablesReference : 0;
        }
        catch (e) {
            throw e;
        }
    }

    protected async evalForVarValue(
        useFrameId: number, expr: string): Promise<string | undefined> {
        const arg: DebugProtocol.EvaluateArguments = {
            frameId: useFrameId,
            expression: expr,
            context: 'hover'
        };
        try {
            const result = await this.session.customRequest('evaluate', arg);
            const ret = result?.result;
            return ret;
        }
        catch (e) {
            throw e;
        }
    }

    protected getVarChildren(varRef: number, dbg: string): Promise<DebugProtocol.Variable[]> {
        return new Promise<DebugProtocol.Variable[]> ((resolve, reject) => {
            if (this.progStatus !== 'stopped') {
                return reject(new Error(`busy, failed to evaluate ${dbg}`));
            } else {
                const arg: DebugProtocol.VariablesArguments = {
                    variablesReference: varRef
                };
                this.session.customRequest('variables', arg).then((result: any) => {
                    if (!result || !result.variables || !result.variables.length) {
                        reject(Error(`Failed to evaluate variable ${arg.variablesReference} ${dbg}`));
                    } else {
                        resolve(result.variables);
                    }
                }, (e) => {
                    reject(e);
                });
            }
        });
    }

    protected getVarChildrenObj(varRef: number, dbg: string): Promise<object> {
        return new Promise<object>((resolve, reject) => {
            if ((varRef === undefined) || (varRef === 0)) {
                resolve(null);
                return;
            }
            this.getVarChildren(varRef, dbg).then((vars) => {
                const obj = RTOSVarHelper.varsToObj(vars);
                resolve(obj);
            }, (e) => {
                reject(e);
            });
        });
    }

    //
    // It will return (or throw)
    // * The previous value if was already defined or session is busy. If session was busy, you can try again
    // * If 'expr' is evaluated and a value found, then return an instance of `RTOSVarHelper`
    // * If 'expr' is evaluated and but a value NOT found, then (should not attempt re-tries)
    //   * If optional, return null
    //   * If not optional, Throws an exception
    //
    protected async getVarIfEmpty(prev: RTOSVarHelper, fId: number, expr: string, opt?: boolean): Promise<RTOSVarHelper> {
        try {
            if ((prev !== undefined) || (this.progStatus !== 'stopped')) {
                return prev;
            }
            const tmp = new RTOSVarHelper(expr, this);
            await tmp.tryInitOrUpdate(fId);
            if (isNullOrUndefined(tmp.value)) {
                if (!opt) {
                    throw Error(`${expr} not found`);
                }
                return null;
            }
            return tmp;
        }
        catch (e) {
            throw e;
        }
    }

    protected async getExprVal(expr: string, frameId: number): Promise<string> {
        let exprVar = this.exprValues.get(expr);
        if (!exprVar) {
            exprVar = new RTOSVarHelper(expr, this);
        }
        return exprVar.getValue(frameId);
    }

    protected async getExprValChildren(expr: string, frameId: number): Promise<DebugProtocol.Variable[]> {
        let exprVar = this.exprValues.get(expr);
        if (!exprVar) {
            exprVar = new RTOSVarHelper(expr, this);
        }
        return exprVar.getVarChildren(frameId);
    }

    protected getExprValChildrenObj(expr: string, frameId: number): Promise<object> {
        return new Promise<object>(async (resolve, reject) => {
            try {
                const vars = await this.getExprValChildren(expr, frameId);
                const obj = RTOSVarHelper.varsToObj(vars);
                resolve(obj);
            }
            catch (e) {
                resolve(e);
            }
        });
    }

    // If there is a column named 'Status' and if it is set to 'RUNNING', that row becomes special
    protected getHTMLCommon(
        displayFidldNames: string[],
        RTOSDisplayItems: {[key: string]: DisplayItem},
        allThreads: FreeRTOSThreadInfo[],
        timeInfo: string): string {
        const colFormat = displayFidldNames.map((key) => `${RTOSDisplayItems[key].width}fr`).join(' ');
        let table = `<vscode-data-grid class="${this.name}-grid threads-grid" grid-template-columns="${colFormat}">\n`;
        let header = '';
        for (const thr of allThreads) {
            const th = thr.display;
            if (!header) {
                let col = 1;
                let have2ndRow = false;
                const commonHeaderRowPart = '  <vscode-data-grid-row row-type="header" class="threads-header-row">\n';
                const commonHeaderCellPart = '    <vscode-data-grid-cell cell-type="columnheader" class="threads-header-cell" grid-column=';
                if (true) {
                    header = commonHeaderRowPart;
                    for (const key of displayFidldNames) {
                        const txt = RTOSDisplayItems[key].headerRow1;
                        header += `${commonHeaderCellPart}"${col}">${txt}</vscode-data-grid-cell>\n`;
                        if (!have2ndRow) { have2ndRow = !!RTOSDisplayItems[key].headerRow2; }
                        col++;
                    }
                    header += '  </vscode-data-grid-row>\n';
                }

                if (have2ndRow) {
                    col = 1;
                    header += commonHeaderRowPart;
                    for (const key of displayFidldNames) {
                        const txt = RTOSDisplayItems[key].headerRow2;
                        header += `${commonHeaderCellPart}"${col}">${txt}</vscode-data-grid-cell>\n`;
                        col++;
                    }
                    header += '  </vscode-data-grid-row>\n';
                }
                table += header;
            }

            let col = 1;
            const running = (th['Status'] === 'RUNNING') ? 'running' : '';
            table += `  <vscode-data-grid-row class="${this.name}-row threads-row">\n`;
            for (const key of displayFidldNames) {
                const v = th[key];
                let txt = v;
                const lKey = key.toLowerCase();
                if (key === 'StackStart') {
                    txt = `<vscode-link class="threads-link-${lKey}" href="#">${v}</vscode-link>`;
                }
                const cls = `class="${this.name}-cell threads-cell threads-cell-${lKey} ${running}"`;
                table += `    <vscode-data-grid-cell ${cls} grid-column="${col}">${txt}</vscode-data-grid-cell>\n`;
                col++;
            }
            table += '  </vscode-data-grid-row>\n';
        }

        let ret = table;
        ret += '</vscode-data-grid>\n';
        if (timeInfo) {
            ret += `<p>Data collected at ${timeInfo}</p>\n`;
        }

        return ret;
    }
}

export class RTOSVarHelper {
    public varReference: number;
    public value: string;
    
    constructor(public expression: string, public rtos: RTOSBase) {
    }

    public static varsToObj(vars: DebugProtocol.Variable[]) {
        const obj = {};
        for (const v of vars) {
            obj[v.name + '-val'] = v.value;
            obj[v.name + '-ref'] = v.variablesReference;
            obj[v.name + '-exp'] = v.evaluateName;
        }
        return obj;
    }

    public async tryInitOrUpdate(useFrameId: number): Promise<boolean> {
        try {
            if (this.rtos.progStatus !== 'stopped') {
                return false;
            }
            const arg: DebugProtocol.EvaluateArguments = {
                frameId: useFrameId,
                expression: this.expression,
                context: 'hover'
            };
            this.value = undefined;
            const result = await this.rtos.session.customRequest('evaluate', arg);
            this.value = result?.result;
            this.varReference = result?.variablesReference;
            return true;
        }
        catch (e) {
            return false;
        }
    }

    public getValue(frameId: number): Promise<string> {
        return new Promise<string | undefined> (async (resolve, reject) => {
            if (this.rtos.progStatus !== 'stopped') {
                return reject(new Error(`busy, failed on ${this.expression}`));
            } else {
                this.tryInitOrUpdate(frameId).then((res) => {
                    if (!res) {
                        reject(new Error('failed to initialize/update'));
                    } else {
                        resolve(this.value);
                    }
                }, (e) => {
                    reject(e);
                });
            }
        });
    }

    public getVarChildren(frameId: number): Promise<DebugProtocol.Variable[]> {
        return new Promise<DebugProtocol.Variable[]> ((resolve, reject) => {
            if (this.rtos.progStatus !== 'stopped') {
                return reject(new Error(`busy, failed on ${this.expression}`));
            } else {
                this.getValue(frameId).then((str) => {
                    if (!this.varReference || !str) {
                        reject(Error(`Failed to get variable reference for ${this.expression}`));
                        return;
                    }
                    const arg: DebugProtocol.VariablesArguments = {
                        variablesReference: this.varReference
                    };
                    this.rtos.session.customRequest('variables', arg).then((result: any) => {
                        if (!result || !result.variables || !result.variables.length) {
                            reject(Error(`Failed to evaluate variable ${this.expression} ${arg.variablesReference}`));
                        } else {
                            resolve(result.variables);
                        }
                    }, (e) => {
                        reject(e);
                    });
                }, (e) => {
                    reject(e);
                });
            }
        });
    }

    public getVarChildrenObj(useFrameId: number): Promise<object> {
        return new Promise<object> ((resolve, reject) => {
            this.getVarChildren(useFrameId).then((vars) => {
                const obj = RTOSVarHelper.varsToObj(vars);
                resolve(obj);
            }, (e) => {
                reject(e);
            });
        });
    }
}

function isNullOrUndefined(x) {
    return (x === undefined) || (x === null);
}
