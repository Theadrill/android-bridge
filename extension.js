const vscode = require('vscode');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const clipboardy = require('clipboardy');

let wss;
let httpServer;
let outputChannel;

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Android Bridge");
    outputChannel.appendLine("Android Bridge: Modo Combine-and-Send Ativado");
    
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
        
        ws.on('message', async (message) => {
            let data;
            try { 
                data = JSON.parse(message.toString()); 
            } catch(e) { 
                data = { type: 'LEGACY', msg: message.toString() }; 
            }

            // Handshake de Reconexão: Evita refresh infinito e tela de erro
            if (data.type === 'HELLO') {
                if (data.reconnected) {
                    outputChannel.appendLine("🔄 Cliente antigo detectado, forçando refresh controlado...");
                    ws.send(JSON.stringify({ type: 'COMMAND', action: 'REFRESH' }));
                } else {
                    outputChannel.appendLine("✨ Nova sessão iniciada no celular.");
                }
                return;
            }

            const msg = data.msg || (typeof data === 'string' ? data : '');
            if (!msg) return;

            outputChannel.appendLine(`>> Recebido: "${msg}"`);
            
            try {
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
        <title>IA Bridge</title>
        <style>
            body { font-family: sans-serif; background: #0a0a0c; color: white; margin: 0; padding: 20px; text-align: center; }
            #status { font-size: 10px; color: #555; margin-bottom: 10px; text-transform: uppercase; font-weight: bold; letter-spacing: 1px; }
            #chat { height: 180px; overflow-y: auto; background: #111; padding: 10px; margin-bottom: 20px; font-family: monospace; font-size: 13px; color: #3b82f6; border-radius: 8px; border: 1px solid #333; text-align: left;}
            textarea { width: 100%; height: 120px; background: #222; color: white; border: 1px solid #444; border-radius: 12px; padding: 15px; box-sizing: border-box; font-size: 18px; outline: none; }
            button { width: 100%; margin-top: 15px; padding: 20px; background: #3b82f6; color: white; border: none; border-radius: 12px; font-size: 18px; font-weight: bold; }
            .connected { color: #10b981 !important; }
            .disconnected { color: #ef4444 !important; }
        </style>
    </head>
    <body>
        <div id="status">Iniciando...</div>
        <h2 style="color: #3b82f6; margin-top: 0;">ANTIGRAVITY BRIDGE</h2>
        <div id="chat">Histórico de Envios</div>
        <textarea id="msg" placeholder="Dite e aperte Enter..." onkeydown="checkEnter(event)"></textarea>
        <button onclick="send()">ENVIAR (OU ENTER)</button>
        <script>
            let ws;
            let isReconnected = false;

            function connect() {
                const status = document.getElementById('status');
                ws = new WebSocket('ws://' + window.location.host);
                
                ws.onopen = () => {
                    status.innerText = '● CONECTADO';
                    status.className = 'connected';
                    // Informa ao servidor se esta é uma reconexão de uma página que já estava aberta
                    ws.send(JSON.stringify({ type: 'HELLO', reconnected: isReconnected }));
                    isReconnected = false;
                };

                ws.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    
                    // Tratamento de mensagens de streaming
                    if(d.type === 'UPDATE') {
                        const c = document.getElementById('chat');
                        if(c.innerText.includes('Streaming')) c.innerText = '';
                        c.innerText += d.payload;
                        c.scrollTop = c.scrollHeight;
                    }

                    // Comando de Refresh enviado pelo servidor após reconexão bem-sucedida
                    if(d.type === 'COMMAND' && d.action === 'REFRESH') {
                        window.location.reload();
                    }
                };

                ws.onclose = () => {
                    status.innerText = '○ DESCONECTADO - RECONECTANDO...';
                    status.className = 'disconnected';
                    isReconnected = true; 
                    // Tenta reconectar o socket em silêncio a cada 2s
                    // NÃO damos refresh aqui para evitar a tela de erro do navegador
                    setTimeout(connect, 2000);
                };

                ws.onerror = () => { ws.close(); };
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
                    // Enviamos como JSON para o novo protocolo do servidor
                    ws.send(JSON.stringify({ type: 'MESSAGE', msg: m.value })); 
                    m.value = ''; 
                }
            }

            connect();
        </script>
    </body>
    </html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };
