'use strict';
// Synthetic messages only; never use these labels to classify user data.
const workerSource = "self.addEventListener('push',e=>{const text=e.data?.text();const kind=text==='synthetic-wns-probe'?'initial':text==='synthetic-after-browser-exit'?'second':text==='synthetic-after-node-ack'?'third':text==='synthetic-after-reconnect'?'fourth':text==='synthetic-wns-copy-probe'?'copy':text==='synthetic-other-site'?'other':'unknown';e.waitUntil(Promise.all([fetch('/seen?case='+kind,{method:'POST'}),self.registration.showNotification('fixture')]))}) ";
function acceptedCase(url, method) {
    if (method !== 'POST' || !/^\/seen\?case=(initial|second|third|fourth|copy|other)$/.test(url || '')) return null;
    return url.slice('/seen?case='.length);
}
module.exports = { workerSource, acceptedCase };
