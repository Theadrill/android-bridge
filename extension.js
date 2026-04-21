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
                            const os = require('os');
                            const path = require('path');
                            const fs = require('fs');
                            const { execSync } = require('child_process');
                            
                            const psPath = path.join(os.tmpdir(), "antigravity_get_windows.ps1");
                            if (!fs.existsSync(psPath)) {
                                const psScript = `
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
$windows = [WinAPI]::GetWindows()
foreach ($w in $windows) { Write-Output $w }
`;
                                fs.writeFileSync(psPath, psScript);
                            }

                            const output = execSync(`powershell -ExecutionPolicy Bypass -NoProfile -File "${psPath}"`, { encoding: 'utf8' });
                            const lines = output.split('\n');
                            
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

                            // Ordena por título para facilitar no celular
                            uniqueWindows.sort((a, b) => a.title.localeCompare(b.title));

                            outputChannel.appendLine(`🪟 Alt-Tab: Encontradas ${uniqueWindows.length} janelas reais via PowerShell.`);
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
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>IA Bridge</title>
        <style>
            :root {
                --bg: #0a0a0c;
                --card: #16161a;
                --primary: #3b82f6;
                --text: #ffffff;
                --text-dim: #94a3b8;
                --border: #2d2d33;
            }
            * { box-sizing: border-box; }
            body { 
                font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
                background: var(--bg); 
                color: var(--text); 
                margin: 0; 
                padding: 15px; 
                display: flex;
                flex-direction: column;
                height: 100vh;
                height: 100dvh;
                box-sizing: border-box;
                overflow: hidden;
            }
            #status { font-size: 9px; color: #555; margin-bottom: 2px; text-transform: uppercase; font-weight: bold; letter-spacing: 0.5px; opacity: 0.7; }
            .connected { color: #10b981 !important; }
            .disconnected { color: #ef4444 !important; }

            .header { margin-bottom: 8px; }
            h2 { color: var(--primary); margin: 0; font-size: 16px; letter-spacing: 0.5px; font-weight: 800; }

            #history-container {
                flex: 1;
                overflow-y: auto;
                background: var(--card);
                border: 1px solid var(--border);
                border-radius: 12px;
                margin-bottom: 10px;
                padding: 6px;
                display: flex;
                flex-direction: column;
                gap: 5px;
            }

            .history-item {
                background: #1e1e24;
                border: 1px solid #333;
                border-radius: 6px;
                padding: 6px 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                animation: fadeIn 0.2s ease-out;
            }

            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(-10px); }
                to { opacity: 1; transform: translateY(0); }
            }

            .history-text {
                font-size: 12px;
                color: #e2e8f0;
                text-align: left;
                word-break: break-word;
                flex: 1;
                margin-right: 8px;
            }

            .copy-btn {
                background: #2d2d33;
                border: none;
                border-radius: 5px;
                padding: 5px;
                color: var(--primary);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s;
                min-width: 30px;
                height: 30px;
            }

            .copy-btn:active {
                background: #3b82f633;
                transform: scale(0.95);
            }

            .input-area {
                background: var(--card);
                padding: 12px;
                border-radius: 16px;
                border: 1px solid var(--border);
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            }

            textarea { 
                width: 100%; 
                height: 60px; 
                background: rgba(255,255,255,0.03); 
                color: white; 
                border: 1px solid rgba(255,255,255,0.05); 
                border-radius: 8px;
                padding: 8px; 
                box-sizing: border-box; 
                font-size: 15px; 
                outline: none; 
                resize: none;
                font-family: inherit;
                margin-bottom: 10px;
                transition: border-color 0.2s;
            }

            textarea:focus {
                border-color: var(--primary);
            }

            .button-dock {
                display: flex;
                gap: 8px;
                align-items: center;
                justify-content: space-between;
            }

            .dock-btn {
                flex: 1;
                height: 44px;
                background: #2d2d33;
                border: 1px solid #3d3d45;
                border-radius: 10px;
                color: #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.1s;
                touch-action: manipulation;
                user-select: none;
                -webkit-tap-highlight-color: transparent;
            }

            .dock-btn:active {
                transform: scale(0.92);
                background: #444;
            }

            .send-btn { 
                width: 100%;
                height: 50px;
                background: var(--primary); 
                color: white; 
                border: none; 
                border-radius: 12px; 
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                font-weight: 700;
                font-size: 14px;
                letter-spacing: 1px;
                box-shadow: 0 4px 14px 0 rgba(59, 130, 246, 0.3);
                touch-action: manipulation;
                user-select: none;
                -webkit-tap-highlight-color: transparent;
                margin-top: 12px;
                text-transform: uppercase;
            }

            .send-btn:active {
                transform: scale(0.95);
                filter: brightness(1.1);
            }

            #streaming-box {
                font-size: 10px;
                color: #6366f1;
                background: #6366f111;
                padding: 4px 8px;
                border-radius: 6px;
                margin-bottom: 8px;
                text-align: left;
                font-family: 'Cascadia Code', 'Consolas', monospace;
                white-space: pre-wrap;
                max-height: 30px;
                overflow: hidden;
                border: 1px solid #6366f122;
            }

            /* Modal Styles */
            .modal-overlay {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.85);
                backdrop-filter: blur(4px);
                z-index: 1000;
                justify-content: center;
                align-items: center;
                padding: 0;
            }

            .modal {
                background: var(--card);
                border: 1px solid var(--border);
                border-radius: 24px;
                padding: 24px;
                width: 95%;
                max-width: 320px;
                text-align: center;
                box-shadow: 0 20px 50px rgba(0,0,0,0.6);
                animation: modalScale 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
                display: flex;
                flex-direction: column;
                max-height: 80vh;
            }

            .modal.full-width {
                width: 100%;
                max-width: none;
                border-radius: 0;
                border-left: none;
                border-right: none;
            }

            #modal-content {
                overflow-y: auto;
                padding-right: 5px;
            }

            #modal-content::-webkit-scrollbar { width: 4px; }
            #modal-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }

            @keyframes modalScale {
                from { transform: scale(0.85); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }

            .modal h3 { margin: 0 0 15px 0; font-size: 18px; color: var(--primary); flex-shrink: 0; }

            .modal-btn {
                width: 100%;
                min-height: 50px;
                margin-bottom: 12px;
                border: 1px solid var(--border);
                border-radius: 12px;
                background: #2d2d33;
                color: white;
                font-weight: 600;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                cursor: pointer;
                flex-shrink: 0;
            }

            .modal-btn.window-item {
                font-size: 12px;
                justify-content: flex-start;
                padding: 0 15px;
                text-align: left;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                display: block;
                line-height: 50px;
            }

            .modal-btn:active { transform: scale(0.96); background: #3d3d45; }
            .modal-btn.cancel { border: none; background: transparent; color: var(--text-dim); margin-top: 5px; flex-shrink: 0; }
        </style>
    </head>
    <body>
        <div id="status">Iniciando...</div>

        <!-- Restart Modal -->
        <div id="restart-modal" class="modal-overlay" onclick="closeModal(event)">
            <div class="modal" onclick="event.stopPropagation()">
                <h3 id="modal-title">OTHER ACTIONS</h3>
                <div id="modal-content">
                    <button class="modal-btn" onclick="execRestart('RESTART_EXT')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                        Restart Extension
                    </button>
                    <button class="modal-btn" onclick="execRestart('REFRESH_F5')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        Refresh (F5)
                    </button>
                    <button class="modal-btn" onclick="execRestart('RESTART_PROJECT')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                        Restart Project (npm)
                    </button>
                    <button class="modal-btn" onclick="getWindows()" style="color: #60a5fa;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                        Alt Tab
                    </button>
                    <button class="modal-btn" onclick="openFreeWriting()" style="color: #c084fc;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        Escrever Livremente
                    </button>
                </div>
                <button class="modal-btn cancel" onclick="closeModal()">CANCELAR</button>
            </div>
        </div>
        <div class="header">
            <h2>ANTIGRAVITY BRIDGE</h2>
        </div>

        <div id="streaming-box">Aguardando código...</div>
        
        <div id="history-container">
            <!-- Itens de histórico entram aqui -->
        </div>

        <div class="input-area">
            <textarea id="msg" 
                placeholder="Dite algo..." 
                onkeydown="checkEnter(event)" 
                onfocus="scrollToBottom()"
                autocomplete="on" 
                autocorrect="on" 
                autocapitalize="sentences" 
                spellcheck="true"
                inputmode="text"></textarea>
            
            <div class="button-dock">
                <button class="dock-btn" onclick="openModal()" title="Outras Ações" style="color: #fbbf24;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                </button>

                <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('COPY')" title="Copiar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
                <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('PASTE')" title="Colar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                </button>
                <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('ENTER')" title="Pular Linha" style="color: #10b981;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg>
                </button>
                <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('BACKSPACE')" title="Backspace">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path><line x1="18" y1="9" x2="12" y2="15"></line><line x1="12" y1="9" x2="18" y2="15"></line></svg>
                </button>
                <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('SAVE')" title="Salvar (Ctrl+S)" style="color: #60a5fa;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                </button>
            </div>
            <button class="send-btn" onpointerdown="event.preventDefault(); send()">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                ENVIAR PROMPT
            </button>
        </div>

        <script>
            let ws;
            let isReconnected = false;

            function connect() {
                const status = document.getElementById('status');
                ws = new WebSocket('ws://' + window.location.host);
                
                ws.onopen = () => {
                    status.innerText = '● CONECTADO';
                    status.className = 'connected';
                    ws.send(JSON.stringify({ type: 'HELLO', reconnected: isReconnected }));
                    isReconnected = false;
                };

                ws.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    
                    if(d.type === 'UPDATE') {
                        const s = document.getElementById('streaming-box');
                        s.innerText = d.payload;
                    }

                    if(d.type === 'HISTORY') {
                        renderHistory(d.payload);
                    }

                    if(d.type === 'COMMAND' && d.action === 'REFRESH') {
                        window.location.reload();
                    }

                    if(d.type === 'WINDOWS_LIST') {
                        renderWindowList(d.payload);
                    }
                };

                ws.onclose = () => {
                    status.innerText = '○ DESCONECTADO - RECONECTANDO...';
                    status.className = 'disconnected';
                    isReconnected = true; 
                    setTimeout(connect, 2000);
                };

                ws.onerror = () => { ws.close(); };
            }

            function renderHistory(history) {
                const container = document.getElementById('history-container');
                container.innerHTML = '';
                
                if (history.length === 0) {
                    container.innerHTML = '<div style="color: #444; margin-top: 20px;">Nenhum envio recente</div>';
                    return;
                }

                history.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'history-item';
                    div.innerHTML = \`
                        <div class="history-text">\${escapeHtml(item.text)}</div>
                        <button class="copy-btn" onclick="copyToInput('\${item.id}', event)" title="Copiar para o input">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                    \`;
                    container.appendChild(div);
                });

                // Auto-scroll para o final
                container.scrollTop = container.scrollHeight;

                // Armazena o histórico globalmente para busca rápida
                window.currentHistory = history;
            }

            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            async function copyToInput(id, event) {
                event && event.preventDefault();
                const item = window.currentHistory.find(h => h.id == id);
                if (item) {
                    const textarea = document.getElementById('msg');
                    textarea.value = item.text;
                    textarea.focus();
                    
                    // Tenta copiar para o clipboard do smartphone
                    let copied = false;
                    try {
                        // Tenta o método moderno primeiro (pode falhar em HTTP)
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(item.text);
                            copied = true;
                        }
                    } catch (err) {}

                    // Fallback para HTTP / Navegadores antigos
                    if (!copied) {
                        try {
                            const tempInput = document.createElement('textarea');
                            tempInput.value = item.text;
                            tempInput.style.position = 'fixed';
                            tempInput.style.left = '-9999px';
                            tempInput.style.top = '0';
                            document.body.appendChild(tempInput);
                            tempInput.select();
                            tempInput.setSelectionRange(0, 99999);
                            document.execCommand('copy');
                            document.body.removeChild(tempInput);
                            copied = true;
                        } catch (err) {
                            console.error('Falha no fallback de cópia:', err);
                        }
                    }

                    if (copied) {
                        // Feedback visual no botão
                        const btn = event.currentTarget;
                        const oldHtml = btn.innerHTML;
                        btn.innerHTML = '✅';
                        setTimeout(() => btn.innerHTML = oldHtml, 1000);
                    }
                }
            }

            function checkEnter(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                }
            }

            function send() {
                const m = document.getElementById('msg');
                if(m.value.trim() && ws.readyState === WebSocket.OPEN){ 
                    ws.send(JSON.stringify({ type: 'MESSAGE', msg: m.value })); 
                    m.value = ''; 
                }
            }

            function sendAction(action) {
                if(ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'KEY_SIM', action: action }));
                    
                    // Feedback tátil/visual simples no botão
                    window.navigator.vibrate && window.navigator.vibrate(10);
                }
            }

            function openModal() {
                const modalDiv = document.querySelector('.modal');
                modalDiv.classList.remove('full-width');
                const title = document.getElementById('modal-title');
                const content = document.getElementById('modal-content');
                title.innerText = 'OTHER ACTIONS';
                content.innerHTML = \`
                    <button class="modal-btn" onclick="execRestart('RESTART_EXT')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                        Restart Extension
                    </button>
                    <button class="modal-btn" onclick="execRestart('REFRESH_F5')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        Refresh (F5)
                    </button>
                    <button class="modal-btn" onclick="execRestart('RESTART_PROJECT')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                        Restart Project (npm)
                    </button>
                    <button class="modal-btn" onclick="getWindows()" style="color: #60a5fa;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                        Alt Tab
                    </button>
                    <button class="modal-btn" onclick="openFreeWriting()" style="color: #c084fc;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        Escrever Livremente
                    </button>
                \`;
                document.getElementById('restart-modal').style.display = 'flex';
                window.navigator.vibrate && window.navigator.vibrate(20);
            }

            function closeModal(e) {
                document.getElementById('restart-modal').style.display = 'none';
                document.querySelector('.modal').classList.remove('full-width');
            }

            function openAltTab() {
                openModal();
                getWindows();
            }

            function getWindows() {
                if(ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'KEY_SIM', action: 'GET_WINDOWS' }));
                    document.getElementById('modal-title').innerText = 'BUSCANDO JANELAS...';
                }
            }

            function renderWindowList(windows) {
                const title = document.getElementById('modal-title');
                const content = document.getElementById('modal-content');
                title.innerText = 'ALT TAB';
                content.innerHTML = '';
                
                if (windows.length === 0) {
                    content.innerHTML = '<div style="color: #666; padding: 20px;">Nenhuma janela encontrada</div>';
                } else {
                    windows.forEach(w => {
                        const btn = document.createElement('button');
                        btn.className = 'modal-btn window-item';
                        btn.innerText = w.title;
                        btn.onclick = () => switchWindow(w.id, w.title);
                        content.appendChild(btn);
                    });
                }
                
                // Botão de Voltar
                const backBtn = document.createElement('button');
                backBtn.className = 'modal-btn';
                backBtn.style.marginTop = '10px';
                backBtn.style.background = 'transparent';
                backBtn.style.borderColor = '#444';
                backBtn.innerHTML = '← Voltar';
                backBtn.onclick = openModal;
                content.appendChild(backBtn);
            }

            function switchWindow(id, title) {
                if(ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'KEY_SIM', action: 'SWITCH_WINDOW', windowId: id, title: title }));
                    // Ao invés de fechar, volta para o menu principal de ações
                    openModal();
                }
            }

            function openFreeWriting() {
                const modalDiv = document.querySelector('.modal');
                modalDiv.classList.add('full-width');
                const title = document.getElementById('modal-title');
                const content = document.getElementById('modal-content');
                title.innerText = 'ESCREVER LIVREMENTE';
                content.innerHTML = \`
                    <textarea id="free-msg" 
                        placeholder="Digite texto livre para o PC..." 
                        style="height: 100px; margin-bottom: 12px; font-size: 15px; background: rgba(255,255,255,0.03); color: white; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 12px; width: 100%; box-sizing: border-box; outline: none; font-family: inherit;"
                        onkeydown="checkFreeEnter(event)"
                        autocomplete="on" 
                        autocorrect="on" 
                        autocapitalize="none" 
                        spellcheck="true"></textarea>
                    
                    <div class="button-dock" style="margin-bottom: 12px; gap: 6px;">
                        <button class="dock-btn" onclick="openAltTab()" title="Alt Tab" style="color: #60a5fa;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                        </button>
                        <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('COPY')" title="Copiar">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                        <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('PASTE')" title="Colar">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                        </button>
                        <button class="dock-btn" onpointerdown="event.preventDefault(); insertNewLine()" title="Pular Linha Local" style="color: #a78bfa;">
                             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 10L11 15"></path><path d="M6 10H15C17.2091 10 19 11.7909 19 14V18"></path></svg>
                        </button>
                        <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('ENTER')" title="Enter no PC" style="color: #10b981;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg>
                        </button>
                        <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('BACKSPACE')" title="Backspace">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path><line x1="18" y1="9" x2="12" y2="15"></line><line x1="12" y1="9" x2="18" y2="15"></line></svg>
                        </button>
                        <button class="dock-btn" onpointerdown="event.preventDefault(); sendAction('SAVE')" title="Salvar (Ctrl+S)" style="color: #60a5fa;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                        </button>
                    </div>

                    <button class="send-btn" onclick="sendFreeText()" style="margin-top: 0; height: 55px; background: #c084fc; box-shadow: 0 4px 14px 0 rgba(192, 132, 252, 0.3);">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                        ENVIAR TEXTO
                    </button>

                    <button class="modal-btn" onclick="openModal()" style="margin-top: 15px; background: transparent; border-color: #444; min-height: 40px;">
                        ← Voltar
                    </button>
                \`;
                // Foca no novo textarea
                setTimeout(() => document.getElementById('free-msg').focus(), 300);
            }

            function sendFreeText() {
                const m = document.getElementById('free-msg');
                if(m.value.trim() && ws.readyState === WebSocket.OPEN){ 
                    ws.send(JSON.stringify({ type: 'FREE_TEXT', msg: m.value })); 
                    m.value = ''; 
                    window.navigator.vibrate && window.navigator.vibrate(20);
                }
            }

            function checkFreeEnter(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendFreeText();
                }
            }

            function insertNewLine() {
                const m = document.getElementById('free-msg');
                const start = m.selectionStart;
                const end = m.selectionEnd;
                const top = m.scrollTop;
                m.value = m.value.substring(0, start) + "\\n" + m.value.substring(end);
                m.selectionStart = m.selectionEnd = start + 1;
                m.scrollTop = top;
                m.focus();
            }

            function execRestart(action) {
                sendAction(action);
                closeModal();
            }

            function scrollToBottom() {
                // Pequeno delay para esperar o teclado abrir
                setTimeout(() => {
                    window.scrollTo(0, document.body.scrollHeight);
                    document.getElementById('msg').scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 300);
            }

            // Garante que o layout se ajuste ao redimensionar (abertura do teclado)
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', () => {
                    document.body.style.height = window.visualViewport.height + 'px';
                });
            }

            connect();
        </script>
    </body>
    </html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };
