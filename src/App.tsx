import React, { useState } from 'react';
import { 
  Zap, Share2, ScanLine, 
  Settings, ArrowLeftRight, Monitor, Laptop, Play
} from 'lucide-react';
import OpticalEncoder from './components/OpticalEncoder';
import OpticalDecoder from './components/OpticalDecoder';

export default function App() {
  const [activeTab, setActiveTab] = useState<'transmit' | 'receive'>('transmit');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-slate-700 selection:text-slate-100" id="app-root">
      
      {/* HEADER SECTION */}
      <header className="border-b border-slate-800 bg-slate-950/60 backdrop-blur-md sticky top-0 z-50 shrink-0" id="app-header">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4">
          
          {/* BRAND LOGO */}
          <div className="flex items-center gap-3" id="brand-logo-container">
            <div className="relative w-10 h-10 bg-slate-900 border border-slate-700 rounded-xl flex items-center justify-center text-slate-100 shadow-md">
              <Zap className="w-5 h-5 text-slate-300" />
              {/* L-pattern corner micro detail in logo */}
              <span className="absolute top-1.5 left-1.5 border-t-2 border-l-2 border-slate-400 w-2.5 h-2.5 rounded-tl-[1px]" />
            </div>
            <div>
              <h1 className="text-lg font-bold font-display tracking-tight text-slate-100 flex items-center gap-2">
                Lumisend
                <span className="text-[10px] bg-slate-900 border border-slate-700 px-2 py-0.5 rounded-full font-mono text-slate-300 font-normal">v2.1</span>
              </h1>
              <p className="text-xs text-slate-400">Air-Gapped 4:3 Visual Light Link • Custom L-Anchor Verification</p>
            </div>
          </div>

          {/* MODE / TAB NAVIGATION SELECTOR */}
          <div className="flex items-center bg-slate-900 border border-slate-800 p-1 rounded-xl" id="tab-controls">
            <button
              onClick={() => setActiveTab('transmit')}
              className={`px-4.5 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all duration-150 flex items-center gap-2 ${
                activeTab === 'transmit'
                  ? 'bg-slate-800 text-slate-100 border border-slate-700 shadow font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              id="tab-btn-transmit"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              Transmit / Sender
            </button>
            <button
              onClick={() => setActiveTab('receive')}
              className={`px-4.5 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all duration-150 flex items-center gap-2 ${
                activeTab === 'receive'
                  ? 'bg-slate-850 text-slate-100 border border-slate-700 shadow font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              id="tab-btn-receive"
            >
              <ScanLine className="w-3.5 h-3.5" />
              Receive / Scanner
            </button>
          </div>
        </div>
      </header>

      {/* CORE CONTENT LAYOUT */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full" id="main-content-layout">
        
        {/* Tab content displays below without informational overlay headers */}

        {/* PRIMARY ACTIVE VIEWS */}
        <div className="space-y-8" id="core-interactive-layer">
          {activeTab === 'transmit' && <OpticalEncoder />}
          {activeTab === 'receive' && <OpticalDecoder />}
        </div>
      </main>

      {/* GLOBAL FOOTER */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500 shrink-0 mt-12" id="app-footer">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="font-mono">Created with Google AI Studio • Secure Airgap Light Transfer</p>
          <div className="flex gap-4">
            <span className="text-slate-600 font-mono">No packets sent to server</span>
            <span className="text-slate-700 font-mono">|</span>
            <span className="text-slate-400 font-semibold font-mono">100% Client-Side Pure Binary</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
