'use strict';

const { main } = require('./migrate_settings_to_mysql');
const { closeDatabaseConnection } = require('../src/db');

if (require.main === module) {
    main()
        .catch((err) => {
            console.error('Failed to seed settings:', err);
            process.exitCode = 1;
        })
        .finally(async () => {
            await closeDatabaseConnection();
        });
}
