'use strict';

// These deterministic data-contract failures cannot improve when the same
// immutable input is reclaimed. Transport/DB/worker availability errors are
// deliberately absent and retain their existing retry behavior.
const PERMANENT = new Set(['GRAPH_INPUT_LIMIT', 'GRAPH_INPUT_INVALID', 'GRAPH_UNIT_INVALID', 'GRAPH_MATCHER_INVALID', 'FLOW_SNAPSHOT_LIMIT', 'FLOW_UNIT_INVALID', 'FLOW_MEMBER_INVALID']);
const permanentFailure = error => PERMANENT.has(error?.code);
module.exports = { permanentFailure };
