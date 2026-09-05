'use strict';
/* global api, state, boot, notice */
(() => {
    const from64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const to64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    function publicOptions(value, registration) {
        const options = value.publicKey;
        options.challenge = from64(options.challenge);
        if (registration) options.user.id = from64(options.user.id);
        for (const key of ['excludeCredentials', 'allowCredentials']) {
            for (const credential of options[key] || []) credential.id = from64(credential.id);
        }
        return options;
    }
    function serialized(credential) {
        const response = { clientDataJSON: to64(credential.response.clientDataJSON) };
        for (const key of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
            if (credential.response[key]) response[key] = to64(credential.response[key]);
        }
        if (credential.response.getTransports) response.transports = credential.response.getTransports();
        return { id: credential.id, rawId: to64(credential.rawId), type: credential.type, response,
            authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults() };
    }
    const login = document.createElement('button');
    login.type = 'button'; login.textContent = 'パスキーでログイン';
    login.disabled = !window.PublicKeyCredential;
    document.getElementById('login-form').after(login);
    login.addEventListener('click', async () => {
        login.disabled = true;
        try {
            const begin = await api('auth/passkeys/login/begin', { method: 'POST', body: '{}' });
            const credential = await navigator.credentials.get({ publicKey: publicOptions(begin.options, false) });
            if (!credential) throw new Error('パスキー操作が完了しませんでした。');
            const result = await api('auth/passkeys/login/finish', { method: 'POST',
                headers: { 'X-WebAuthn-Session': begin.sessionId }, body: JSON.stringify(serialized(credential)) });
            state.csrf = result.csrf; await boot();
        } catch (error) { document.getElementById('login-error').textContent = error.message; }
        finally { login.disabled = false; }
    });
    const panel = document.createElement('article'); panel.className = 'panel';
    const title = document.createElement('h2'); title.textContent = 'パスキー';
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'この端末のパスキーを登録';
    add.disabled = !window.PublicKeyCredential;
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '登録済みパスキー';
    const list = document.createElement('div'); panel.append(title, add, refresh, list);
    document.getElementById('diagnostics').append(panel);
    async function refreshKeys() {
        const result = await api('v1/account/passkeys'); list.replaceChildren();
        for (const key of result.items) {
            const row = document.createElement('p'); row.textContent = key.label + ' / ' + key.createdAt + ' ';
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '登録解除';
            remove.addEventListener('click', async () => {
                try { await api('v1/account/passkeys/' + encodeURIComponent(key.id), { method: 'DELETE' }); await refreshKeys(); }
                catch (error) { notice(error.message, true); }
            });
            row.append(remove); list.append(row);
        }
    }
    refresh.addEventListener('click', () => refreshKeys().catch(error => notice(error.message, true)));
    add.addEventListener('click', async () => {
        add.disabled = true;
        try {
            const begin = await api('v1/account/passkeys/register/begin', { method: 'POST', body: '{}' });
            const credential = await navigator.credentials.create({ publicKey: publicOptions(begin.options, true) });
            if (!credential) throw new Error('パスキー登録が完了しませんでした。');
            await api('v1/account/passkeys/register/finish', { method: 'POST',
                headers: { 'X-WebAuthn-Session': begin.sessionId }, body: JSON.stringify(serialized(credential)) });
            await refreshKeys(); notice('パスキーを登録しました。');
        } catch (error) { notice(error.message, true); }
        finally { add.disabled = false; }
    });
})();
