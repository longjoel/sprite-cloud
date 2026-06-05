(() => {
  function b64ToBuffer(value) {
    if (!value) return new ArrayBuffer(0);
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufferToB64(buffer) {
    const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function publicKeyCreateToBrowser(options) {
    options.challengeText = options.challenge;
    options.challenge = b64ToBuffer(options.challenge);
    options.user.id = b64ToBuffer(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map(c => ({ ...c, id: b64ToBuffer(c.id) }));
    }
    return options;
  }

  function publicKeyGetToBrowser(options) {
    options.challengeText = options.challenge;
    options.challenge = b64ToBuffer(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: b64ToBuffer(c.id) }));
    }
    return options;
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  function assertPasskeysAvailable() {
    if (!window.isSecureContext) {
      throw new Error('Passkeys require HTTPS or localhost. Firefox supports passkeys, but this Games Vault page is being served over ordinary HTTP. Create a local profile for now, or use HTTPS before adding a passkey.');
    }
    if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('This browser does not expose passkeys/WebAuthn on this page. Try HTTPS, localhost, or another browser/device.');
  }

  async function register(form) {
    assertPasskeysAvailable();
    const options = await postJson('/Passkeys/Register/Options', {
      displayName: form.displayName.value,
      color: form.color.value,
      deviceName: form.deviceName?.value || null
    });
    const challenge = options.challenge;
    const credential = await navigator.credentials.create({ publicKey: publicKeyCreateToBrowser(options) });
    const payload = {
      id: credential.id,
      rawId: bufferToB64(credential.rawId),
      challenge,
      response: {
        attestationObject: bufferToB64(credential.response.attestationObject),
        clientDataJson: bufferToB64(credential.response.clientDataJSON),
        transports: typeof credential.response.getTransports === 'function' ? credential.response.getTransports() : []
      }
    };
    const result = await postJson('/Passkeys/Register/Complete', payload);
    window.location.href = result.redirectUrl || '/Profiles';
  }

  async function login() {
    assertPasskeysAvailable();
    const options = await postJson('/Passkeys/Login/Options');
    const challenge = options.challenge;
    const credential = await navigator.credentials.get({ publicKey: publicKeyGetToBrowser(options) });
    const payload = {
      id: credential.id,
      rawId: bufferToB64(credential.rawId),
      challenge,
      response: {
        authenticatorData: bufferToB64(credential.response.authenticatorData),
        clientDataJson: bufferToB64(credential.response.clientDataJSON),
        signature: bufferToB64(credential.response.signature),
        userHandle: credential.response.userHandle ? bufferToB64(credential.response.userHandle) : null
      }
    };
    const result = await postJson('/Passkeys/Login/Complete', payload);
    window.location.href = result.redirectUrl || '/';
  }

  function showError(container, error) {
    if (!container) return alert(error.message || String(error));
    container.textContent = error.message || String(error);
    container.classList.remove('d-none');
  }

  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-passkey-register-form]');
    if (!form) return;
    event.preventDefault();
    const errorBox = document.querySelector('[data-passkey-error]');
    errorBox?.classList.add('d-none');
    try { await register(form); } catch (error) { showError(errorBox, error); }
  });

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-passkey-login]');
    if (!button) return;
    event.preventDefault();
    const errorBox = document.querySelector('[data-passkey-error]');
    errorBox?.classList.add('d-none');
    try { await login(); } catch (error) { showError(errorBox, error); }
  });
})();
