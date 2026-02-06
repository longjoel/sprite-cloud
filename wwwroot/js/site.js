// Please see documentation at https://learn.microsoft.com/aspnet/core/client-side/bundling-and-minification
// for details on configuring this project to bundle and minify static web assets.

// Write your JavaScript code.
(function () {
    function removeAll(selector) {
        Array.prototype.slice.call(document.querySelectorAll(selector)).forEach(function (el) { el.remove(); });
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
            cleanupStaleBackdrops();
            setInterval(cleanupStaleBackdrops, 1000);
        });
    } else {
        cleanupStaleBackdrops();
        setInterval(cleanupStaleBackdrops, 1000);
    }
})();
