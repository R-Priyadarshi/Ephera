(function startEpheraPreloader() {
  'use strict';

  const root = document.documentElement;
  const preloader = document.getElementById('ephera-preloader');
  const app = document.querySelector('main.app');

  if (!preloader || !root.classList.contains('ephera-preloader-enabled')) {
    if (preloader) preloader.hidden = true;
    return;
  }

  const status = document.getElementById('ephera-preloader-status');
  const skip = document.getElementById('ephera-preloader-skip');
  const enter = document.getElementById('ephera-preloader-enter');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const startedAt = performance.now();
  const minimumDuration = reducedMotion ? 180 : 2350;
  const maximumWait = reducedMotion ? 1200 : 5500;
  let isDismissing = false;
  let isReady = false;
  let entryRequested = false;
  let statusTimers = [];

  if (app) {
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function waitForWindowLoad() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  function waitForLandingHero() {
    if (document.querySelector('#hero h1')) return Promise.resolve();
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('#hero h1')) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function waitForFonts() {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return document.fonts.ready.catch(() => {});
  }

  function clearStatusTimers() {
    for (const timer of statusTimers) window.clearTimeout(timer);
    statusTimers = [];
  }

  function finishDismissal() {
    preloader.hidden = true;
    root.classList.remove('ephera-preloader-enabled', 'ephera-preloader-revealing');
    if (app) {
      app.inert = false;
      app.removeAttribute('aria-hidden');
    }
    window.dispatchEvent(new CustomEvent('ephera:preloader-complete'));
  }

  function dismiss({ immediate = false } = {}) {
    if (isDismissing) return;
    isDismissing = true;
    clearStatusTimers();
    if (status) status.textContent = 'Direct path ready';
    root.classList.add('ephera-preloader-revealing');
    preloader.classList.add('is-exiting');

    if (immediate || reducedMotion) {
      window.setTimeout(finishDismissal, reducedMotion ? 120 : 40);
      return;
    }

    const fallback = window.setTimeout(finishDismissal, 1100);
    preloader.addEventListener('transitionend', (event) => {
      if (event.target !== preloader) return;
      window.clearTimeout(fallback);
      finishDismissal();
    }, { once: true });
  }

  function requestEntry() {
    if (isDismissing) return;
    entryRequested = true;
    if (isReady) {
      dismiss({ immediate: false });
    } else if (status) {
      status.textContent = 'Preparing landing surface';
    }
  }

  if (enter) enter.addEventListener('click', requestEntry);
  if (skip) skip.addEventListener('click', requestEntry);

  if (!reducedMotion && status) {
    statusTimers = [
      window.setTimeout(() => { status.textContent = 'Opening ephemeral boundary'; }, 700),
      window.setTimeout(() => { status.textContent = 'Verifying peer lane'; }, 1450),
      window.setTimeout(() => {
        if (!entryRequested) status.textContent = 'Click the logo to enter';
      }, 2050),
    ];
  }

  const ready = Promise.all([waitForWindowLoad(), waitForLandingHero(), waitForFonts()]);
  Promise.race([ready, delay(maximumWait)])
    .then(() => delay(Math.max(0, minimumDuration - (performance.now() - startedAt))))
    .then(() => {
      isReady = true;
      preloader.classList.add('is-ready');
      if (entryRequested) {
        dismiss({ immediate: false });
      } else if (status) {
        status.textContent = 'Click the logo to enter';
      }
    })
    .catch(() => {
      isReady = true;
      preloader.classList.add('is-ready');
      if (entryRequested) dismiss({ immediate: false });
    });
}());
