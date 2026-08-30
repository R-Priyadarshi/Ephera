import { motion } from 'framer-motion';

const steps = [
  { label: 'Room', note: 'Boundary opens' },
  { label: 'Signal', note: 'Peers rendezvous' },
  { label: 'Channel', note: 'Direct lane forms' },
  { label: 'Peer', note: 'Receiver confirms' },
  { label: 'Crypto', note: 'Envelope verifies' },
  { label: 'Transfer', note: 'Payload streams' }
];

export default function SignalPipelineSection() {
  return (
    <section id="pipeline" className="landing-section landing-scroll-anchor pt-2 sm:pt-6">
      <div className="landing-container">
        <div className="landing-panel-strong overflow-hidden p-6 sm:p-7 xl:p-8">
          <div className="grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-10">
            <div className="lg:col-span-4">
              <p className="landing-kicker">System visual story</p>
              <h2 className="landing-title mt-4 max-w-[10ch]">The lane becomes legal one threshold at a time.</h2>
            </div>
            <div className="lg:col-span-8 lg:pb-2">
              <p className="landing-copy-soft max-w-[46rem]">
                Ephera never fakes progress. Each visible step maps to a transport condition the runtime has already crossed, from room creation through encrypted payload flow.
              </p>
            </div>
          </div>

          <div className="relative mt-10 hidden h-px bg-white/8 xl:block">
            <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-gradient-to-r from-cyan-300/32 via-cyan-300/12 to-transparent" />
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            {steps.map((step, index) => (
              <motion.article
                key={step.label}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ duration: 0.28, delay: index * 0.05 }}
                className="landing-panel flex min-h-[220px] flex-col px-5 py-6"
              >
                <p className="landing-kicker">Step {index + 1}</p>
                <h3 className="mt-6 text-[1.4rem] font-semibold tracking-[-0.045em] text-white">{step.label}</h3>
                <p className="mt-4 text-[0.98rem] leading-7 text-slate-300/74">{step.note}</p>
                <div className="mt-auto pt-8">
                  <motion.span
                    className="block h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(103,232,249,0.68)]"
                    animate={{ opacity: [0.34, 1, 0.34], scale: [1, 1.14, 1] }}
                    transition={{ duration: 1.8, repeat: Infinity, delay: index * 0.08 }}
                  />
                </div>
              </motion.article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
