import { motion } from 'framer-motion';

function ActionButton({ label, onClick, tone = 'secondary' }) {
  const toneClass =
    tone === 'primary'
      ? 'landing-button landing-button-primary'
      : tone === 'warm'
        ? 'landing-button landing-button-warm'
        : 'landing-button landing-button-secondary';

  return (
    <button type="button" onClick={onClick} className={toneClass}>
      {label}
    </button>
  );
}

export default function LandingNav({ onLaunchDashboard, scrollToSection }) {
  const scroll = (id) => {
    if (typeof scrollToSection === 'function') scrollToSection(id);
  };

  return (
    <motion.header
      className="landing-nav-shell"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32 }}
    >
      <div className="landing-container">
        <div className="landing-nav-surface px-4 py-4 sm:px-5 lg:px-6">
          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_auto] lg:items-center lg:gap-6">
            <div className="flex items-center gap-4">
              <div className="grid h-12 w-12 place-items-center overflow-hidden rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.12] shadow-[0_0_18px_rgba(103,232,249,0.08)]">
                <img src="/favicon.svg" alt="" className="h-10 w-10" />
              </div>
              <div>
                <p className="landing-kicker">Zero-memory transport</p>
                <p className="mt-1 text-[1.15rem] font-semibold tracking-[-0.04em] text-white">Ephera</p>
              </div>
            </div>

            <div className="landing-panel flex items-center gap-4 px-4 py-3 sm:px-5">
              <motion.span
                className="h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-300"
                animate={{ opacity: [0.45, 1, 0.45], scale: [1, 1.12, 1] }}
                transition={{ duration: 1.8, repeat: Infinity }}
              />
              <div className="min-w-0">
                <p className="landing-kicker">System state</p>
                <p className="mt-1 max-w-[38ch] text-sm leading-6 text-slate-200/84 sm:text-[0.95rem]">
                  Server coordinates setup only. Payloads remain on the peer lane.
                </p>
              </div>
              <div className="ml-auto hidden items-center gap-2 xl:flex">
                {Array.from({ length: 6 }).map((_, index) => (
                  <motion.span
                    key={index}
                    className="h-1.5 w-6 rounded-full bg-cyan-300/80"
                    animate={{ opacity: [0.24, 1, 0.24] }}
                    transition={{ duration: 1.7, repeat: Infinity, delay: index * 0.08 }}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 lg:justify-end">
              <ActionButton label="Explore Trust Model" onClick={() => scroll('trust')} />
              <ActionButton label="Launch Dashboard" onClick={onLaunchDashboard} tone="primary" />
              <ActionButton label="Direct P2P" onClick={() => scroll('preview')} tone="warm" />
            </div>
          </div>
        </div>
      </div>
    </motion.header>
  );
}
