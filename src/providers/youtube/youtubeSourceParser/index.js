'use strict';

// Standalone source parser: consumes HTML/JSON and returns metadata without I/O.
module.exports = {
    ...require('./pageData'),
    ...require('./urls'),
    ...require('./html'),
    ...require('./feed'),
};
