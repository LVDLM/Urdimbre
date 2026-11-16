import { EngineTheme } from '../types';

export interface ThemeConfig {
  id: EngineTheme;
  name: string;
  bgClass: string;
  cardBgClass: string;
  cardBorderClass: string;
  textMainClass: string;
  textMutedClass: string;
  accentClass: string;
  accentBgClass: string;
  accentBorderClass: string;
  hotspotClass: string;
  hotspotHoverClass: string;
  verbActiveBg: string;
  verbActiveText: string;
  responseBgClass: string;
  responseBorderClass: string;
  fontFamily: string;
  buttonBgClass: string;
  buttonBorderClass: string;
  buttonTextClass: string;
  buttonHoverClass: string;
  actionBoxBgClass: string;
  actionBoxTextClass: string;
  docContainerClass: string;
  docHeaderClass: string;
  docTitleClass: string;
  docHintClass: string;
  docBodyClass: string;
  revealHighlightClass: string;
  themeButtonClass: string;
}

export const THEME_CONFIGS: Record<EngineTheme, ThemeConfig> = {
  'classic-retro': {
    id: 'classic-retro',
    name: 'LucasArts Retro',
    bgClass: 'bg-[#0a0a0c]',
    cardBgClass: 'bg-[#0f0f12]',
    cardBorderClass: 'border-amber-500/30',
    textMainClass: 'text-amber-100',
    textMutedClass: 'text-amber-400/60',
    accentClass: 'text-amber-400',
    accentBgClass: 'bg-amber-500/20',
    accentBorderClass: 'border-amber-500',
    hotspotClass: 'bg-amber-500/20 border-b-2 border-amber-500 text-amber-300 font-mono font-bold cursor-pointer px-1.5 py-0.5 rounded-xs transition-colors',
    hotspotHoverClass: 'hover:bg-amber-500/30 hover:text-amber-100',
    verbActiveBg: 'bg-amber-500',
    verbActiveText: 'text-[#0a0a0c]',
    responseBgClass: 'bg-[#0c0c0e]',
    responseBorderClass: 'border-amber-500',
    fontFamily: 'font-mono',
    buttonBgClass: 'bg-slate-950/80',
    buttonBorderClass: 'border-slate-800',
    buttonTextClass: 'text-slate-300',
    buttonHoverClass: 'hover:border-amber-500/50 hover:text-amber-300',
    actionBoxBgClass: 'bg-amber-500/10',
    actionBoxTextClass: 'text-amber-300',
    docContainerClass: 'bg-[#171511] border border-amber-500/35 rounded-xl shadow-[inset_0_1px_0_rgba(245,158,11,0.12)] overflow-hidden transition-colors',
    docHeaderClass: 'w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-amber-500/[0.08] hover:bg-amber-500/[0.15] transition-colors cursor-pointer',
    docTitleClass: 'text-amber-300 font-mono font-bold text-sm sm:text-base tracking-wide flex items-center gap-2.5 min-w-0',
    docHintClass: 'text-[11px] font-mono uppercase tracking-wider text-amber-400/75 flex items-center gap-1.5 shrink-0',
    docBodyClass: 'px-4 sm:px-5 py-4 border-t border-amber-500/20 text-amber-50/95 space-y-3',
    revealHighlightClass: 'ring-2 ring-amber-400/60 bg-amber-500/[0.09] shadow-[0_0_22px_rgba(245,158,11,0.16)]',
    themeButtonClass: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50',
  },
  'modern-dark': {
    id: 'modern-dark',
    name: 'Oscuro Elegante',
    bgClass: 'bg-[#0a0a0c]',
    cardBgClass: 'bg-[#0f0f12]',
    cardBorderClass: 'border-white/10',
    textMainClass: 'text-slate-100',
    textMutedClass: 'text-white/40',
    accentClass: 'text-amber-400',
    accentBgClass: 'bg-amber-500/20',
    accentBorderClass: 'border-amber-500/50',
    hotspotClass: 'bg-amber-500/20 border-b-2 border-amber-500 text-amber-300 font-semibold cursor-pointer px-1.5 py-0.5 rounded-xs transition-colors shadow-sm',
    hotspotHoverClass: 'hover:bg-amber-500/35 hover:text-amber-100',
    verbActiveBg: 'bg-amber-600',
    verbActiveText: 'text-white',
    responseBgClass: 'bg-[#0c0c0e]',
    responseBorderClass: 'border-amber-500/50',
    fontFamily: 'font-sans',
    buttonBgClass: 'bg-slate-950/80',
    buttonBorderClass: 'border-slate-800',
    buttonTextClass: 'text-slate-300',
    buttonHoverClass: 'hover:border-amber-500/50 hover:text-amber-300',
    actionBoxBgClass: 'bg-amber-500/10',
    actionBoxTextClass: 'text-amber-300',
    docContainerClass: 'bg-[#171a22] border border-slate-500/35 rounded-xl shadow-md overflow-hidden transition-colors',
    docHeaderClass: 'w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-white/[0.04] hover:bg-white/[0.08] transition-colors cursor-pointer',
    docTitleClass: 'text-amber-300 font-sans font-semibold text-sm sm:text-base tracking-tight flex items-center gap-2.5 min-w-0',
    docHintClass: 'text-xs font-sans text-slate-400 flex items-center gap-1.5 shrink-0',
    docBodyClass: 'px-4 sm:px-5 py-4 border-t border-white/10 text-slate-100/95 space-y-3',
    revealHighlightClass: 'ring-2 ring-amber-400/55 bg-amber-500/[0.08] shadow-[0_0_22px_rgba(245,158,11,0.14)]',
    themeButtonClass: 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/40',
  },
  'sepia-parchment': {
    id: 'sepia-parchment',
    name: 'Pergamino Sepia',
    bgClass: 'bg-[#f5ebd7]',
    cardBgClass: 'bg-[#ebdcb9]',
    cardBorderClass: 'border-[#cbb382]',
    textMainClass: 'text-[#3b2d1d]',
    textMutedClass: 'text-[#786146]',
    accentClass: 'text-[#822b16]',
    accentBgClass: 'bg-[#822b16]/12',
    accentBorderClass: 'border-[#822b16]/40',
    hotspotClass: 'text-[#822b16] font-bold underline decoration-[#822b16]/50 underline-offset-4 cursor-pointer rounded px-1',
    hotspotHoverClass: 'hover:bg-[#822b16]/15 hover:text-[#5a1d0d]',
    verbActiveBg: 'bg-[#822b16]',
    verbActiveText: 'text-[#fbf5e8]',
    responseBgClass: 'bg-[#dfceaa]',
    responseBorderClass: 'border-[#822b16]',
    fontFamily: 'font-serif',
    buttonBgClass: 'bg-[#e4d2ad]',
    buttonBorderClass: 'border-[#c2aa79]',
    buttonTextClass: 'text-[#3b2d1d]',
    buttonHoverClass: 'hover:bg-[#dbbf92] hover:text-[#822b16] hover:border-[#822b16]',
    actionBoxBgClass: 'bg-[#e8d7b5]',
    actionBoxTextClass: 'text-[#3b2d1d]',
    docContainerClass: 'bg-[#f4e9d2] border border-[#bda26e] rounded-xl shadow-sm overflow-hidden transition-colors',
    docHeaderClass: 'w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-[#e6d3ad]/75 hover:bg-[#dec79a] transition-colors cursor-pointer',
    docTitleClass: 'text-[#6e2210] font-serif font-bold text-sm sm:text-base flex items-center gap-2.5 min-w-0',
    docHintClass: 'text-xs font-serif italic text-[#786146] flex items-center gap-1.5 shrink-0',
    docBodyClass: 'px-4 sm:px-5 py-4 border-t border-[#cbb382]/80 text-[#332516] font-serif space-y-3',
    revealHighlightClass: 'ring-2 ring-[#822b16]/45 bg-[#822b16]/[0.07] shadow-[0_0_18px_rgba(130,43,22,0.12)]',
    themeButtonClass: 'bg-[#822b16]/15 hover:bg-[#822b16]/25 text-[#822b16] border border-[#822b16]/40',
  },
  'cyber-terminal': {
    id: 'cyber-terminal',
    name: 'Terminal Cyber',
    bgClass: 'bg-black',
    cardBgClass: 'bg-emerald-950/30',
    cardBorderClass: 'border-emerald-500/40',
    textMainClass: 'text-emerald-300',
    textMutedClass: 'text-emerald-600',
    accentClass: 'text-emerald-400',
    accentBgClass: 'bg-emerald-500/20',
    accentBorderClass: 'border-emerald-500',
    hotspotClass: 'text-emerald-400 font-mono font-bold underline decoration-emerald-500/60 underline-offset-4 cursor-pointer rounded px-1',
    hotspotHoverClass: 'hover:bg-emerald-500/30 hover:text-emerald-100',
    verbActiveBg: 'bg-emerald-500',
    verbActiveText: 'text-black',
    responseBgClass: 'bg-black/90',
    responseBorderClass: 'border-emerald-400',
    fontFamily: 'font-mono',
    buttonBgClass: 'bg-black/80',
    buttonBorderClass: 'border-emerald-500/30',
    buttonTextClass: 'text-emerald-300',
    buttonHoverClass: 'hover:border-emerald-500 hover:text-emerald-100',
    actionBoxBgClass: 'bg-emerald-950/40',
    actionBoxTextClass: 'text-emerald-300',
    docContainerClass: 'bg-emerald-950/55 border border-emerald-400/45 rounded-xl shadow-[0_0_18px_rgba(16,185,129,0.08)] overflow-hidden transition-colors',
    docHeaderClass: 'w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-emerald-500/[0.12] hover:bg-emerald-500/[0.2] transition-colors cursor-pointer',
    docTitleClass: 'text-emerald-200 font-mono font-bold text-sm sm:text-base tracking-wider flex items-center gap-2.5 min-w-0',
    docHintClass: 'text-[11px] font-mono uppercase text-emerald-400/80 flex items-center gap-1.5 shrink-0',
    docBodyClass: 'px-4 sm:px-5 py-4 border-t border-emerald-500/30 text-emerald-200 font-mono space-y-3',
    revealHighlightClass: 'ring-2 ring-emerald-400/70 bg-emerald-500/[0.10] shadow-[0_0_24px_rgba(16,185,129,0.20)]',
    themeButtonClass: 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/60',
  },
  'emerald-vintage': {
    id: 'emerald-vintage',
    name: 'Esmeralda Vintage',
    bgClass: 'bg-zinc-950',
    cardBgClass: 'bg-emerald-950/20',
    cardBorderClass: 'border-emerald-800/50',
    textMainClass: 'text-emerald-100',
    textMutedClass: 'text-emerald-400/70',
    accentClass: 'text-yellow-400',
    accentBgClass: 'bg-yellow-500/10',
    accentBorderClass: 'border-yellow-500/40',
    hotspotClass: 'text-yellow-400 font-semibold underline decoration-yellow-400/50 underline-offset-4 cursor-pointer rounded px-1',
    hotspotHoverClass: 'hover:bg-yellow-500/20 hover:text-yellow-200',
    verbActiveBg: 'bg-yellow-500',
    verbActiveText: 'text-zinc-950',
    responseBgClass: 'bg-zinc-900',
    responseBorderClass: 'border-yellow-500',
    fontFamily: 'font-sans',
    buttonBgClass: 'bg-zinc-900',
    buttonBorderClass: 'border-emerald-800/40',
    buttonTextClass: 'text-emerald-200',
    buttonHoverClass: 'hover:border-yellow-500/50 hover:text-yellow-300',
    actionBoxBgClass: 'bg-emerald-950/30',
    actionBoxTextClass: 'text-yellow-300',
    docContainerClass: 'bg-[#0b1b17] border border-emerald-700/55 rounded-xl shadow-md overflow-hidden transition-colors',
    docHeaderClass: 'w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-emerald-900/35 hover:bg-emerald-900/55 transition-colors cursor-pointer',
    docTitleClass: 'text-yellow-300 font-sans font-semibold text-sm sm:text-base flex items-center gap-2.5 min-w-0',
    docHintClass: 'text-xs font-sans text-emerald-300/75 flex items-center gap-1.5 shrink-0',
    docBodyClass: 'px-4 sm:px-5 py-4 border-t border-emerald-800/50 text-emerald-50/95 space-y-3',
    revealHighlightClass: 'ring-2 ring-yellow-400/55 bg-emerald-500/[0.10] shadow-[0_0_22px_rgba(234,179,8,0.15)]',
    themeButtonClass: 'bg-emerald-900/60 hover:bg-emerald-800/70 text-yellow-300 border border-emerald-700/60',
  },
};
