import { motion } from 'framer-motion';

export default function FinalCta({ onLaunchDashboard, scrollToSection }) {
  const scroll = (id) => {
    if (typeof scrollToSection === 'function') scrollToSection(id);
  };

  return (
    <section className="px-4 pb-28 pt-24 md:px-8 xl:px-12">
      <div className="mx-auto max-w-[1820px] overflow-hidden rounded-[44px] border border-white/10 bg-[radial-gradient(circle_at_50%_20%,rgba(46,151,255,0.22),transparent_24%),radial-gradient(circle_at_80%_70%,rgba(35,216,255,0.16),transparent_24%),linear-gradient(180deg,rgba(9,17,28,0.92),rgba(4,9,15,0.98))] px-8 py-14 md:px-12 md:py-20">
        <div className="relative">
          <div className="pointer-events-none absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:46px_46px]" />
          <div className="relative z-10 text-center">
            <p className="text-[11px] font-mono uppercase tracking-[0.32em] text-cyan-100/52">Final call</p>
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.5 }}
              className="mx-auto mt-6 max-w-[13ch] font-display text-[clamp(3.4rem,7vw,7rem)] font-semibold uppercase leading-[0.9] tracking-[-0.08em] text-white"
            >
              Start a secure transfer in seconds.
            </motion.h2>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-white/62">
              Bring the room online, verify the direct path, and move data without leaving an archive behind.
            </p>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <button
                type="button"
                onClick={onLaunchDashboard}
                className="inline-flex items-center gap-3 rounded-full border border-cyan-300/40 bg-cyan-300/16 px-7 py-3 text-[11px] font-mono uppercase tracking-[0.22em] text-cyan-100 transition duration-200 hover:border-cyan-200/60 hover:bg-cyan-300/24"
              >
                Launch Dashboard
              </button>
              <button
                type="button"
                onClick={() => scroll('pipeline')}
                className="inline-flex items-center gap-3 rounded-full border border-white/12 bg-white/[0.04] px-7 py-3 text-[11px] font-mono uppercase tracking-[0.22em] text-white/76 transition duration-200 hover:border-white/20 hover:bg-white/[0.08]"
              >
                Try Live Demo
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
