(function enableEpheraPreloader() {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const opensDashboard = params.get('dashboard') === '1'
    || params.get('view') === 'dashboard'
    || params.get('autojoin') === '1'
    || Boolean(String(params.get('roomId') || '').trim())
    || Boolean(navigator.webdriver)
    || window.__EPHERA_TEST_SKIP_PRELOADER__ === true;

  if (!opensDashboard) document.documentElement.classList.add('ephera-preloader-enabled');
}());
