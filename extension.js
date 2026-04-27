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
const historyPath = 'C:\\Users\\rodri\\.gemini\\antigravity\\output_logs\\history.json';
const exclusionsPath = path.join(__dirname, 'exclusions.json');

let WINDOW_EXCLUSION_LIST = [];
let psDaemon;
let pendingWindowsRequests = [];
let windowsBuffer = "";

// CDP Connection
let cdpConnection = null;
let cdpWs = null;
const CDP_PORTS = [9000, 9222, 9223, 9224];
let cdpIdCounter = 1;

async function discoverAntigravityCDP() {
    for (const port of CDP_PORTS) {
        try {
            const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await resp.json();
            
            const agTargets = targets.filter(t => {
                const title = t.title?.toLowerCase() || '';
                const url = t.url?.toLowerCase() || '';
                return title.includes('antigravity') || 
                       url.includes('workbench') || 
                       url.includes('jetski');
            });
            
            if (agTargets.length > 0) {
                outputChannel.appendLine(`🔍 CDP: Encontrou ${agTargets.length} instância(s) na porta ${port}`);
                return agTargets;
            }
        } catch(e) {
            // Porta não disponível
        }
    }
    return [];
}

async function connectCDP(wsUrl) {
    return new Promise((resolve, reject) => {
        cdpWs = new WebSocket(wsUrl);
        
        cdpWs.on('open', () => {
            outputChannel.appendLine(`🔌 CDP: Conectado ao WebSocket`);
            
            cdpWs.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.id && cdpConnection && cdpConnection.pending && cdpConnection.pending[data.id]) {
                        const handler = cdpConnection.pending[data.id];
                        delete cdpConnection.pending[data.id];
                        if (data.error) {
                            handler.reject(new Error(data.error.message));
                        } else {
                            handler.resolve(data.result);
                        }
                    }
                } catch(e) {}
            });
            
            cdpWs.on('error', (err) => {
                outputChannel.appendLine(`⚠️ CDP WS Error: ${err.message}`);
            });
            
            cdpWs.on('close', () => {
                outputChannel.appendLine(`🔌 CDP: Desconectado`);
                cdpConnection = null;
                cdpWs = null;
            });
            
            resolve(true);
        });
        
        cdpWs.on('error', reject);
    });
}

async function callCDP(method, params = {}) {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
        throw new Error('CDP não conectado');
    }
    
    const id = cdpIdCounter++;
    return new Promise((resolve, reject) => {
        if (!cdpConnection) cdpConnection = { pending: {} };
        cdpConnection.pending[id] = { resolve, reject };
        
        cdpWs.send(JSON.stringify({ id, method, params }));
        
        setTimeout(() => {
            if (cdpConnection && cdpConnection.pending[id]) {
                delete cdpConnection.pending[id];
                reject(new Error('CDP timeout'));
            }
        }, 10000);
    });
}

async function testCDPConnection() {
    outputChannel.appendLine(`🧪 CDP: Testando conexão...`);
    
    const targets = await discoverAntigravityCDP();
    
    if (targets.length === 0) {
        outputChannel.appendLine(`❌ CDP: Nenhuma instância do Antigravity encontrada`);
        outputChannel.appendLine(`   → Inicie o Antigravity com: antigravity . --remote-debugging-port=9000`);
        return;
    }
    
    outputChannel.appendLine(`📋 CDP: target = "${targets[0].title}"`);
    
    try {
        await connectCDP(targets[0].webSocketDebuggerUrl);
        
        await callCDP('Runtime.enable', {});
        
        outputChannel.appendLine(`✅ CDP: Conexão estabelecida com sucesso!`);
    } catch(e) {
        outputChannel.appendLine(`❌ CDP Erro: ${e.message}`);
    }
}

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
            const rawHistory = JSON.parse(data);
            
            // Normaliza o histórico para o formato de exibição
            history = rawHistory.map(item => ({
                id: item.id || new Date(item.timestamp || item.date).getTime(),
                role: item.role === 'user' ? 'user' : 'assistant', // Padrão agora é assistant
                text: item.text || item.content || '',
                date: item.date || item.timestamp || new Date().toISOString()
            }));

            // Ordena por data (mais antigo primeiro)
            history.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

            // Limita as últimas 50 mensagens
            if (history.length > 50) history = history.slice(history.length - 50);
        } else {
            history = [];
        }
    } catch (e) {
        if (outputChannel) outputChannel.appendLine(`Erro ao carregar histórico unificado: ${e.message}`);
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
    
    // Teste de conexão CDP
    setTimeout(() => testCDPConnection(), 2000);
    
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

    // Adiciona um Watcher para atualizar o celular automaticamente quando a IA responder
    if (fs.existsSync(historyPath)) {
        fs.watch(historyPath, (eventType) => {
            if (eventType === 'change') {
                loadHistory();
                if (wss) {
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(JSON.stringify({ type: 'HISTORY', payload: history }));
                        }
                    });
                }
            }
        });
    }
    
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
        // Headers CORS básicos para todas as rotas
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'POST' && req.url === '/upload-print') {
            const formidable = require('formidable');
            const form = new formidable.IncomingForm();
            const uploadDir = path.join(__dirname, 'temp_screenshots');
            
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
            
            form.parse(req, (err, fields, files) => {
                if (err) {
                    outputChannel.appendLine(`❌ Erro no Formidable: ${err.message}`);
                    res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
                    return;
                }
                
                try {
                    const file = (files.image && files.image[0]) ? files.image[0] : files.image;
                    if (!file) {
                        outputChannel.appendLine(`⚠️ Nenhum arquivo 'image' encontrado no upload.`);
                        res.writeHead(400); res.end(JSON.stringify({ error: 'No image found' }));
                        return;
                    }

                    const oldPath = file.filepath;
                    const newPath = path.join(uploadDir, 'last_print.png');
                    
                    fs.copyFileSync(oldPath, newPath);
                    
                    // Mágica Instantânea: PowerShell para Clipboard + Ctrl+V
                    const psCommand = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${newPath}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose(); (New-Object -ComObject WScript.Shell).SendKeys('^v')"`;
                    
                    require('child_process').exec(psCommand, (psErr) => {
                        if (psErr) outputChannel.appendLine(`⚠️ Erro no Clipboard: ${psErr.message}`);
                    });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    outputChannel.appendLine(`📸 Print recebido e injetado no foco!`);
                } catch (parseErr) {
                    outputChannel.appendLine(`❌ Erro ao processar arquivo: ${parseErr.message}`);
                    res.writeHead(500); res.end(JSON.stringify({ error: parseErr.message }));
                }
            });
            return;
        }

        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getWebpageContent(localIp, port));
        } else { res.writeHead(404); res.end(); }
    });
    
    httpServer.listen(port, '0.0.0.0');

    // Manutenção Automática: Limpa a pasta de prints a cada 2 minutos
    setInterval(() => {
        const uploadDir = path.join(__dirname, 'temp_screenshots');
        if (fs.existsSync(uploadDir)) {
            const files = fs.readdirSync(uploadDir);
            if (files.length > 0) {
                files.forEach(file => {
                    const filePath = path.join(uploadDir, file);
                    try {
                        fs.unlinkSync(filePath);
                    } catch (err) {
                        outputChannel.appendLine(`⚠️ Erro ao deletar arquivo temporário: ${err.message}`);
                    }
                });
                outputChannel.appendLine(`🧹 Limpeza automática: Pasta de prints limpa!`);
            }
        }
    }, 120000); // 120.000 ms = 2 minutos

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
                    const modifiers = data.modifiers || [];
                    const nutMods = modifiers.map(m => {
                        if (m === 'CTRL') return Key.LeftControl;
                        if (m === 'ALT') return Key.LeftAlt;
                        if (m === 'SHIFT') return Key.LeftShift;
                        if (m === 'WIN') return Key.LeftSuper;
                        return null;
                    }).filter(m => m !== null);

                    const typeWithMods = async (key) => {
                        if (nutMods.length > 0) {
                            // Pressiona todos os modificadores
                            for (const mod of nutMods) {
                                await keyboard.pressKey(mod);
                            }
                            // Pressiona e solta a tecla alvo
                            await keyboard.type(key);
                            // Solta todos os modificadores
                            for (const mod of nutMods) {
                                await keyboard.releaseKey(mod);
                            }
                        } else {
                            await keyboard.type(key);
                        }
                    };
                    
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
                    else if (data.action === 'STD_ENTER') {
                        await typeWithMods(Key.Enter);
                        actionLabel = 'Enter (Standard)';
                    }
                    else if (data.action === 'CTRL_ENTER') {
                        await keyboard.pressKey(Key.LeftControl, Key.Enter);
                        await keyboard.releaseKey(Key.LeftControl, Key.Enter);
                        actionLabel = 'Ctrl+Enter';
                    }
                    else if (data.action === 'BACKSPACE') {
                        await typeWithMods(Key.Backspace);
                        actionLabel = 'Backspace';
                    }
                    else if (data.action === 'ESC') {
                        await typeWithMods(Key.Escape);
                        actionLabel = 'Esc';
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
                        await typeWithMods(Key.F5);
                        actionLabel = 'Refresh (F5)';
                    }
                    else if (data.action.startsWith('F') && !isNaN(data.action.substring(1))) {
                        const fKey = Key[data.action];
                        if (fKey) await typeWithMods(fKey);
                        actionLabel = data.action;
                    }
                    else if (data.action === 'HOME') { await typeWithMods(Key.Home); actionLabel = 'Home'; }
                    else if (data.action === 'END') { await typeWithMods(Key.End); actionLabel = 'End'; }
                    else if (data.action === 'PAGE_UP') { await typeWithMods(Key.PageUp); actionLabel = 'Page Up'; }
                    else if (data.action === 'PAGE_DOWN') { await typeWithMods(Key.PageDown); actionLabel = 'Page Down'; }
                    else if (data.action === 'INSERT') { await typeWithMods(Key.Insert); actionLabel = 'Insert'; }
                    else if (data.action === 'PRINT') { 
                        await keyboard.pressKey(Key.LeftSuper, Key.LeftShift, Key.S);
                        await keyboard.releaseKey(Key.LeftSuper, Key.LeftShift, Key.S);
                        actionLabel = 'Print Screen (Win+Shift+S)'; 
                    }
                    else if (data.action === 'DELETE') { await typeWithMods(Key.Delete); actionLabel = 'Delete'; }
                    else if (data.action === 'UP') { await typeWithMods(Key.Up); actionLabel = 'Up'; }
                    else if (data.action === 'DOWN') { await typeWithMods(Key.Down); actionLabel = 'Down'; }
                    else if (data.action === 'LEFT') { await typeWithMods(Key.Left); actionLabel = 'Left'; }
                    else if (data.action === 'RIGHT') { await typeWithMods(Key.Right); actionLabel = 'Right'; }
                    else if (data.action === 'TAB') { await typeWithMods(Key.Tab); actionLabel = 'Tab'; }
                    else if (data.action === 'MUTE') { await typeWithMods(Key.AudioMute); actionLabel = 'Mute'; }
                    else if (data.action === 'VOL_DOWN') { await typeWithMods(Key.AudioVolDown); actionLabel = 'Volume -'; }
                    else if (data.action === 'VOL_UP') { await typeWithMods(Key.AudioVolUp); actionLabel = 'Volume +'; }
                    else if (data.action === 'BRIGHT_DOWN') { 
                        require('child_process').exec('powershell -Command "$b = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness -ErrorAction SilentlyContinue; if ($b) { $level = $b.CurrentBrightness - 10; if ($level -lt 0) { $level = 0 }; (Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, $level) }"');
                        actionLabel = 'Brilho -';
                    }
                    else if (data.action === 'BRIGHT_UP') { 
                        require('child_process').exec('powershell -Command "$b = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness -ErrorAction SilentlyContinue; if ($b) { $level = $b.CurrentBrightness + 10; if ($level -gt 100) { $level = 100 }; (Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, $level) }"');
                        actionLabel = 'Brilho +';
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

                // Adiciona o prompt do usuário ao histórico global imediatamente
                const localISO = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000)).toISOString().replace('Z', '');
                const historyItem = { 
                    timestamp: localISO, 
                    role: 'user', 
                    content: msg,
                    conversation_id: 'aaf9f81d-04aa-49d4-bd06-e72f1e3ec7db'
                };
                
                let currentLogs = [];
                if (fs.existsSync(historyPath)) {
                    try {
                        currentLogs = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
                    } catch(e) {}
                }
                currentLogs.push(historyItem);
                if (currentLogs.length > 100) currentLogs.shift();
                fs.writeFileSync(historyPath, JSON.stringify(currentLogs, null, 2));

                // Recarrega e envia para atualizar a tela do celular instantaneamente
                loadHistory();

                // Notifica todos os clientes
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
