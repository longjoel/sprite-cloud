(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.GamesVaultNosebleedInput = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
    const DPAD_BUTTONS = ["up", "down", "left", "right"];
    const DEAD_ZONE = 0.34;

    function resolveDpadButtonsFromPoint(rect, clientX, clientY) {
        if (!rect || rect.width <= 0 || rect.height <= 0) return [];

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const x = (clientX - centerX) / (rect.width / 2);
        const y = (clientY - centerY) / (rect.height / 2);
        const buttons = [];

        if (y < -DEAD_ZONE) buttons.push("up");
        if (y > DEAD_ZONE) buttons.push("down");
        if (x < -DEAD_ZONE) buttons.push("left");
        if (x > DEAD_ZONE) buttons.push("right");

        return buttons;
    }

    return { DPAD_BUTTONS, resolveDpadButtonsFromPoint };
});
