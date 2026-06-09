(function () {
  'use strict';

  var form = document.querySelector('[data-arcade-game-picker-filters]');
  var resultsHost = document.getElementById('arcade-game-picker-results');
  var selectedId = document.querySelector('[data-arcade-selected-game-id]');
  var selectedName = document.querySelector('[data-arcade-selected-game-name]');
  var selectedMeta = document.querySelector('[data-arcade-selected-game-meta]');
  var labelInput = document.querySelector('[data-arcade-cabinet-display-name]');
  var submit = document.querySelector('[data-arcade-add-cabinet-submit]');
  var pageInput = document.querySelector('[data-arcade-game-picker-page]');

  if (!form || !resultsHost) return;

  var debounceTimer = null;

  function paramsFromForm() {
    return new URLSearchParams(new FormData(form));
  }

  async function loadResults(params) {
    var url = resultsHost.getAttribute('data-arcade-game-picker-results-url') || '/Arcade/GamePicker';
    try {
      var response = await fetch(url + '?' + params.toString(), { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      resultsHost.textContent = '';
      resultsHost.insertAdjacentHTML('beforeend', await response.text());
    } catch (err) {
      var warning = document.createElement('div');
      warning.className = 'alert alert-warning small mb-3';
      warning.textContent = 'Could not refresh the game picker. Try again or reload the page.';
      resultsHost.prepend(warning);
    }
  }

  function refresh(delay) {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(function () {
      if (pageInput) pageInput.value = '1';
      loadResults(paramsFromForm());
    }, delay || 0);
  }

  form.addEventListener('input', function (event) {
    if (event.target && event.target.name === 'q') refresh(250);
  });

  form.addEventListener('change', function () {
    refresh(0);
  });

  resultsHost.addEventListener('click', function (event) {
    var pageLink = event.target.closest('.arcade-game-picker-page');
    if (pageLink) {
      event.preventDefault();
      var url = new URL(pageLink.href, window.location.origin);
      if (pageInput) pageInput.value = url.searchParams.get('page') || '1';
      loadResults(url.searchParams);
      return;
    }

    var item = event.target.closest('[data-arcade-game-id]');
    if (!item) return;

    resultsHost.querySelectorAll('[data-arcade-game-id].active').forEach(function (node) {
      node.classList.remove('active');
    });
    item.classList.add('active');

    var gameId = item.getAttribute('data-arcade-game-id') || '';
    var gameName = item.getAttribute('data-arcade-game-name') || 'Selected game';
    var gameMeta = item.getAttribute('data-arcade-game-meta') || '';

    if (selectedId) selectedId.value = gameId;
    if (selectedName) selectedName.textContent = gameName;
    if (selectedMeta) selectedMeta.textContent = gameMeta;
    if (labelInput && !labelInput.value.trim()) labelInput.value = gameName;
    if (submit) submit.disabled = !gameId;
  });
})();
