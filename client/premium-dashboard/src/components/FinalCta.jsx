export default function FinalCta({ onLaunchDashboard, scrollToSection }) {
  const currentYear = new Date().getFullYear();

  const scroll = (id) => {
    if (typeof scrollToSection === 'function') scrollToSection(id);
  };

  return (
    <section className="landing-section pt-14">
      <div className="landing-container">
        <div className="landing-panel-strong relative overflow-hidden px-6 py-16 sm:px-10 sm:py-20 lg:px-14">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(14,122,120,0.12),transparent_24%)]" />
          <div className="landing-grid-overlay absolute inset-0 opacity-[0.05]" />

          <div className="relative mx-auto max-w-4xl text-center">
            <p className="landing-kicker">Final call</p>
            <h2 className="mt-5 text-[clamp(2.8rem,5vw,5rem)] font-semibold leading-[0.95] tracking-[-0.07em] text-white">
              Start a secure transfer in seconds.
            </h2>
            <p className="landing-copy-soft mx-auto mt-6 max-w-2xl text-center">
              Bring the room online, verify the direct path, and move data without leaving a replayable trail behind.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <button type="button" onClick={onLaunchDashboard} className="landing-button landing-button-primary">
                Launch Dashboard
              </button>
              <button type="button" onClick={() => scroll('preview')} className="landing-button landing-button-secondary">
                Try Live Demo
              </button>
            </div>
          </div>
        </div>

        <footer className="landing-footer mt-8 flex flex-col gap-2 border-t border-white/10 pt-6 text-center font-mono text-[0.68rem] uppercase tracking-[0.16em] text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:text-left">
          <p>Engineered by R. Priyadarshi</p>
          <p>Ephera &copy; {currentYear} All rights reserved.</p>
        </footer>
      </div>
    </section>
  );
}
