'use strict';

// Backward-compatible wrapper. The server now handles YouTube, Niconico, and
// future media caches through mediaDeliveryServer.
module.exports = require('./mediaDeliveryServer');
