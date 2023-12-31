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

            result.root.data.forEach(d => {
                const key = d.$.name;
                const value = d.value[0];
                
                if (!locales[key]) {
                    locales[key] = {};
                }
                locales[key][lang] = value;
            });

            console.log(`Loaded LangFile : ${file}`);
            console.log(locales);
        });
    }
});

module.exports = locales;