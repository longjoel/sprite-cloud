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
        const pads = Array.from(gamepads || []);
        if (Number.isInteger(savedIndex) && pads[savedIndex]) {
            return savedIndex;
        }

        if (Number.isInteger(preferredIndex)) {
            const preferred = pads.find(pad => pad && pad.index === preferredIndex);
            if (preferred) return preferred.index;
        }

        const first = pads.find(Boolean);
        return first ? first.index : null;
    }

    const DEFAULT_VIDEO_TRANSPORT = 'webrtc-track';
    const DEFAULT_VIDEO_COMPRESSION = 'balanced';

    function normalizeVideoTransportPreference(value) {
        return value === 'webrtc' || value === 'webrtc-track' || value === 'websocket'
            ? value
            : DEFAULT_VIDEO_TRANSPORT;
    }

    function normalizeVideoCompressionPreference(value) {
        return value === 'raw' || value === 'crisp' || value === 'balanced' || value === 'compact'
            ? value
            : DEFAULT_VIDEO_COMPRESSION;
    }

    function chooseVideoTransport({ rtcSupported, webrtcSessionUrl, preferredTransport }) {
        const normalizedPreference = normalizeVideoTransportPreference(preferredTransport);

        if (normalizedPreference === 'websocket') {
            return 'websocket';
        }

        if (normalizedPreference === 'webrtc' || normalizedPreference === 'webrtc-track') {
            return rtcSupported && typeof webrtcSessionUrl === 'string' && webrtcSessionUrl.length > 0
                ? normalizedPreference
                : 'websocket';
        }

        return 'websocket';
    }

    function compressionToWebSocketVideoMode(compression) {
        const normalized = normalizeVideoCompressionPreference(compression);
        return normalized === 'raw' ? 'raw' : 'jpeg';
    }

    function compressionToJpegQuality(compression) {
        switch (normalizeVideoCompressionPreference(compression)) {
            case 'crisp':
                return 82;
            case 'compact':
                return 55;
            case 'balanced':
                return 70;
            default:
                return null;
        }
    }

    return {
        calculateContainedSize,
        nextAudioEnabledState,
        nextOverlayEnabledState,
        chooseInitialGamepadIndex,
        normalizeVideoTransportPreference,
        normalizeVideoCompressionPreference,
        chooseVideoTransport,
        compressionToWebSocketVideoMode,
        compressionToJpegQuality
    };
});
