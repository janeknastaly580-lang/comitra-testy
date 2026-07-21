import type { CSSProperties } from 'react';

/**
 * Six built-in futuristic / minimalist avatars rendered as inline SVG (no assets).
 * Each is a flat-colored rounded tile with a single geometric glyph.
 */
export const AVATAR_PRESETS = [
  'preset-1',
  'preset-2',
  'preset-3',
  'preset-4',
  'preset-5',
  'preset-6',
] as const;

const BG: Record<string, string> = {
  'preset-1': '#16A34A',
  'preset-2': '#0D9488',
  'preset-3': '#0891B2',
  'preset-4': '#334155',
  'preset-5': '#059669',
  'preset-6': '#B45309',
};

function Glyph({ id }: { id: string }) {
  const s = { fill: 'none', stroke: '#fff', strokeWidth: 5, strokeLinecap: 'round' as const };
  switch (id) {
    case 'preset-1': // radar rings
      return (
        <g {...s}>
          <circle cx="50" cy="50" r="9" fill="#fff" stroke="none" />
          <circle cx="50" cy="50" r="20" />
          <circle cx="50" cy="50" r="31" opacity="0.6" />
        </g>
      );
    case 'preset-2': // hexagon
      return (
        <g {...s}>
          <path d="M50 22 L74 36 L74 64 L50 78 L26 64 L26 36 Z" />
          <circle cx="50" cy="50" r="7" fill="#fff" stroke="none" />
        </g>
      );
    case 'preset-3': // ascending bars
      return (
        <g {...s} strokeWidth="7">
          <path d="M32 64 V52" />
          <path d="M50 64 V40" />
          <path d="M68 64 V30" />
        </g>
      );
    case 'preset-4': // orbit
      return (
        <g {...s}>
          <circle cx="50" cy="50" r="22" />
          <circle cx="72" cy="50" r="6" fill="#fff" stroke="none" />
        </g>
      );
    case 'preset-5': // triangle + line
      return (
        <g {...s}>
          <path d="M50 26 L72 68 L28 68 Z" />
          <path d="M40 56 H60" strokeWidth="4" />
        </g>
      );
    default: // preset-6 grid
      return (
        <g fill="#fff">
          <rect x="28" y="28" width="16" height="16" rx="3" />
          <rect x="56" y="28" width="16" height="16" rx="3" opacity="0.7" />
          <rect x="28" y="56" width="16" height="16" rx="3" opacity="0.7" />
          <rect x="56" y="56" width="16" height="16" rx="3" />
        </g>
      );
  }
}

/** Renders the preset tile as a standalone SVG (used by the picker). */
export function PresetAvatarSvg({ id, size = 56 }: { id: string; size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }}>
      <rect x="0" y="0" width="100" height="100" rx="20" fill={BG[id] ?? '#334155'} />
      <Glyph id={id} />
    </svg>
  );
}

/**
 * Universal avatar: shows an uploaded Base64 image, a preset glyph, or a
 * coloured initial fallback. `radius` keeps the design system's max 8px on small
 * sizes via inline style.
 */
export function Avatar({
  avatar,
  name,
  size = 40,
  className = '',
}: {
  avatar?: string;
  name?: string;
  size?: number;
  className?: string;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.min(8, size * 0.22),
    overflow: 'hidden',
    flexShrink: 0,
  };

  if (avatar && avatar.startsWith('data:')) {
    return (
      <img
        src={avatar}
        alt={name ?? 'avatar'}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        // If a stored image is corrupt, hide it rather than showing a broken tile.
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
        style={{ ...style, objectFit: 'cover' }}
        className={className}
      />
    );
  }

  if (avatar && AVATAR_PRESETS.includes(avatar as (typeof AVATAR_PRESETS)[number])) {
    return (
      <span style={style} className={className}>
        <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }}>
          <rect x="0" y="0" width="100" height="100" fill={BG[avatar] ?? '#334155'} />
          <Glyph id={avatar} />
        </svg>
      </span>
    );
  }

  // Fallback: first initial on an elevated tile.
  return (
    <span
      style={style}
      className={`flex items-center justify-center border border-line bg-elevated font-mono text-accent ${className}`}
    >
      <span style={{ fontSize: size * 0.42 }}>{(name ?? '?').slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
