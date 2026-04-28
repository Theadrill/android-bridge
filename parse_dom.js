const fs = require('fs');
const html = fs.readFileSync('chat_scraping_capture.html', 'utf8');

const cheerio = require('cheerio');
const $ = cheerio.load(html);

const conversationDiv = $('#conversation');
if (conversationDiv.length > 0) {
    // Vamos procurar blocos que parecem mensagens do usuário ou do bot
    // Normalmente as mensagens do usuário tem o data-testid="user-input-step" ou algo parecido
    // E do bot tem as respotas.
    
    console.log("=== ENCONTRADO O #conversation ===");
    const children = conversationDiv.find('.flex.flex-col.gap-y-3.px-4 > div');
    console.log("Quantidade de blocos na conversa:", children.length);
    
    // Pegar o último bloco pai que engloba a mensagem do bot (e possivelmente do usuario)
    // O html interno desse ultimo bloco deve ser o que procuramos
    if (children.length > 0) {
        const lastBlock = children.last();
        // Vamos imprimir um pedaço pra ver o que tem
        console.log("=== HTML DO ULTIMO BLOCO (RESUMO) ===");
        const blockHtml = lastBlock.html();
        console.log(blockHtml.substring(0, 1500));
        
        // Vamos checar se ele tem a parte do Generating
        if (blockHtml.includes('Generating..')) {
            console.log("\n=> CONTÉM 'Generating..' ! É ESSE ELEMENTO!");
        }
    } else {
        // Se a estrutura for um pouco diferente, vamos tentar achar o "Generating.." e pegar o pai dele
        const genDiv = $('div:contains("Generating..")').last();
        if (genDiv.length > 0) {
            console.log("=== ACHAMOS A DIV GENERATING ===");
            // Pegar o elemento pai "grande" que engloba a mensagem inteira
            // Procurando o pai que tem classes de layout da mensagem
            const parentBlock = genDiv.closest('.flex.items-start');
            if (parentBlock.length > 0) {
                console.log("Pai encontrado! classes:", parentBlock.attr('class'));
                console.log(parentBlock.html().substring(0, 2000));
            } else {
                console.log("Pai não encontrado, div de topo:", genDiv.parent().html().substring(0, 500));
            }
        } else {
            console.log("Não achou Generating..");
        }
    }
} else {
    console.log("Não achou #conversation");
}
