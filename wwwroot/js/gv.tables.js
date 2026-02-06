// Shared helpers for "grid" tables (bulk select, select-all, form id injection).
// Exposed as `window.GVTables`.
(function () {
    function toArray(list) { return Array.prototype.slice.call(list || []); }

    function distinctInts(values) {
        var set = new Set();
        values.forEach(function (v) {
            var n = typeof v === "number" ? v : parseInt(String(v), 10);
            if (Number.isFinite(n) && n > 0) set.add(n);
        });
        return Array.from(set.values());
    }

    function collectCheckedIds(root, itemSelector) {
        root = root || document;
        return distinctInts(
            toArray(root.querySelectorAll(itemSelector))
                .filter(function (c) { return !!c.checked; })
                .map(function (c) { return c.value; })
        );
    }

    function setHiddenIds(form, ids, inputName) {
        if (!form) return;
        inputName = inputName || "ids";
        toArray(form.querySelectorAll("input[name='" + inputName + "']")).forEach(function (n) { n.remove(); });
        ids.forEach(function (id) {
            var input = document.createElement("input");
            input.type = "hidden";
            input.name = inputName;
            input.value = String(id);
            form.appendChild(input);
        });
    }

    function updateSelectAll(selectAllEl, items) {
        if (!selectAllEl) return;
        if (!items || items.length === 0) {
            selectAllEl.checked = false;
            return;
        }
        var checked = items.filter(function (c) { return !!c.checked; }).length;
        selectAllEl.checked = checked > 0 && checked === items.length;
    }

    function wireSelectAll(root, selectAllEl, itemSelector, onAfter) {
        root = root || document;
        if (!selectAllEl) return;
        selectAllEl.addEventListener("change", function () {
            var items = toArray(root.querySelectorAll(itemSelector));
            items.forEach(function (c) { c.checked = selectAllEl.checked; });
            if (onAfter) onAfter();
        });
    }

    function wireSelectionUi(opts) {
        // opts:
        // - root (required)
        // - itemSelector (required)
        // - selectAllSelector (optional)
        // - countElSelector (optional)
        // - buttons: [{ selector, enabledWhen: fn(ids) }]
        root = opts.root || document;
        var itemSelector = opts.itemSelector;
        var items = toArray(root.querySelectorAll(itemSelector));
        var selectAllEl = opts.selectAllSelector ? root.querySelector(opts.selectAllSelector) : null;
        var countEl = opts.countElSelector ? root.querySelector(opts.countElSelector) : null;
        var buttons = (opts.buttons || []).map(function (b) { return { el: root.querySelector(b.selector), enabledWhen: b.enabledWhen }; });

        function update() {
            items = toArray(root.querySelectorAll(itemSelector));
            var ids = distinctInts(items.filter(function (c) { return !!c.checked; }).map(function (c) { return c.value; }));
            if (countEl) countEl.textContent = ids.length === 0 ? "" : (ids.length + " selected");
            updateSelectAll(selectAllEl, items);
            buttons.forEach(function (b) {
                if (!b.el) return;
                b.el.disabled = !b.enabledWhen(ids);
            });
            return ids;
        }

        if (selectAllEl) {
            wireSelectAll(root, selectAllEl, itemSelector, update);
        }

        items.forEach(function (c) { c.addEventListener("change", update); });
        update();

        return { update: update };
    }

    window.GVTables = {
        collectCheckedIds: collectCheckedIds,
        setHiddenIds: setHiddenIds,
        wireSelectionUi: wireSelectionUi,
        distinctInts: distinctInts
    };
})();

