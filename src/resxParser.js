const fs = require('fs');
const xml2js = require('xml2js');
const path = require('path');

const localesDir = path.join(__dirname, '../locales');
let locales = {};

fs.readdirSync(localesDir).forEach(file => {
    if (path.extname(file) === '.resx') {
        const filePath = path.join(localesDir, file);
        const xmlData = fs.readFileSync(filePath, 'utf-8');

        xml2js.parseString(xmlData, (err, result) => {
            if (err) {
                console.error(`Failed to parse ${file}:`, err);
                return;
            }
            const lang = file.split('.')[0];
            locales[lang] = {};

            result.root.data.forEach(d => {
                const key = d.$.name;
                const value = d.value[0];
                locales[lang][key] = value;
            });

            console.log(`Loading LangFile : ${file}`);
        });
    }
});

module.exports = locales;