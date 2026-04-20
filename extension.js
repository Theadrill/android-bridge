const vscode = require('vscode');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { windowManager } = require('node-window-manager');

let wss;
let httpServer;
let outputChannel;
let history = [];
const historyPath = path.join(__dirname, 'history.json');

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
                    const { execSync } = require('child_process');
                    let keys = '';
                    let actionLabel = '';
                    
                    if (data.action === 'COPY') { keys = '^c'; actionLabel = 'Copiar (Ctrl+C)'; }
                    else if (data.action === 'PASTE') { keys = '^v'; actionLabel = 'Colar (Ctrl+V)'; }
                    else if (data.action === 'ENTER') { keys = '+{ENTER}'; actionLabel = 'Enter (Shift+Enter)'; }
                    else if (data.action === 'RESTART') {
                        outputChannel.appendLine(`🔄 Iniciando Dev Restart (Modo Anterior)...`);
                        const psCommand = `powershell -Command "$wshell = New-Object -ComObject WScript.Shell; $allWindows = Get-Process | Where-Object { $_.MainWindowTitle -like '*bridge*' -and $_.MainWindowTitle -notlike '*Extension Development Host*' }; if ($allWindows) { $wshell.AppActivate($allWindows[0].Id); Start-Sleep -Milliseconds 500; $wshell.SendKeys('^+{F5}') }"`;
                        try { 
                            execSync(psCommand); 
                            outputChannel.appendLine(`🚀 Atalho Ctrl+Shift+F5 enviado via Shell.`);
                        } catch (err) {
                            outputChannel.appendLine(`❌ Erro no restart: ${err.message}`);
                        }
                        vscode.window.setStatusBarMessage(`✅ Dev Restart enviado`, 3000);
                        return;
                    }
                    
                    if (keys) {
                        outputChannel.appendLine(`⌨️ Simulando Tecla: ${actionLabel}`);
                        const psCommand = `powershell -Command "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('${keys}')"`;
                        try { execSync(psCommand); } catch (err) {}
                        vscode.window.setStatusBarMessage(`✅ Atalho enviado: ${actionLabel}`, 2000);
                    }
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
                outputChannel.appendLine("Simulando Ctrl+A e Ctrl+X via Sistema...");
                const { execSync } = require('child_process');
                const psCommand = `powershell -Command "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('^a'); Start-Sleep -Milliseconds 100; $wshell.SendKeys('^x')"`;
                
                try { execSync(psCommand); } catch (err) {}
                
                await new Promise(resolve => setTimeout(resolve, 600));
                
                let existingContent = "";
                try {
                    existingContent = await vscode.env.clipboard.readText();
                } catch (err) {}

                // 2. COMBINA OS TEXTOS
                const finalMsg = existingContent.trim() ? `${existingContent.trim()} ${msg.trim()}` : msg.trim();
                
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
                flex: 1.5;
                height: 44px;
                background: var(--primary); 
                color: white; 
                border: none; 
                border-radius: 10px; 
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                font-size: 13px; 
                font-weight: 800;
                box-shadow: 0 4px 14px 0 rgba(59, 130, 246, 0.3);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                touch-action: manipulation;
                user-select: none;
                -webkit-tap-highlight-color: transparent;
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
        </style>
    </head>
    <body>
        <div id="status">Iniciando...</div>
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
                <button class="dock-btn" onpointerdown="sendAction('RESTART')" title="Dev Restart" style="color: #fbbf24;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                </button>
                <button class="dock-btn" onpointerdown="sendAction('COPY')" title="Copiar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
                <button class="dock-btn" onpointerdown="sendAction('PASTE')" title="Colar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                </button>
                <button class="dock-btn" onpointerdown="sendAction('ENTER')" title="Pular Linha">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg>
                </button>
                <button class="send-btn" onpointerdown="send()">
                    <span>ENVIAR</span>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                </button>
            </div>
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
