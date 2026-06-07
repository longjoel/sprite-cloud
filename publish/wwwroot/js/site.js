// Please see documentation at https://learn.microsoft.com/aspnet/core/client-side/bundling-and-minification
// for details on configuring this project to bundle and minify static web assets.

// Write your JavaScript code.
(function () {
    var warningBannerKey = "gv.siteWarningAcknowledged";

    function removeAll(selector) {
        Array.prototype.slice.call(document.querySelectorAll(selector)).forEach(function (el) { el.remove(); });
    }

    function initializeSiteWarningBanner() {
        var banner = document.getElementById("site-warning-banner");
        if (!banner) {
            return;
        }

        var acceptButton = document.getElementById("site-warning-accept");
        var dismissButton = document.getElementById("site-warning-dismiss");
        var storage = null;

        try {
            storage = window.localStorage;
        } catch (error) {
            storage = null;
        }

        function setVisible(visible) {
            banner.hidden = !visible;
            document.body.classList.toggle("site-warning-visible", visible);
        }

        function acknowledge() {
            if (storage) {
                storage.setItem(warningBannerKey, "1");
            }

            setVisible(false);
        }

        var alreadyAcknowledged = storage && storage.getItem(warningBannerKey) === "1";
        setVisible(!alreadyAcknowledged);

        if (acceptButton) {
            acceptButton.addEventListener("click", acknowledge);
        }

        if (dismissButton) {
            dismissButton.addEventListener("click", acknowledge);
        }
    }

    function cleanupStaleBackdrops() {
        var anyModalOpen = !!document.querySelector(".modal.show");
        var anyOffcanvasOpen = !!document.querySelector(".offcanvas.show");

        // Bootstrap backdrops can sometimes get stuck (or become transparent) and block clicks.
        // If nothing is actually open, remove any remaining backdrops and unlock scrolling.
        if (!anyModalOpen) {
            removeAll(".modal-backdrop");
            if (document.body.classList.contains("modal-open")) {
                document.body.classList.remove("modal-open");
                document.body.style.overflow = "";
                document.body.style.paddingRight = "";
            }
        }

        if (!anyOffcanvasOpen) {
            removeAll(".offcanvas-backdrop");
            // Offcanvas also locks scrolling in some cases.
            if (document.body.style.overflow === "hidden") {
                document.body.style.overflow = "";
            }
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            initializeSiteWarningBanner();
            cleanupStaleBackdrops();
            setInterval(cleanupStaleBackdrops, 1000);
        });
    } else {
        initializeSiteWarningBanner();
        cleanupStaleBackdrops();
        setInterval(cleanupStaleBackdrops, 1000);
    }
})();
