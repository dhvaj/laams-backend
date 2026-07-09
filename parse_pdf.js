const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const pdfPath = "d:\\Learning and Assessment Accessible Management System\\LAAMS (Learning and Assessment Accessible Management System) V1 April 21 2026.pdf";
const outputPath = "C:\\Users\\dhyan\\.gemini\\antigravity\\brain\\4b59ed32-c2d0-456d-a2cf-4962a4af8ed4\\scratch\\laams_v1_doc.txt";

async function run() {
    try {
        let dataBuffer = fs.readFileSync(pdfPath);
        const parser = new PDFParse({ data: dataBuffer });
        const pdfData = await parser.getText();
        const text = pdfData.text || '';
        fs.writeFileSync(outputPath, text);
        console.log("PDF parsed successfully. Total characters:", text.length);
        await parser.destroy();
    } catch (err) {
        console.error("Error parsing PDF:", err);
    }
}

run();
