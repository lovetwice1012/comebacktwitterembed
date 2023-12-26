const fs = require('fs');
const xml2js = require('xml2js');
const locales = require('./lang.js'); // Import the locales from lang.js

// Function to convert a locale to .resx format
function convertToResx(localeObj, lang) {
    const builder = new xml2js.Builder({ headless: true });
    const root = {
        root: {
            data: Object.keys(localeObj).map(key => ({
                '$': { name: key },
                value: [localeObj[key][lang]]
            }))
        }
    };

    return builder.buildObject(root);
}

// Create 'locales' directory if it doesn't exist
const dir = '../locales';
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
}

// Convert and save for each language
['en-US', 'ja', 'zh-CN', 'es-ES', 'fr', 'ru', 'de', 'pt-BR'].forEach(lang => {
    const resxContent = convertToResx(locales, lang);
    const fileName = `${dir}/${lang}.resx`;
    fs.writeFileSync(fileName, resxContent);
    console.log(`Saved ${fileName}`);
});