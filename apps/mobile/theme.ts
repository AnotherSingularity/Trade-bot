export const theme = {
  colors: {
    bg: '#0A0A0F',
    surface: '#12121A',
    border: '#1E1E2E',
    green: '#00FF88',
    red: '#FF3055',
    amber: '#F5A623',
    white: '#FFFFFF',
    secondary: '#8888AA',
    muted: '#444466',
  },
  fonts: {
    mono: 'JetBrainsMono-Regular',
    monoBold: 'JetBrainsMono-Bold',
    sans: 'IBMPlexSans-Regular',
    sansMedium: 'IBMPlexSans-Medium',
    sansBold: 'IBMPlexSans-Bold',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 4,
    md: 8,
    lg: 12,
  },
} as const;

export type Theme = typeof theme;

/** Returns green for non-negative values, red for negative. */
export function pnlColor(value: number): string {
  return value >= 0 ? theme.colors.green : theme.colors.red;
}
