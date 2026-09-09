import { motion } from 'framer-motion';

const previewStates = [
  ['Room', 'Ready'],
  ['Channel', 'Direct'],
  ['Peer', 'Confirmed'],
  ['Crypto', 'Verified'],
  ['Transfer', 'Streaming']
];

const previewStats = [
  ['Retention', '0 bytes'],
  ['Route', 'Direct P2P'],
  ['Envelope', 'AES-GCM'],
  ['Abort', 'Terminal']
];

const traceBars = [34, 42, 38, 50, 48, 60, 58, 68, 66, 76];

function PreviewMap() {
  const nodes = [
    { label: 'Sender', tone: 'bg-cyan-300', x: '18%', y: '72%' },
    { label: 'Signal', tone: 'bg-amber-300', x: '46%', y: '44%' },
    { label: 'Peer', tone: 'bg-emerald-300', x: '60%', y: '60%' },
    { label: 'Crypto', tone: 'bg-indigo-300', x: '78%', y: '30%' },
    { label: 'Receiver', tone: 'bg-sky-300', x: '88%', y: '68%' }
  ];

  return (
    <div className="relative overflow-hidden rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,15,25,0.98),rgba(6,11,19,1))] p-5 sm:p-6">
      <div className="landing-grid-overlay absolute inset-0 opacity-[0.08]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_34%,rgba(22,89,191,0.24),transparent_24%)]" />
      <div className="relative min-h-[320px] sm:min-h-[400px]">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
          <line x1="176" y1="454" x2="438" y2="490" stroke="rgba(92,216,255,0.42)" strokeWidth="2" />
          <line x1="440" y1="288" x2="618" y2="226" stroke="rgba(189,231,255,0.36)" strokeWidth="2" />
          <line x1="620" y1="390" x2="838" y2="454" stroke="rgba(103,239,196,0.34)" strokeWidth="2" />
        </svg>
        {nodes.map((node, index) => (
          <motion.div
            key={node.label}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
            style={{ left: node.x, top: node.y }}
            animate={{ opacity: [0.55, 1, 0.55], scale: [1, 1.08, 1] }}
            transition={{ duration: 2.8, repeat: Infinity, delay: index * 0.11 }}
          >
            <div className={`h-4 w-4 rounded-full ${node.tone} shadow-[0_0_18px_rgba(79,214,255,0.24)]`} />
            <span className="landing-node-label hidden lg:block">{node.label}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export default function ProductPreview() {
  return (
    <section id="preview" className="landing-section landing-scroll-anchor">
      <div className="landing-container">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-4">
            <p className="landing-kicker">Live product preview</p>
            <h2 className="landing-title mt-4 max-w-[10ch]">The transfer surface should feel alive, not simulated.</h2>
            <p className="landing-copy-soft mt-6 max-w-[25rem]">
              This is an operational cockpit built around the direct path itself. Connection, verification, and payload movement sit inside one readable surface.
            </p>
          </div>

          <div className="lg:col-span-8">
            <div className="landing-panel-strong overflow-hidden p-5 sm:p-6 xl:p-7">
              <div className="landing-panel flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div>
                  <p className="landing-kicker">Ephera live cockpit</p>
                  <p className="mt-1 text-lg font-semibold tracking-[-0.03em] text-white">Transfer boundary online</p>
                </div>

                <div className="landing-status-pill">
                  <motion.span
                    className="h-2.5 w-2.5 rounded-full bg-emerald-300"
                    animate={{ opacity: [0.42, 1, 0.42], scale: [1, 1.14, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                  <span className="landing-kicker text-cyan-100/74">Direct path verified</span>
                </div>

                <div className="flex flex-wrap items-center gap-3" aria-label="Dashboard preview sections">
                  {['Session', 'Transfer', 'Security'].map((tab) => (
                    <span key={tab} className="landing-chip px-4 py-3">
                      {tab}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <PreviewMap />

                <div className="grid gap-5">
                  <div className="landing-panel px-5 py-5 sm:px-6">
                    <div className="flex items-center justify-between gap-3">
                      <p className="landing-kicker">Transfer flow</p>
                      <p className="landing-kicker text-cyan-100/72">Arming sequence</p>
                    </div>
                    <div className="mt-5 grid gap-3">
                      {previewStates.map(([label, value], index) => (
                        <motion.div
                          key={label}
                          className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 rounded-[18px] border border-white/10 bg-[#0a1522] px-4 py-3"
                          animate={{ borderColor: ['rgba(255,255,255,0.08)', 'rgba(99,220,255,0.16)', 'rgba(255,255,255,0.08)'] }}
                          transition={{ duration: 2.4, repeat: Infinity, delay: index * 0.08 }}
                        >
                          <span className="landing-kicker text-slate-400">{label}</span>
                          <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                            <motion.div
                              className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300"
                              initial={{ width: '18%' }}
                              whileInView={{ width: '100%' }}
                              viewport={{ once: true }}
                              transition={{ duration: 0.55, delay: index * 0.05 }}
                            />
                          </div>
                          <span className="landing-kicker text-cyan-100/74">{value}</span>
                        </motion.div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    {previewStats.map(([label, value]) => (
                      <div key={label} className="landing-panel px-5 py-5">
                        <p className="landing-kicker">{label}</p>
                        <p className="mt-4 text-[1.18rem] font-semibold tracking-[-0.04em] text-white sm:text-[1.34rem]">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="landing-panel mt-5 px-5 py-5 sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <p className="landing-kicker">Bandwidth trace</p>
                  <p className="landing-kicker text-slate-300/62">Live</p>
                </div>
                <div className="mt-5 flex h-20 items-end gap-2 rounded-[18px] border border-white/8 bg-[#09131e] px-4 py-4">
                  {traceBars.map((height, index) => (
                    <motion.span
                      key={`${height}-${index}`}
                      className="flex-1 rounded-t-full bg-gradient-to-t from-cyan-500/46 to-emerald-300/82"
                      style={{ height: `${height}%` }}
                      animate={{ opacity: [0.34, 1, 0.42], scaleY: [0.96, 1, 0.98] }}
                      transition={{ duration: 1.4, repeat: Infinity, delay: index * 0.05 }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
