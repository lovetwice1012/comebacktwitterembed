'use strict';

const path = require('path');
const {
    SETTINGS_FILE,
    loadSettingsFromFile,
    saveSettingsToDatabase,
    ensureSettingsTable,
} = require('../src/settings');
const { closeDatabaseConnection } = require('../src/db');
const { TABLES } = require('../src/db_schema');

function parseArgs(argv) {
    const args = { file: SETTINGS_FILE, dryRun: false };
    for (const arg of argv) {
        if (arg === '--dry-run') {
            args.dryRun = true;
        } else {
            args.file = path.resolve(arg);
        }
    }
    return args;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const loaded = loadSettingsFromFile(args.file, { createIfMissing: false });

    if (args.dryRun) {
        console.log(`Read settings from ${args.file}`);
        console.log(`Top-level keys: ${Object.keys(loaded.settings).length}`);
        console.log(`Provider namespaces: ${Object.keys(loaded.settings.byProvider || {}).length}`);
        if (loaded.changed) console.log('Settings will be normalized before being saved.');
        return;
    }

    await ensureSettingsTable();
    await saveSettingsToDatabase(loaded.settings);

    console.log(`Migrated settings from ${args.file}`);
    console.log(`Guild settings table: ${TABLES.guildProviderSettings}`);
    console.log(`Global settings table: ${TABLES.globalSettings}`);
    console.log(`User settings table: ${TABLES.users}`);
}

if (require.main === module) {
    main()
        .catch((err) => {
            console.error('Failed to migrate settings:', err);
            process.exitCode = 1;
        })
        .finally(async () => {
            await closeDatabaseConnection();
        });
}

module.exports = { main };
