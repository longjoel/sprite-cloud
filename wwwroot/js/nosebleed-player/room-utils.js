(() => {
    const configEl = document.getElementById('nosebleed-player-config');
    if (!configEl) {
        return;
    }

    let config;
    try {
        config = JSON.parse(configEl.textContent || '{}');
    } catch {
        return;
    }

    const presenceSummaryEl = document.getElementById('room-presence-summary');
    const seatStripEl = document.getElementById('room-seat-strip');
    const chatStatusEl = document.getElementById('room-chat-status');
    const chatMessagesEl = document.getElementById('room-chat-messages');
    const chatLogEl = document.getElementById('room-chat-log');
    const chatFormEl = document.getElementById('room-chat-form');
    const kickFormEl = document.getElementById('room-kick-form');
    const currentPlayerNumber = Number.isInteger(config.playerNumber) ? config.playerNumber : null;
    const canKickPlayers = config.canKickPlayers === true;

    const shareCopyButton = document.querySelector('[data-share-link-copy-button]');
    const shareCopyValue = document.querySelector('[data-share-link-copy-value]');
    const shareCopyRow = document.querySelector('[data-share-link-copy-row]');
    const shareLinkStatus = document.querySelector('[data-share-link-status]');
    const setShareStatus = (text) => {
        if (shareLinkStatus) {
            shareLinkStatus.textContent = text;
        }
    };
    const copyShareLink = async () => {
        if (!shareCopyValue?.value || !shareCopyButton) {
            return false;
        }

        try {
            await navigator.clipboard.writeText(shareCopyValue.value);
        } catch {
            shareCopyValue.focus();
            shareCopyValue.select();
            document.execCommand('copy');
        }

        shareCopyButton.textContent = 'Copied';
        setTimeout(() => { shareCopyButton.textContent = 'Copy'; }, 1600);
        return true;
    };
    shareCopyButton?.addEventListener('click', async () => {
        if (await copyShareLink()) {
            setShareStatus('Invite link copied.');
        }
    });
    document.querySelectorAll('[data-share-link-form]').forEach((form) => {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitButton = form.querySelector('button[type="submit"]');
            const originalText = submitButton?.textContent ?? '';
            submitButton?.setAttribute('disabled', 'disabled');
            if (submitButton) {
                submitButton.textContent = 'Creating…';
            }
            setShareStatus('Creating invite link…');

            try {
                const response = await fetch(form.action, {
                    method: 'POST',
                    body: new FormData(form),
                    credentials: 'same-origin',
                    headers: {
                        Accept: 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok || !payload.link) {
                    throw new Error(payload.error || `invite ${response.status}`);
                }

                if (shareCopyValue) {
                    shareCopyValue.value = payload.link;
                    shareCopyValue.setAttribute('aria-label', `Generated ${payload.grantMode ?? ''} invite link`.trim());
                }
                shareCopyRow?.classList.remove('d-none');
                if (await copyShareLink()) {
                    setShareStatus(`${payload.grantMode ?? 'Invite'} link created and copied.`);
                } else {
                    setShareStatus(`${payload.grantMode ?? 'Invite'} link created.`);
                }
            } catch (error) {
                setShareStatus(error instanceof Error ? error.message : 'Could not create invite link.');
            } finally {
                submitButton?.removeAttribute('disabled');
                if (submitButton) {
                    submitButton.textContent = originalText;
                }
            }
        });
    });

    const getKickToken = () => kickFormEl?.querySelector('input[name="__RequestVerificationToken"]')?.value ?? '';

    const clearChildren = (el) => {
        while (el && el.firstChild) {
            el.removeChild(el.firstChild);
        }
    };

    const appendMutedListItem = (el, text) => {
        if (!el) {
            return;
        }

        const item = document.createElement('li');
        item.className = 'text-muted';
        item.textContent = text;
        el.appendChild(item);
    };

    const buildSeatCard = (playerNumber, player, statusText, tone) => {
        const isCurrentSeat = currentPlayerNumber === playerNumber;
        const occupant = player?.displayName ?? 'Open seat';
        const card = document.createElement('div');
        card.className = `border rounded px-3 py-2 small bg-body ${tone} ${isCurrentSeat ? 'border-primary border-2' : ''}`.trim();
        card.style.minWidth = '9rem';

        const seatLabel = document.createElement('div');
        seatLabel.className = 'text-uppercase text-muted fw-semibold';
        seatLabel.textContent = `Player ${playerNumber}`;

        const occupantEl = document.createElement('div');
        occupantEl.className = isCurrentSeat ? 'fw-bold' : 'fw-semibold';
        occupantEl.textContent = occupant;

        const statusEl = document.createElement('div');
        statusEl.className = 'text-muted';
        statusEl.textContent = isCurrentSeat ? `${statusText} · your seat` : statusText;

        card.appendChild(seatLabel);
        card.appendChild(occupantEl);
        card.appendChild(statusEl);

        const actions = document.createElement('div');
        actions.className = 'd-flex flex-wrap gap-2 mt-2';
        if (isCurrentSeat && document.getElementById('leave-seat-form')) {
            const leaveButton = document.createElement('button');
            leaveButton.type = 'submit';
            leaveButton.className = 'btn btn-sm btn-outline-warning';
            leaveButton.setAttribute('form', 'leave-seat-form');
            leaveButton.textContent = 'Leave seat';
            actions.appendChild(leaveButton);
        }

        if (canKickPlayers && player?.viewerId && !isCurrentSeat) {
            const kickButton = document.createElement('button');
            kickButton.type = 'button';
            kickButton.className = 'btn btn-sm btn-outline-danger';
            kickButton.textContent = 'Kick';
            kickButton.addEventListener('click', () => kickPlayer(player.viewerId, player.displayName ?? 'Player'));
            actions.appendChild(kickButton);
        }

        if (actions.childElementCount > 0) {
            card.appendChild(actions);
        }

        return card;
    };

    const kickPlayer = async (viewerId, displayName) => {
        if (!canKickPlayers || !config.roomKickUrl || !kickFormEl || !viewerId) {
            return;
        }

        if (!window.confirm(`Kick ${displayName || 'this player'} from their seat?`)) {
            return;
        }

        const token = getKickToken();
        const body = new URLSearchParams({ viewerId });
        if (token) {
            body.set('__RequestVerificationToken', token);
        }

        try {
            const response = await fetch(config.roomKickUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                credentials: 'same-origin'
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || `kick ${response.status}`);
            }

            if (chatStatusEl) {
                chatStatusEl.textContent = `${displayName || 'Player'} was kicked from their seat.`;
            }
            await loadPresence();
        } catch (error) {
            if (chatStatusEl) {
                chatStatusEl.textContent = error instanceof Error ? error.message : 'Could not kick player.';
            }
        }
    };

    const renderPresence = (payload) => {
        if (!presenceSummaryEl || !seatStripEl) {
            return;
        }

        const players = Array.isArray(payload.players) ? payload.players : [];
        presenceSummaryEl.textContent = `${payload.totalConnected ?? 0} connected`;
        clearChildren(seatStripEl);

        const playersByNumber = new Map(players
            .filter((player) => Number.isInteger(player.playerNumber))
            .map((player) => [player.playerNumber, player]));
        for (let playerNumber = 1; playerNumber <= 4; playerNumber += 1) {
            const player = playersByNumber.get(playerNumber);
            if (player) {
                seatStripEl.appendChild(buildSeatCard(playerNumber, player, `Input ${Number.isInteger(player.port) ? player.port + 1 : playerNumber}`, 'border-success-subtle'));
            } else {
                seatStripEl.appendChild(buildSeatCard(playerNumber, null, 'Waiting for a player', ''));
            }
        }
    };

    const renderChat = (payload) => {
        if (!chatStatusEl || !chatMessagesEl) {
            return;
        }

        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        chatStatusEl.textContent = messages.length === 0 ? 'No messages yet.' : `${messages.length} recent message${messages.length === 1 ? '' : 's'}`;
        clearChildren(chatMessagesEl);
        if (messages.length === 0) {
            appendMutedListItem(chatMessagesEl, 'No one has chatted yet.');
            return;
        }

        for (const entry of messages) {
            const item = document.createElement('li');
            item.className = 'mb-2';

            const meta = document.createElement('div');
            meta.className = 'text-muted';
            const timestamp = entry.createdUtc ? new Date(entry.createdUtc) : null;
            const timeLabel = timestamp && !Number.isNaN(timestamp.valueOf())
                ? timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                : '';
            meta.textContent = `${entry.displayName ?? 'Viewer'}${timeLabel ? ` · ${timeLabel}` : ''}`;

            const body = document.createElement('div');
            body.className = 'text-break';
            body.textContent = entry.message ?? '';

            item.appendChild(meta);
            item.appendChild(body);
            chatMessagesEl.appendChild(item);
        }

        if (chatLogEl) {
            chatLogEl.scrollTop = chatLogEl.scrollHeight;
        }
    };

    const loadPresence = async () => {
        if (!config.roomPresenceUrl) {
            return;
        }

        try {
            const response = await fetch(config.roomPresenceUrl, { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`presence ${response.status}`);
            }

            renderPresence(await response.json());
        } catch {
            if (presenceSummaryEl && seatStripEl) {
                presenceSummaryEl.textContent = 'Presence unavailable right now.';
                clearChildren(seatStripEl);
                const placeholder = document.createElement('div');
                placeholder.className = 'border rounded px-3 py-2 small text-muted bg-body';
                placeholder.textContent = 'Seat map unavailable.';
                seatStripEl.appendChild(placeholder);
            }
        }
    };

    const loadChat = async () => {
        if (!config.roomChatUrl) {
            return;
        }

        try {
            const response = await fetch(config.roomChatUrl, { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`chat ${response.status}`);
            }

            renderChat(await response.json());
        } catch {
            if (chatStatusEl && chatMessagesEl) {
                chatStatusEl.textContent = 'Chat unavailable right now.';
                clearChildren(chatMessagesEl);
                appendMutedListItem(chatMessagesEl, 'Could not load chat.');
            }
        }
    };

    if (chatFormEl && config.roomChatUrl) {
        chatFormEl.addEventListener('submit', async (event) => {
            event.preventDefault();
            const submitButton = chatFormEl.querySelector('button[type="submit"]');
            const input = chatFormEl.querySelector('input[name="message"]');
            if (!(input instanceof HTMLInputElement)) {
                return;
            }

            submitButton?.setAttribute('disabled', 'disabled');
            if (chatStatusEl) {
                chatStatusEl.textContent = 'Sending…';
            }

            try {
                const response = await fetch(chatFormEl.action, {
                    method: 'POST',
                    body: new FormData(chatFormEl),
                    credentials: 'same-origin'
                });

                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload.error || `chat ${response.status}`);
                }

                input.value = '';
                await loadChat();
            } catch (error) {
                if (chatStatusEl) {
                    chatStatusEl.textContent = error instanceof Error ? error.message : 'Could not send chat message.';
                }
            } finally {
                submitButton?.removeAttribute('disabled');
            }
        });
    }

    loadPresence();
    loadChat();
    window.setInterval(loadPresence, 3000);
    window.setInterval(loadChat, 3000);
})();
