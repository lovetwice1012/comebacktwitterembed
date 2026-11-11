'use strict';

// Shared error identity without loading server-only services into local tools.
class AutomationError extends Error {
    constructor(code, message, status = 400) { super(message); this.name = 'AutomationError'; this.code = code; this.status = status; }
}
module.exports = { AutomationError };
