const data = require('./lang.js');
const fs = require('fs');

// Your API key for Codic
const API_KEY = 'JEaR8JeDHe23zYVOq24sIqTa6x02uBbJHS';

// Function to translate text using Codic API
async function translateToVariableName(text) {
    try {
        const response = await fetch(`https://api.codic.jp/v1/engine/translate.json?text=${encodeURIComponent(text)}&casing=camel`, {
            headers: { Authorization: `Bearer ${API_KEY}` }
        });

        const data = await response.json();

        if (data && data.length > 0) {
            return data[0].translated_text;
        } else {
            return null;
        }
    } catch (error) {
        console.error('Error while translating:', error);
        return null;
    }
}

// Function to update keys in your data structure
async function updateVariableNames(data) {
    for (const key of Object.keys(data)) {
        const variableName = await translateToVariableName(data[key]['en-US']);
        if (variableName) {
            data[variableName] = data[key];
            delete data[key];
        }
    }
}

// Execute the update
updateVariableNames(data).then(() => {
    fs.writeFile('newlang.js', `module.exports = ${JSON.stringify(data, null, 2)};`, (err) => {
        if (err) {
            console.error('Error writing file:', err);
        } else {
            console.log('Data successfully written to newlang.js');
        }
    });
});