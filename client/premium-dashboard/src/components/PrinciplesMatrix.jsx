import { motion } from 'framer-motion';

export default function PrinciplesMatrix({ principles, activePrinciple, onSelect }) {
  const active = principles.find((principle) => principle.key === activePrinciple) ?? principles[0];

  return (
    <section id="principles" className="landing-section landing-scroll-anchor">
      <div className="landing-container">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-4">
            <p className="landing-kicker">Core principles</p>
            <h2 className="landing-title mt-4 max-w-[10ch]">The system is opinionated by design.</h2>
            <p className="landing-copy-soft mt-6 max-w-[25rem]">
              Ephera exposes the hard rules directly. The interface never pretends a storage workflow exists behind a peer lane.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2 lg:col-span-8">
            {principles.map((principle, index) => {
              const isActive = principle.key === activePrinciple;

              return (
                <motion.button
                  key={principle.key}
                  type="button"
                  onClick={() => onSelect(principle.key)}
                  whileHover={{ y: -2 }}
                  className={`landing-panel min-h-[220px] px-6 py-7 text-left transition duration-200 sm:px-7 ${
                    isActive ? 'border-cyan-300/22 bg-cyan-300/[0.05] shadow-[0_0_0_1px_rgba(95,217,255,0.08)]' : 'hover:border-white/18'
                  }`}
                >
                  <p className="landing-kicker">{String(index + 1).padStart(2, '0')}</p>
                  <h3 className="mt-7 text-[1.55rem] font-semibold tracking-[-0.045em] text-white sm:text-[1.9rem]">{principle.title}</h3>
                  <p className="mt-5 max-w-[24rem] text-[1rem] leading-8 text-slate-300/76">{principle.short}</p>
                  <div className="mt-10 flex items-center gap-3">
                    <span className={`h-2.5 w-2.5 rounded-full ${isActive ? 'bg-cyan-300 shadow-[0_0_14px_rgba(79,214,255,0.68)]' : 'bg-white/18'}`} />
                    <span className="landing-kicker text-slate-400">{isActive ? 'Expanded' : 'Reveal'}</span>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>

        <motion.div
          key={active.key}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24 }}
          className="mt-6 grid gap-5 lg:grid-cols-12"
        >
          <div className="landing-panel-strong px-6 py-8 sm:px-7 lg:col-span-4">
            <p className="landing-kicker">Expanded principle</p>
            <h3 className="mt-5 text-[clamp(2rem,2.7vw,2.8rem)] font-semibold leading-[1.02] tracking-[-0.055em] text-white">
              {active.title}
            </h3>
          </div>

          <div className="grid gap-5 lg:col-span-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <div className="landing-panel px-6 py-7 sm:px-7">
              <p className="text-base leading-8 text-slate-300/84">{active.detail}</p>
            </div>
            <div className="landing-panel px-6 py-7 sm:px-7">
              <p className="landing-kicker">Operational effect</p>
              <p className="mt-5 text-base leading-8 text-slate-300/82">{active.impact}</p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
