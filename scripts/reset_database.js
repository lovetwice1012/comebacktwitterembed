'use strict';

const { ensureDatabaseSchema, TABLES } = require('../src/db_schema');
const { closeDatabaseConnection, queryDatabase } = require('../src/db');

async function main() {
    await queryDatabase('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of [...Object.values(TABLES)].reverse()) {
            await queryDatabase(`DROP TABLE IF EXISTS ${table}`);
        }
    } finally {
        await queryDatabase('SET FOREIGN_KEY_CHECKS = 1');
    }

    await ensureDatabaseSchema();
    console.log('Database schema was reset.');
    console.log('Tables:');
    for (const table of Object.values(TABLES)) {
        console.log(`- ${table}`);
    }
}

if (require.main === module) {
    main()
        .catch((err) => {
            console.error('Failed to reset database schema:', err);
            process.exitCode = 1;
        })
        .finally(async () => {
            await closeDatabaseConnection();
        });
}

module.exports = { main };
