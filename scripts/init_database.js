'use strict';

const { ensureDatabaseSchema, TABLES } = require('../src/db_schema');
const { closeDatabaseConnection } = require('../src/db');

async function main() {
    await ensureDatabaseSchema();
    console.log('Database schema is ready.');
    console.log('Tables:');
    for (const table of Object.values(TABLES)) {
        console.log(`- ${table}`);
    }
}

if (require.main === module) {
    main()
        .catch((err) => {
            console.error('Failed to initialize database schema:', err);
            process.exitCode = 1;
        })
        .finally(async () => {
            await closeDatabaseConnection();
        });
}

module.exports = { main };
