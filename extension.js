const vscode = require('vscode');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');

let wss;
let httpServer;
let outputChannel;

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Android Bridge");
    outputChannel.appendLine("Android Bridge: Modo Clear Output Ativado");
    
    const port = 3000;
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
            const msg = message.toString();
            outputChannel.appendLine(`>> Recebido: "${msg}"`);
            
            try {
                // 1. FOCO NO CHAT
                await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
                
                // 2. ENVIO DEFINITIVO (Tentando o formato texto puro)
                // Como apareceu [object Object], vamos mandar apenas a string msg
                outputChannel.appendLine("Disparando comando Antigravity com texto puro...");
                await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', msg);
                
                // Removemos o Clipboard e o Paste para não duplicar nem mandar msg em branco
                
                vscode.window.setStatusBarMessage(`✅ Antigravity: Mensagem Enviada`, 2000);
            } catch (e) {
                outputChannel.appendLine(`Erro de envio: ${e.message}`);
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
            #chat { height: 180px; overflow-y: auto; background: #111; padding: 10px; margin-bottom: 20px; font-family: monospace; font-size: 13px; color: #3b82f6; border-radius: 8px; border: 1px solid #333; text-align: left;}
            textarea { width: 100%; height: 120px; background: #222; color: white; border: 1px solid #444; border-radius: 12px; padding: 15px; box-sizing: border-box; font-size: 18px; outline: none; }
            button { width: 100%; margin-top: 15px; padding: 20px; background: #3b82f6; color: white; border: none; border-radius: 12px; font-size: 18px; font-weight: bold; }
        </style>
    </head>
    <body>
        <h2 style="color: #3b82f6;">ANTIGRAVITY BRIDGE</h2>
        <div id="chat">Streaming da IA aqui...</div>
        <textarea id="msg" placeholder="Dite e aperte Enter..." onkeydown="checkEnter(event)"></textarea>
        <button onclick="send()">ENVIAR (OU ENTER)</button>
        <script>
            const ws = new WebSocket('ws://' + window.location.host);
            ws.onmessage = (e) => {
                const d = JSON.parse(e.data);
                if(d.type === 'UPDATE') {
                    const c = document.getElementById('chat');
                    if(c.innerText.includes('Streaming')) c.innerText = '';
                    c.innerText += d.payload;
                    c.scrollTop = c.scrollHeight;
                }
            };
            function checkEnter(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                }
            }
            function send() {
                const m = document.getElementById('msg');
                if(m.value.trim()){ ws.send(m.value); m.value = ''; }
            }
        </script>
    </body>
    </html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };
