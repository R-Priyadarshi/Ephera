import { motion } from 'framer-motion';

export default function PrinciplesMatrix({ principles, activePrinciple, onSelect }) {
  const active = principles.find((principle) => principle.key === activePrinciple) ?? principles[0];

  return (
    <section className="px-4 py-24 md:px-8 xl:px-12">
      <div className="mx-auto grid w-full max-w-[1820px] grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-cyan-100/52">Core Principles</p>
          <h2 className="mt-5 max-w-[9ch] font-display text-[clamp(2.8rem,5vw,5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.06em] text-white">
            The system is opinionated by design.
          </h2>
        </div>

        <div className="col-span-12 xl:col-span-8">
          <div className="grid gap-5 md:grid-cols-2">
            {principles.map((principle, index) => {
              const isActive = principle.key === activePrinciple;

              return (
                <motion.button
                  key={principle.key}
                  type="button"
                  onClick={() => onSelect(principle.key)}
                  whileHover={{ y: -6, scale: 1.01 }}
                  className={`group relative overflow-hidden rounded-[32px] border p-6 text-left transition duration-200 ${
                    isActive
                      ? 'border-cyan-300/28 bg-[linear-gradient(180deg,rgba(14,29,45,0.94),rgba(8,16,27,0.96))] shadow-[0_30px_80px_rgba(0,0,0,0.34)]'
                      : 'border-white/10 bg-white/[0.03] hover:border-white/18'
                  } ${index % 3 === 0 ? 'md:translate-y-10' : ''}`}
                >
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(69,215,255,0.12),transparent_24%)] opacity-0 transition duration-200 group-hover:opacity-100" />
                  <div className="relative z-10">
                    <p className="text-[10px] font-mono uppercase tracking-[0.26em] text-cyan-100/54">
                      {principle.eyebrow}
                    </p>
                    <p className="mt-5 font-display text-3xl font-semibold tracking-tight text-white">
                      {principle.title}
                    </p>
                    <p className="mt-4 text-lg leading-7 text-white/68">{principle.short}</p>
                    <div className="mt-10 flex items-center gap-3">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${isActive ? 'bg-cyan-300 shadow-[0_0_18px_rgba(69,215,255,0.7)]' : 'bg-white/20'}`}
                      />
                      <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-white/44">
                        {isActive ? 'expanded' : 'reveal'}
                      </span>
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>

        <div className="col-span-12">
          <motion.div
            key={active.key}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.36 }}
            className="rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,rgba(10,18,30,0.88),rgba(6,11,18,0.96))] px-7 py-8"
          >
            <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-cyan-100/56">
                  Expanded principle
                </p>
                <p className="mt-5 font-display text-[clamp(2.4rem,4vw,4rem)] font-semibold tracking-[-0.05em] text-white">
                  {active.title}
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-5 md:col-span-2">
                  <p className="text-sm leading-7 text-white/72">{active.detail}</p>
                </div>
                <div className="rounded-[24px] border border-cyan-300/22 bg-cyan-300/8 p-5">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">Operational effect</p>
                  <p className="mt-4 text-sm leading-7 text-white/72">
                    The product surface stays honest about what the system can and cannot do.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
