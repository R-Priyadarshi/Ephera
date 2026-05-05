import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './embed.css';

function scrollToLandingSection(id) {
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openDashboard() {
  window.dispatchEvent(new CustomEvent('ephera:open-dashboard'));
}

const mount = document.getElementById('landing-react-root');

if (mount) {
  ReactDOM.createRoot(mount).render(
    <React.StrictMode>
      <App onLaunchDashboard={openDashboard} scrollToSection={scrollToLandingSection} />
    </React.StrictMode>
  );
}
