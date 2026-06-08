// Gamepad browser note dismiss
(() => {
    const note = document.getElementById('playserver-gamepad-browser-note');
    const dismissButton = document.getElementById('playserver-gamepad-browser-note-dismiss');
    const storageKey = 'games-vault:playserver-gamepad-browser-note-dismissed';
    if (!note) {
        return;
    }

    let storage = null;
    try {
        storage = window.localStorage;
    } catch {
        storage = null;
    }

    if (storage?.getItem(storageKey) === '1') {
        note.remove();
        return;
    }

    note.hidden = false;
    dismissButton?.addEventListener('click', () => {
        try {
            storage?.setItem(storageKey, '1');
        } catch {
            // Ignore private-mode/storage failures; still dismiss for the current page.
        }
        note.remove();
    });
})();

// Battery save modal lazy load
(() => {
    const modal = document.getElementById('playServerSaveHistoryModal');
    const frame = document.getElementById('playServerSaveHistoryFrame');
    if (!modal || !frame) {
        return;
    }

    const src = frame.getAttribute('data-src');
    if (!src) {
        return;
    }

    modal.addEventListener('show.bs.modal', () => {
        if (!frame.getAttribute('src')) {
            frame.setAttribute('src', src);
        }
    });

    modal.addEventListener('hidden.bs.modal', () => {
        frame.removeAttribute('src');
    });
})();
