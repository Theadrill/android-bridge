const fs=require('fs');
const path=require('path');
let c=fs.readFileSync('extension.js','utf8');
const start=c.indexOf('    <!DOCTYPE html>');
const end=c.lastIndexOf('</html>`');
if (start !== -1 && end !== -1) {
    const htmlSnippet = c.substring(start, end + 7);
    fs.writeFileSync('index.html', htmlSnippet);
    console.log('HTML extraction successful');
    
    // Agora substituir a string por `return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');`
    const updatedExtension = c.substring(0, c.indexOf("function getWebpageContent(ip, port) {")) + 
    "function getWebpageContent(ip, port) {\n    return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');\n}\n\n" + 
    c.substring(end + 9);
    fs.writeFileSync('extension.js', updatedExtension);
    console.log('extension.js substitution successful');
} else {
    console.log('Could not find HTML tags');
}
