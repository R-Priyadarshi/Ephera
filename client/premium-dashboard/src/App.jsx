import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import FinalCta from './components/FinalCta';
import HeroScene from './components/HeroScene';
import LandingNav from './components/LandingNav';
import PrinciplesMatrix from './components/PrinciplesMatrix';
import ProductPreview from './components/ProductPreview';
import SignalPipelineSection from './components/SignalPipelineSection';
import TrustSection from './components/TrustSection';
import ZeroMemoryArchitecture from './components/ZeroMemoryArchitecture';

const principles = [
  {
    key: 'zero-memory',
    eyebrow: '01',
    title: 'Zero Memory',
    short: 'Payloads move, then vanish.',
    detail:
      'No payload cache, no recovery archive, no server-side copy. The system is designed so transfer state expires with the session boundary.'
  },
  {
    key: 'direct-p2p',
    eyebrow: '02',
    title: 'Direct P2P',
    short: 'Signal once. Exit the payload path.',
    detail:
      'Signaling establishes rendezvous, then the transport shifts into a direct WebRTC data lane between peers with no server relay of content.'
  },
  {
    key: 'deterministic',
    eyebrow: '03',
    title: 'Deterministic Transfer',
    short: 'Room, channel, peer, crypto, send.',
    detail:
      'Each stage is explicit and inspectable. Transfer can only arm when every boundary condition passes, making the system operationally legible.'
  },
  {
    key: 'abort-safe',
    eyebrow: '04',
    title: 'Abort-safe',
    short: 'Failure closes cleanly.',
    detail:
      'Abort is terminal and isolated. Partial completion is never mislabeled as success, and teardown keeps the runtime bounded and predictable.'
  }
];

export default function App({ onLaunchDashboard, scrollToSection }) {
  const [activePrinciple, setActivePrinciple] = useState('zero-memory');
  const scroll = useMemo(() => {
    return typeof scrollToSection === 'function'
      ? scrollToSection
      : (id) => {
          const target = document.getElementById(id);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
  }, [scrollToSection]);
  const launchDashboard = useMemo(() => {
    return typeof onLaunchDashboard === 'function'
      ? onLaunchDashboard
      : () => scroll('preview');
  }, [onLaunchDashboard, scroll]);

  return (
    <div className="ephera-premium-landing relative min-h-screen overflow-x-hidden bg-[#040913] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_12%_10%,rgba(44,112,255,0.26),transparent_24%),radial-gradient(circle_at_84%_14%,rgba(35,216,255,0.18),transparent_22%),radial-gradient(circle_at_50%_70%,rgba(64,255,196,0.08),transparent_32%)]" />
      <div className="landing-grid pointer-events-none fixed inset-0 opacity-[0.22]" />
      <div className="landing-noise pointer-events-none fixed inset-0" />
      <div className="pointer-events-none fixed inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(3,7,14,0.94),rgba(3,7,14,0.24),transparent)]" />

      <LandingNav onLaunchDashboard={launchDashboard} scrollToSection={scroll} />

      <HeroScene onLaunchDashboard={launchDashboard} scrollToSection={scroll} />

      <main className="relative z-10">
        <SignalPipelineSection />
        <ZeroMemoryArchitecture />
        <ProductPreview />
        <PrinciplesMatrix
          activePrinciple={activePrinciple}
          principles={principles}
          onSelect={setActivePrinciple}
        />
        <TrustSection />
        <FinalCta onLaunchDashboard={launchDashboard} scrollToSection={scroll} />
      </main>

      <motion.div
        aria-hidden="true"
        className="pointer-events-none fixed bottom-6 right-6 h-20 w-20 rounded-full border border-cyan-300/20 bg-cyan-300/5 blur-2xl"
        animate={{ scale: [1, 1.12, 1], opacity: [0.35, 0.65, 0.35] }}
        transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}
