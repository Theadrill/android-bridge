# Android Remote Bridge for VS Code

Esta extensão permite controlar remotamente o VS Code (Cursor/Antigravity) via seu dispositivo Android. Perfeito para ditar comandos para a IA ou inserir texto rapidamente enquanto está longe do teclado.

## ✨ Recursos

- **Premium UI:** Interface mobile moderna com modo escuro, glassmorphism e animações suaves.
- **Real-time Streaming (🛠️ TODO):** Veja a resposta da IA no seu celular em tempo real enquanto ela é gerada no PC.
- **Auto IP Discovery:** Mostra o IP local para facilitar a conexão sem depender de DNS local (.local).
- **Status Bar Integration:** Veja o status da conexão diretamente na barra de status do VS Code.

## 🚀 Como Usar

1.  Abra esta pasta no VS Code.
2.  Pressione **F5** para iniciar a extensão em uma Janela de Desenvolvimento.
3.  No seu Android, abra o navegador e acesse o endereço mostrado na notificação ou na Barra de Status (ex: `http://192.168.1.5:3000`).
4.  No PC, leve o cursor para onde deseja inserir texto (ex: Chat do Cursor/Antigravity).
5.  No Android, digite sua mensagem e clique em **Enviar para o PC**.
6.  O texto será enviado, o VS Code processará (pressionando Enter automaticamente) e o retorno da IA aparecerá no seu celular!

## 🛠️ Requisitos

- Node.js instalado.
- Ambos os dispositivos (PC e Celular) na mesma rede Wi-Fi.
