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
