const opacityScale = Object.fromEntries(
  Array.from({ length: 101 }, (_, index) => [String(index), String(index / 100)])
);

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      opacity: opacityScale,
      fontFamily: {
        display: ['"Sora"', '"Avenir Next"', '"Segoe UI"', 'sans-serif'],
        body: ['"Plus Jakarta Sans"', '"Avenir Next"', '"Segoe UI"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'monospace']
      },
      colors: {
        ephera: {
          base: '#061321',
          panel: '#0b1c2d',
          panelSoft: '#0f2539',
          cyan: '#45d7ff',
          blue: '#2f8bff',
          mint: '#59f3c8',
          warm: '#f8a06b'
        }
      },
      boxShadow: {
        halo: '0 0 0 1px rgba(69, 215, 255, 0.28), 0 18px 42px rgba(4, 18, 34, 0.58)',
        panel: '0 14px 34px rgba(2, 12, 24, 0.45)',
        insetGlow: 'inset 0 1px 0 rgba(255,255,255,0.08)'
      },
      backgroundImage: {
        dashboardGlow:
          'radial-gradient(900px 420px at 8% -2%, rgba(47,139,255,0.24), transparent 68%), radial-gradient(680px 420px at 94% 8%, rgba(69,215,255,0.18), transparent 70%), radial-gradient(680px 680px at 50% 108%, rgba(89,243,200,0.12), transparent 74%)'
      }
    }
  },
  plugins: []
};
