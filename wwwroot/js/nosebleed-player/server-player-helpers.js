(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.GamesVaultNosebleedServerPlayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function round3(value) {
        return Math.round(value * 1000) / 1000;
    }

    function calculateContainedSize(sourceWidth, sourceHeight, containerWidth, containerHeight) {
        if (sourceWidth <= 0 || sourceHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
            return { width: round3(containerWidth), height: round3(containerHeight) };
        }

        const sourceRatio = sourceWidth / sourceHeight;
        const containerRatio = containerWidth / containerHeight;
        if (containerRatio > sourceRatio) {
            return { width: round3(containerHeight * sourceRatio), height: round3(containerHeight) };
        }

        return { width: round3(containerWidth), height: round3(containerWidth / sourceRatio) };
    }

    function nextAudioEnabledState(current) {
        return !current;
    }

    function nextOverlayEnabledState(current) {
        return !current;
    }

    function chooseInitialGamepadIndex(gamepads, savedIndex, preferredIndex) {
        const pads = Array.from(gamepads || []).filter(pad => pad && pad.connected !== false);
        if (Number.isInteger(savedIndex)) {
            const saved = pads.find(pad => pad && pad.index === savedIndex);
            if (saved) return saved.index;
        }

        if (Number.isInteger(preferredIndex)) {
            const preferred = pads.find(pad => pad && pad.index === preferredIndex);
            if (preferred) return preferred.index;
        }

        const first = pads.find(Boolean);
        return first ? first.index : null;
    }

    const DEFAULT_VIDEO_COMPRESSION = 'balanced';

    function normalizeVideoTransportPreference() {
        return 'webrtc-track';
    }

    function normalizeVideoCompressionPreference(value) {
        return value === 'raw' || value === 'crisp' || value === 'balanced' || value === 'compact'
            ? value
            : DEFAULT_VIDEO_COMPRESSION;
    }

    function chooseVideoTransport() {
        return 'webrtc-track';
    }

    return {
        calculateContainedSize,
        nextAudioEnabledState,
        nextOverlayEnabledState,
        chooseInitialGamepadIndex,
        normalizeVideoTransportPreference,
        normalizeVideoCompressionPreference,
        chooseVideoTransport
    };
});
