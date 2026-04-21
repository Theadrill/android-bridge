const vscode = require('vscode');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { windowManager } = require('node-window-manager');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');

// Configura o nut-js para ser instantâneo (sem delay entre teclas)
keyboard.config.autoDelayMs = 0;

let wss;
let httpServer;
let outputChannel;
let history = [];
const historyPath = path.join(__dirname, 'history.json');
const exclusionsPath = path.join(__dirname, 'exclusions.json');

let WINDOW_EXCLUSION_LIST = [];
let psDaemon;
let pendingWindowsRequests = [];
let windowsBuffer = "";

function loadExclusions() {
    try {
        if (fs.existsSync(exclusionsPath)) {
            const data = fs.readFileSync(exclusionsPath, 'utf8');
            WINDOW_EXCLUSION_LIST = JSON.parse(data);
        }
    } catch (e) {
        if (outputChannel) outputChannel.appendLine(`Erro ao carregar exclusões: ${e.message}`);
    }
}


function loadHistory() {
    try {
        if (fs.existsSync(historyPath)) {
            const data = fs.readFileSync(historyPath, 'utf8');
            history = JSON.parse(data);
            // Garante que o histórico esteja sempre ordenado: mais antigo primeiro
            history.sort((a, b) => a.id - b.id);
        }
    } catch (e) {
        history = [];
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    } catch (e) {
        outputChannel.appendLine(`Erro ao salvar histórico: ${e.message}`);
    }
}

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Android Bridge");
    outputChannel.appendLine("Android Bridge: Modo Combine-and-Send Ativado");
    
    // Setup do State Manager Daemon em Background para Alt-Tab Instantâneo
    const psDaemonPath = path.join(os.tmpdir(), "antigravity_daemon.ps1");
    const daemonScript = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinAPI {
    public delegate bool EnumWindowsProc(IntPtr hWnd, int lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumFunc, int lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", ExactSpelling = true)] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hWnd);

    public static List<string> GetWindows() {
        List<string> result = new List<string>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int cloakedVal = 0;
            DwmGetWindowAttribute(hWnd, 14, out cloakedVal, sizeof(int));
            if (cloakedVal != 0) return true;
            IntPtr root = GetAncestor(hWnd, 3);
            if (GetLastActivePopup(root) != hWnd) return true;
            StringBuilder title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);
            if (title.Length == 0 || title.ToString() == "Program Manager") return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            result.Add(processId + "|||" + title.ToString().Replace("\\r", "").Replace("\\n", ""));
            return true;
        }, 0);
        return result;
    }
}
"@

while ($true) {
    $inputLine = [Console]::ReadLine()
    if ($inputLine -eq "EXIT") { break }
    if ($inputLine -match "GET") {
        $windows = [WinAPI]::GetWindows()
        foreach ($w in $windows) { 
            [Console]::WriteLine($w) 
        }
        [Console]::WriteLine("===END_WINDOWS===")
    }
}
`;
    fs.writeFileSync(psDaemonPath, daemonScript);
    const { spawn } = require('child_process');
    psDaemon = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', psDaemonPath]);
    
    psDaemon.stdout.on('data', (data) => {
        windowsBuffer += data.toString();
        if (windowsBuffer.includes('===END_WINDOWS===')) {
            const parts = windowsBuffer.split('===END_WINDOWS===');
            const completeData = parts[0];
            windowsBuffer = parts.slice(1).join('===END_WINDOWS===').replace(/^\r?\n/, '');
            
            const lines = completeData.split('\n');
            if (pendingWindowsRequests.length > 0) {
                const resolver = pendingWindowsRequests.shift();
                resolver(lines);
            }
        }
    });
    
    psDaemon.on('error', (err) => {
        outputChannel.appendLine("PS Daemon Error: " + err.message);
    });

    function getWindowsFromDaemon() {
        return new Promise((resolve) => {
            pendingWindowsRequests.push(resolve);
            psDaemon.stdin.write("GET\r\n");
        });
    }

    // Lógica de Foco Automático no Startup (para o Extension Development Host)
    setTimeout(() => {
        try {
            const allWindows = windowManager.getWindows();
            const devWindow = allWindows.find(w => w.getTitle().includes("Extension Development Host"));
            if (devWindow) {
                outputChannel.appendLine(`🎯 Janela de Desenvolvimento detectada! Focando...`);
                devWindow.bringToTop();
            }
        } catch (e) {
            outputChannel.appendLine(`⚠️ Erro ao tentar focar janela de dev: ${e.message}`);
        }
    }, 1500);
    
    loadHistory();
    loadExclusions();
    
    const port = 4500;
    const networkInterfaces = os.networkInterfaces();
    let localIp = '127.0.0.1';

    for (const name in networkInterfaces) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address; break;
            }
        }
    }

    httpServer = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getWebpageContent(localIp, port));
        } else { res.writeHead(404); res.end(); }
    });
    
    httpServer.listen(port, '0.0.0.0');

    wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws) => {
        outputChannel.appendLine("📱 Celular conectado!");
        
        // Envia o histórico inicial para o cliente
        ws.send(JSON.stringify({ type: 'HISTORY', payload: history }));
        ws.on('message', async (message) => {
            let data;
            try { 
                data = JSON.parse(message.toString()); 
            } catch(e) { 
                data = { type: 'LEGACY', msg: message.toString() }; 
            }

            // Handshake de Reconexão
            if (data.type === 'HELLO') {
                if (data.reconnected) {
                    outputChannel.appendLine("🔄 Cliente antigo detectado, forçando refresh controlado...");
                    ws.send(JSON.stringify({ type: 'COMMAND', action: 'REFRESH' }));
                } else {
                    outputChannel.appendLine("✨ Nova sessão iniciada no celular.");
                }
                return;
            }
            
            try {
                // Tratamento de Simulação de Teclado (Novos Botões)
                if (data.type === 'KEY_SIM') {
                    let actionLabel = '';
                    
                    if (data.action === 'COPY') {
                        await keyboard.pressKey(Key.LeftControl, Key.C);
                        await keyboard.releaseKey(Key.LeftControl, Key.C);
                        actionLabel = 'Copiar (Global)';
                    }
                    else if (data.action === 'PASTE') {
                        await keyboard.pressKey(Key.LeftControl, Key.V);
                        await keyboard.releaseKey(Key.LeftControl, Key.V);
                        actionLabel = 'Colar (Global)';
                    }
                    else if (data.action === 'ENTER') {
                        await keyboard.pressKey(Key.LeftShift, Key.Enter);
                        await keyboard.releaseKey(Key.LeftShift, Key.Enter);
                        actionLabel = 'Enter (Shift+Enter)';
                    }
                    else if (data.action === 'BACKSPACE') {
                        await keyboard.type(Key.Backspace);
                        actionLabel = 'Backspace';
                    }
                    else if (data.action === 'SAVE') {
                        await keyboard.pressKey(Key.LeftControl, Key.S);
                        await keyboard.releaseKey(Key.LeftControl, Key.S);
                        actionLabel = 'Salvar (Ctrl+S)';
                    }
                    else if (data.action === 'RESTART_PROJECT') {
                        outputChannel.appendLine(`🚀 Reiniciando Projeto (npm start)...`);
                        await keyboard.pressKey(Key.LeftControl, Key.C);
                        await keyboard.releaseKey(Key.LeftControl, Key.C);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        await keyboard.type("npm start");
                        await keyboard.type(Key.Enter);
                        vscode.window.setStatusBarMessage(`✅ npm start enviado`, 3000);
                        return;
                    }
                    else if (data.action === 'REFRESH_F5') {
                        await keyboard.type(Key.F5);
                        actionLabel = 'Refresh (F5)';
                    }
                    else if (data.action === 'RESTART_EXT') {
                        outputChannel.appendLine(`🔄 Reiniciando Extensão (Debug)...`);
                        try {
                            const allWindows = windowManager.getWindows();
                            const mainWindow = allWindows.find(w => 
                                (w.getTitle().includes("android-bridge") || w.getTitle().includes("Visual Studio Code")) && 
                                !w.getTitle().includes("Extension Development Host")
                            );
                            
                            if (mainWindow) {
                                mainWindow.bringToTop();
                                setTimeout(async () => {
                                    await keyboard.pressKey(Key.LeftControl, Key.LeftShift, Key.F5);
                                    await keyboard.releaseKey(Key.LeftControl, Key.LeftShift, Key.F5);
                                }, 500);
                            }
                        } catch (err) {}
                        vscode.window.setStatusBarMessage(`✅ Extension Restart disparado`, 3000);
                        return;
                    }
                    else if (data.action === 'GET_WINDOWS') {
                        loadExclusions();
                        try {
                            const lines = await getWindowsFromDaemon();
                            
                            let uniqueWindows = [];
                            let seenTitles = new Set();

                            for (const line of lines) {
                                if (!line || !line.includes('|||')) continue;
                                const parts = line.split('|||');
                                const processId = parseInt(parts[0].trim(), 10);
                                const title = parts[1].trim();
                                
                                if (!title || title === "") continue;

                                const lowerTitle = title.toLowerCase();
                                const shouldExclude = WINDOW_EXCLUSION_LIST.some(ex => 
                                    lowerTitle.includes(ex.toLowerCase())
                                );
                                
                                if (!shouldExclude && !seenTitles.has(title)) {
                                    uniqueWindows.push({
                                        id: processId,
                                        title: title
                                    });
                                    seenTitles.add(title);
                                }
                            }

                            uniqueWindows.sort((a, b) => a.title.localeCompare(b.title));

                            outputChannel.appendLine(`🪟 Alt-Tab: Encontradas ${uniqueWindows.length} janelas reais instataneamente.`);
                            ws.send(JSON.stringify({ type: 'WINDOWS_LIST', payload: uniqueWindows }));
                        } catch (e) {
                            outputChannel.appendLine(`⚠️ Erro ao listar janelas nativas: ${e.message}`);
                        }
                        return;
                    }
                    else if (data.action === 'SWITCH_WINDOW') {
                        try {
                            outputChannel.appendLine(`🎯 Acionando via VBScript (AppActivate): ${data.title}`);
                            
                            const os = require('os');
                            const path = require('path');
                            const fs = require('fs');
                            const { execSync } = require('child_process');
                            
                            // PowerShell leva ~500ms para iniciar. VBScript via cscript leva ~20ms.
                            const vbsPath = path.join(os.tmpdir(), 'antigravity_focus.vbs');
                            if (!fs.existsSync(vbsPath)) {
                                fs.writeFileSync(vbsPath, 'Set wshell = CreateObject("WScript.Shell")\nwshell.AppActivate WScript.Arguments(0)');
                            }
                            
                            // Usaremos cscript executando o vbs no modo oculto/rápido
                            const focusCmd = `cscript //nologo "${vbsPath}" ${data.windowId}`;
                            try { execSync(focusCmd); } catch (err) {}
                            
                            vscode.window.setStatusBarMessage(`✅ Focando: ${data.title}`, 2000);
                        } catch (e) {
                            outputChannel.appendLine(`⚠️ Erro ao focar janela: ${e.message}`);
                        }
                        return;
                    }
                    
                    if (actionLabel) {
                        outputChannel.appendLine(`⌨️ Ação: ${actionLabel}`);
                        vscode.window.setStatusBarMessage(`✅ Comando enviado: ${actionLabel}`, 2000);
                    }
                    return;
                }

                // Tratamento de Simulação de Mouse via Touchpad
                if (data.type === 'MOUSE_SIM') {
                    const { mouse, Point, Button } = require('@nut-tree-fork/nut-js');
                    if (data.action === 'MOVE') {
                        const pos = await mouse.getPosition();
                        await mouse.setPosition(new Point(Math.max(0, pos.x + Math.round(data.dx)), Math.max(0, pos.y + Math.round(data.dy))));
                    } else if (data.action === 'SCROLL') {
                        const scrollDist = Math.round(Math.abs(data.dy));
                        if (data.dy > 0) {
                            await mouse.scrollUp(scrollDist);
                        } else {
                            await mouse.scrollDown(scrollDist);
                        }
                    } else if (data.action === 'CLICK') {
                        if (data.button === 'LEFT') await mouse.leftClick();
                        else if (data.button === 'RIGHT') await mouse.rightClick();
                        else if (data.button === 'MIDDLE') {
                            await mouse.pressButton(Button.MIDDLE);
                            await mouse.releaseButton(Button.MIDDLE);
                        }
                    }
                    return;
                }

                if (data.type === 'FREE_TEXT') {
                    const msg = data.msg;
                    if (!msg) return;
                    outputChannel.appendLine(`⌨️ Digitação Livre: "${msg}"`);
                    
                    // Envia o texto via clipboard + paste para ser mais rápido e preciso no foco atual
                    await vscode.env.clipboard.writeText(msg);
                    await keyboard.pressKey(Key.LeftControl, Key.V);
                    await keyboard.releaseKey(Key.LeftControl, Key.V);
                    
                    vscode.window.setStatusBarMessage(`✅ Texto enviado ao foco`, 2000);
                    return;
                }

                const msg = data.msg || (typeof data === 'string' ? data : '');
                if (!msg) return;

                outputChannel.appendLine(`>> Recebido: "${msg}"`);
                
                // Adiciona ao histórico e salva
                const historyItem = { id: Date.now(), text: msg, date: new Date().toISOString() };
                history.push(historyItem); // Novo vai para o final
                history.sort((a, b) => a.id - b.id); // Re-ordena apenas para garantir integridade
                if (history.length > 50) history.shift(); // Remove o mais antigo (do topo) se passar de 50
                saveHistory();

                // Notifica todos os clientes do novo item
                wss.clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) {
                        c.send(JSON.stringify({ type: 'HISTORY', payload: history }));
                    }
                });
                
                // 1. SIMULAÇÃO DE TECLADO (Recortar para limpar o input)
                outputChannel.appendLine("Simulando Ctrl+A e Ctrl+X via nut-js...");
                await keyboard.pressKey(Key.LeftControl, Key.A);
                await keyboard.releaseKey(Key.LeftControl, Key.A);
                await keyboard.pressKey(Key.LeftControl, Key.X);
                await keyboard.releaseKey(Key.LeftControl, Key.X);
                
                await new Promise(resolve => setTimeout(resolve, 200));
                
                let existingContent = "";
                try {
                    existingContent = await vscode.env.clipboard.readText();
                } catch (err) {}

                // 2. COMBINA OS TEXTOS
                const trimmedExisting = existingContent.replace(/\s+$/, '');
                const hasNewLine = existingContent.endsWith('\n') || existingContent.endsWith('\r');
                const finalMsg = trimmedExisting ? `${trimmedExisting}${hasNewLine ? '\n' : ' '}${msg.trim()}` : msg.trim();
                
                // 3. ENVIO
                await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', finalMsg);
                vscode.window.setStatusBarMessage(`✅ Recortado e Enviado`, 2000);
            } catch (e) {
                outputChannel.appendLine(`Erro no fluxo: ${e.message}`);
            }
        });
    });

    // Streaming para o celular
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme !== 'file') return;
        const lastChange = event.contentChanges[0]?.text;
        if (lastChange && wss) {
            wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'UPDATE', payload: lastChange })); });
        }
    }));
}

function getWebpageContent(ip, port) {
    return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
}




function deactivate() {
    if (psDaemon) {
        psDaemon.stdin.write("EXIT\r\n");
        psDaemon.kill();
    }
}
module.exports = { activate, deactivate };
